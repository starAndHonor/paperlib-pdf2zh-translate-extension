import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PLAPI } from "paperlib-api/api";

export interface TranslateOptions {
  langIn: string;
  langOut: string;
  service: string;
  noMono: boolean;
  noDual: boolean;
  apiBaseUrl: string;
  apiKey: string;
  modelName: string;
}

export interface TranslateResult {
  monoPath: string | null;
  dualPath: string | null;
  stdout: string;
  stderr: string;
}

export type ProgressCallback = (percent: number, stage: string) => void;

/**
 * Python wrapper script that uses pdf2zh_next's do_translate_async_stream API
 * to produce structured JSON progress events (one per line) on stderr.
 *
 * This bypasses Rich's terminal-dependent progress bars entirely and provides
 * reliable progress reporting in any environment (including Electron sandboxes).
 */
const PROGRESS_WRAPPER_PY = `
import sys
import json
import asyncio
import logging

# Suppress noisy loggers before importing pdf2zh_next
logging.basicConfig(level=logging.WARNING)
for _name in ("httpx", "openai", "httpcore", "http11", "pdfminer", "peewee"):
    _l = logging.getLogger(_name)
    _l.setLevel(logging.CRITICAL)
    _l.propagate = False

from pdf2zh_next.config import ConfigManager
from pdf2zh_next.high_level import do_translate_async_stream

def _emit(obj):
    print(json.dumps(obj, ensure_ascii=False), file=sys.stderr, flush=True)

def _path(obj, attr):
    v = getattr(obj, attr, None)
    return str(v) if v else None

async def main():
    try:
        settings = ConfigManager().initialize_config()
    except SystemExit as e:
        sys.exit(e.code if e.code is not None else 0)

    input_files = list(settings.basic.input_files)
    if not input_files:
        _emit({"type": "error", "error": "No input file specified"})
        sys.exit(1)

    pdf_path = str(input_files[0])
    settings.basic.input_files = set()

    try:
        async for event in do_translate_async_stream(settings, pdf_path):
            etype = event.get("type")

            if etype == "finish":
                r = event.get("translate_result")
                _emit({
                    "type": "finish",
                    "mono_pdf_path": _path(r, "mono_pdf_path"),
                    "dual_pdf_path": _path(r, "dual_pdf_path"),
                    "total_seconds": getattr(r, "total_seconds", 0),
                })
                return
            elif etype == "error":
                _emit({
                    "type": "error",
                    "error": event.get("error", "Unknown error"),
                })
                sys.exit(1)
            elif etype in ("progress_start", "progress_update", "progress_end"):
                _emit({
                    "type": etype,
                    "stage": event.get("stage", ""),
                    "overall_progress": round(event.get("overall_progress", 0), 1),
                    "stage_current": event.get("stage_current", 0),
                    "stage_total": event.get("stage_total", 0),
                    "part_index": event.get("part_index", 0),
                    "total_parts": event.get("total_parts", 1),
                })
    except Exception as e:
        _emit({"type": "error", "error": str(e)})
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
`;

export class Pdf2zhClient {
  private binaryPath: string;

  constructor(binaryPath?: string) {
    this.binaryPath = binaryPath || "pdf2zh";
  }

  setBinaryPath(p: string): void {
    this.binaryPath = p || "pdf2zh";
  }

  /**
   * Check if pdf2zh CLI is available.
   */
  async checkAvailable(): Promise<boolean> {
    const { execFile } = require("child_process");
    return new Promise((resolve) => {
      execFile(this.binaryPath, ["--version"], { timeout: 5000 }, (err: any) => {
        resolve(!err);
      });
    });
  }

  /**
   * Run pdf2zh translation with real-time progress via Python wrapper.
   *
   * Strategy:
   * 1. Try the Python wrapper (uses do_translate_async_stream for structured progress)
   * 2. Fall back to `script -qc` CLI spawn if Python env not found
   */
  async translate(
    filePath: string,
    options: TranslateOptions,
    outputDir: string,
    timeoutMinutes: number,
    onProgress?: ProgressCallback
  ): Promise<TranslateResult> {
    fs.mkdirSync(outputDir, { recursive: true });

    const pythonPath = this.findPythonInterpreter();
    if (pythonPath) {
      return this.translateViaWrapper(pythonPath, filePath, options, outputDir, timeoutMinutes, onProgress);
    }

    // Fallback: spawn pdf2zh CLI directly
    return this.translateViaCLI(filePath, options, outputDir, timeoutMinutes, onProgress);
  }

  /**
   * Primary path: use Python wrapper with do_translate_async_stream API.
   * Outputs one JSON event per line on stderr for reliable progress parsing.
   */
  private async translateViaWrapper(
    pythonPath: string,
    filePath: string,
    options: TranslateOptions,
    outputDir: string,
    timeoutMinutes: number,
    onProgress?: ProgressCallback
  ): Promise<TranslateResult> {
    const wrapperPath = this.ensureWrapperScript();
    const args = this.buildArgs(filePath, options, outputDir);
    const timeout = timeoutMinutes * 60 * 1000;

    PLAPI.logService.info(
      "[pdf2zh] Using Python wrapper",
      `python=${pythonPath}, wrapper=${wrapperPath}`,
      false,
      "pdf2zh"
    );

    return new Promise((resolve, reject) => {
      let killed = false;

      const child = spawn(pythonPath, [wrapperPath, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });

      let stdout = "";
      let stderr = "";
      let stderrBuffer = "";
      let monoPath: string | null = null;
      let dualPath: string | null = null;
      let resolved = false;

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        stderrBuffer += chunk;

        // Parse complete JSON lines from stderr
        const lines = stderrBuffer.split("\n");
        stderrBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const event = JSON.parse(trimmed);
            const etype = event.type;

            if ((etype === "progress_update" || etype === "progress_start" || etype === "progress_end") && onProgress) {
              const percent = Math.min(Math.round(event.overall_progress ?? 0), 100);
              const stage = event.stage
                ? `${event.stage} ${event.stage_current ?? ""}/${event.stage_total ?? ""}`
                : "";
              onProgress(percent, stage);
            } else if (etype === "finish") {
              monoPath = event.mono_pdf_path || null;
              dualPath = event.dual_pdf_path || null;
              resolved = true;
            } else if (etype === "error") {
              PLAPI.logService.error(
                "[pdf2zh] wrapper error",
                event.error || "Unknown",
                false,
                "pdf2zh"
              );
            }
          } catch {
            // Not a JSON line — skip (normal pdf2zh log output)
          }
        }
      });

      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGTERM");
        reject(new Error(`pdf2zh timed out after ${timeoutMinutes} minutes`));
      }, timeout);

      child.on("close", (code) => {
        clearTimeout(timer);
        if (killed) return;

        if (code !== 0 && !resolved) {
          reject(new Error(`pdf2zh exited with code ${code}\n${stderr}`));
          return;
        }

        // If wrapper reported finish, use those paths; otherwise scan output dir
        if (!monoPath && !dualPath) {
          const found = this.findOutputFiles(filePath, outputDir);
          monoPath = found.monoPath;
          dualPath = found.dualPath;
        }

        resolve({ monoPath, dualPath, stdout, stderr });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`pdf2zh wrapper failed to start: ${err.message}`));
      });
    });
  }

  /**
   * Fallback: spawn pdf2zh CLI via `script -qc` for PTY-based Rich progress.
   * Used when the Python interpreter cannot be located.
   */
  private async translateViaCLI(
    filePath: string,
    options: TranslateOptions,
    outputDir: string,
    timeoutMinutes: number,
    onProgress?: ProgressCallback
  ): Promise<TranslateResult> {
    const args = this.buildArgs(filePath, options, outputDir);

    PLAPI.logService.info(
      "[pdf2zh] Using CLI fallback (script -qc)",
      this.binaryPath,
      false,
      "pdf2zh"
    );

    return new Promise((resolve, reject) => {
      const timeout = timeoutMinutes * 60 * 1000;
      let killed = false;

      const child = spawn("script", ["-qc", [this.binaryPath, ...args].join(" "), "/dev/null"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;

        if (onProgress) {
          const parsed = this.parseRichProgress(chunk);
          if (parsed !== null) {
            onProgress(parsed.percent, parsed.stage);
          }
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGTERM");
        reject(new Error(`pdf2zh timed out after ${timeoutMinutes} minutes`));
      }, timeout);

      child.on("close", (code) => {
        clearTimeout(timer);
        if (killed) return;

        if (code !== 0) {
          reject(new Error(`pdf2zh exited with code ${code}\n${stderr}`));
          return;
        }

        const result = this.findOutputFiles(filePath, outputDir);
        resolve({ ...result, stdout, stderr });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`pdf2zh failed to start: ${err.message}`));
      });
    });
  }

  /**
   * Find the Python interpreter used by the pdf2zh binary.
   * pdf2zh_next is installed via uv, so the Python is in the same bin/ directory.
   */
  private findPythonInterpreter(): string | null {
    try {
      // Resolve symlinks to get the real binary path
      const realPath = fs.realpathSync(this.binaryPath);
      const binDir = path.dirname(realPath);

      // uv installs python alongside the entry point script
      const candidates = ["python3.12", "python3", "python"];
      for (const name of candidates) {
        const p = path.join(binDir, name);
        if (fs.existsSync(p)) {
          return p;
        }
      }

      // Fallback: read shebang from the pdf2zh script
      const content = fs.readFileSync(realPath, "utf8");
      const firstLine = content.split("\n")[0];
      if (firstLine.startsWith("#!")) {
        const interpreter = firstLine.substring(2).trim();
        if (fs.existsSync(interpreter)) {
          return interpreter;
        }
      }
    } catch {
      // Ignore
    }
    return null;
  }

  /**
   * Write the Python wrapper script to a temp location.
   * Always rewrites to ensure it matches the current extension version.
   */
  private ensureWrapperScript(): string {
    const wrapperDir = path.join(os.tmpdir(), "paperlib-pdf2zh");
    fs.mkdirSync(wrapperDir, { recursive: true });
    const wrapperPath = path.join(wrapperDir, "pdf2zh_progress_wrapper.py");
    fs.writeFileSync(wrapperPath, PROGRESS_WRAPPER_PY, "utf8");
    return wrapperPath;
  }

  /**
   * Parse Rich/tqdm progress from stdout (used by CLI fallback only).
   */
  private parseRichProgress(chunk: string): { percent: number; stage: string } | null {
    const clean = chunk.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    const parts = clean.split(/[\r\n]/);

    let percent: number | null = null;
    let stage = "";

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      const translateMatch = trimmed.match(/translate\s+.*?(\d+)\/100\b/);
      if (translateMatch) {
        percent = Math.min(parseInt(translateMatch[1], 10), 100);
      }

      const stageMatch = trimmed.match(/([\w_]+)\s*\((\d+)\/(\d+)\)/);
      if (stageMatch && stageMatch[1] !== "translate") {
        stage = `${stageMatch[1]} ${stageMatch[2]}/${stageMatch[3]}`;
      }

      const tqdmMatch = trimmed.match(/(\d+)%\|.*?(\d+)\/(\d+)/);
      if (tqdmMatch && percent === null) {
        percent = Math.min(parseInt(tqdmMatch[1], 10), 100);
        const stageInfo = trimmed.match(/\((\d+)\/(\d+)\)/);
        if (stageInfo) {
          stage = `${stageInfo[1]}/${stageInfo[2]}`;
        }
      }
    }

    if (percent !== null) {
      return { percent, stage };
    }

    return null;
  }

  /**
   * Build CLI arguments from translation options.
   */
  private buildArgs(filePath: string, options: TranslateOptions, outputDir: string): string[] {
    const args: string[] = [];

    const serviceFlag = this.getServiceFlag(options.service);
    if (serviceFlag) {
      args.push(serviceFlag);
    }

    if (options.langIn) {
      args.push("--lang-in", options.langIn);
    }
    if (options.langOut) {
      args.push("--lang-out", options.langOut);
    }

    args.push("--output", outputDir);

    if (options.noMono) {
      args.push("--no-mono");
    }
    if (options.noDual) {
      args.push("--no-dual");
    }

    const serviceFlags = this.getServiceConfigFlags(options.service);
    if (options.modelName && serviceFlags.model) {
      args.push(serviceFlags.model, options.modelName);
    }
    if (options.apiBaseUrl && serviceFlags.baseUrl) {
      args.push(serviceFlags.baseUrl, options.apiBaseUrl);
    }
    if (options.apiKey && serviceFlags.apiKey) {
      args.push(serviceFlags.apiKey, options.apiKey);
    }

    // Input file (must be last)
    args.push(filePath);

    return args;
  }

  private getServiceConfigFlags(service: string): {
    model: string | null;
    baseUrl: string | null;
    apiKey: string | null;
  } {
    const flagMap: Record<string, { model: string | null; baseUrl: string | null; apiKey: string | null }> = {
      openai: {
        model: "--openai-model",
        baseUrl: "--openai-base-url",
        apiKey: "--openai-api-key",
      },
      deepseek: {
        model: "--deepseek-model",
        baseUrl: null,
        apiKey: "--deepseek-api-key",
      },
      ollama: {
        model: "--ollama-model",
        baseUrl: "--ollama-host",
        apiKey: null,
      },
      siliconflow: {
        model: "--siliconflow-model",
        baseUrl: "--siliconflow-base-url",
        apiKey: "--siliconflow-api-key",
      },
      openaicompatible: {
        model: "--openai-compatible-model",
        baseUrl: "--openai-compatible-base-url",
        apiKey: "--openai-compatible-api-key",
      },
      deepl: {
        model: null,
        baseUrl: null,
        apiKey: "--deepl-auth-key",
      },
      aliyundashscope: {
        model: "--aliyun-dashscope-model",
        baseUrl: "--aliyun-dashscope-base-url",
        apiKey: "--aliyun-dashscope-api-key",
      },
    };
    return flagMap[service] || { model: null, baseUrl: null, apiKey: null };
  }

  private getServiceFlag(service: string): string | null {
    const flagMap: Record<string, string | null> = {
      "": null,
      google: "--google",
      bing: "--bing",
      deepl: "--deepl",
      openai: "--openai",
      ollama: "--ollama",
      deepseek: "--deepseek",
      siliconflow: "--siliconflow",
      openaicompatible: "--openaicompatible",
      aliyundashscope: "--aliyundashscope",
    };
    return flagMap[service] ?? null;
  }

  private findOutputFiles(
    inputPath: string,
    outputDir: string
  ): { monoPath: string | null; dualPath: string | null } {
    let files: string[];
    try {
      files = fs.readdirSync(outputDir);
    } catch {
      files = [];
    }

    PLAPI.logService.info(
      "[pdf2zh] findOutputFiles",
      `outputDir=${outputDir}, files=${JSON.stringify(files)}`,
      true,
      "pdf2zh"
    );

    let monoPath: string | null = null;
    let dualPath: string | null = null;

    for (const file of files) {
      const fullPath = path.join(outputDir, file);
      if (!fs.statSync(fullPath).isFile()) continue;

      const lower = file.toLowerCase();
      if (lower.includes("mono") && lower.endsWith(".pdf")) {
        monoPath = fullPath;
      } else if (lower.includes("dual") && lower.endsWith(".pdf")) {
        dualPath = fullPath;
      }
    }

    if (!monoPath && !dualPath) {
      for (const file of files) {
        const fullPath = path.join(outputDir, file);
        if (!fs.statSync(fullPath).isFile()) continue;
        if (file.toLowerCase().endsWith(".pdf") && file !== path.basename(inputPath)) {
          if (!monoPath) {
            monoPath = fullPath;
          } else if (!dualPath) {
            dualPath = fullPath;
          }
        }
      }
    }

    return { monoPath, dualPath };
  }

  createTempDir(): string {
    const dir = path.join(os.tmpdir(), "paperlib-pdf2zh");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  cleanupDir(dir: string): void {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}
