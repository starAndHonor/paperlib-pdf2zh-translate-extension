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
}

export interface TranslateResult {
  monoPath: string | null;
  dualPath: string | null;
  stdout: string;
  stderr: string;
}

export type ProgressCallback = (percent: number, stage: string) => void;

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
   * Run pdf2zh translation as a subprocess with real-time progress.
   * Uses spawn to parse stderr for tqdm/rich progress output.
   */
  async translate(
    filePath: string,
    options: TranslateOptions,
    outputDir: string,
    timeoutMinutes: number,
    onProgress?: ProgressCallback
  ): Promise<TranslateResult> {
    fs.mkdirSync(outputDir, { recursive: true });

    const args = this.buildArgs(filePath, options, outputDir);

    return new Promise((resolve, reject) => {
      const timeout = timeoutMinutes * 60 * 1000;
      let killed = false;

      const child = spawn(this.binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;

        if (onProgress) {
          const parsed = this.parseProgress(chunk);
          if (parsed !== null) {
            onProgress(parsed.percent, parsed.stage);
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

        if (code !== 0) {
          reject(new Error(`pdf2zh exited with code ${code}\n${stderr}`));
          return;
        }

        const result = this.findOutputFiles(filePath, outputDir);
        resolve({
          ...result,
          stdout,
          stderr,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`pdf2zh failed to start: ${err.message}`));
      });
    });
  }

  /**
   * Parse rich/tqdm progress from a stderr chunk.
   *
   * pdf2zh_next uses rich.progress.Progress by default (hardcoded use_rich_pbar=True).
   * Rich output format (after ANSI stripping):
   *   "translate  ━━━━━━━━━━━  45/100  0:00:00  -:--:--"
   *   "stage_name (1/3)  ━━━━━  15/30  0:00:00  -:--:--"
   *
   * Fallback tqdm format:
   *   "translate:  45%|████▌ | 45/100 [stage (12/30)]"
   */
  private parseProgress(chunk: string): { percent: number; stage: string } | null {
    // Strip ANSI escape codes (e.g. \x1b[32m, \x1b[?25l, \x1b[2K)
    const clean = chunk.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

    // Debug: log raw stderr chunk (first 200 chars)
    PLAPI.logService.info(
      "[pdf2zh] stderr chunk",
      JSON.stringify(clean.substring(0, 200)),
      false,
      "pdf2zh"
    );

    // Split into segments on \r and \n
    const parts = clean.split(/[\r\n]/);

    let percent: number | null = null;
    let stage = "";

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      // Rich format: match the "translate" line for overall progress
      // e.g. "translate  ━━━━━━━  45/100  0:00:00  -:--:--"
      const translateMatch = trimmed.match(/translate\s+.*?(\d+)\/100\b/);
      if (translateMatch) {
        percent = Math.min(parseInt(translateMatch[1], 10), 100);
      }

      // Rich format: match stage line
      // e.g. "stage_name (2/5)  ━━━━━  15/30  0:00:00  -:--:--"
      const stageMatch = trimmed.match(/([\w_]+)\s*\((\d+)\/(\d+)\)/);
      if (stageMatch) {
        stage = `${stageMatch[2]}/${stageMatch[3]}`;
      }

      // Fallback: tqdm format
      // e.g. "translate:  45%|████▌ | 45/100 [stage (12/30)]"
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

    // Input file (must be last)
    args.push(filePath);

    return args;
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
    };
    return flagMap[service] ?? null;
  }

  private findOutputFiles(
    inputPath: string,
    outputDir: string
  ): { monoPath: string | null; dualPath: string | null } {
    // Debug: log what's in the output directory
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

    // Fallback: look for any PDF that isn't the original
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
