import { PLAPI, PLExtAPI, PLExtension, PLMainAPI } from "paperlib-api/api";
import { FileManager, DefaultOpenMode } from "./file-manager";
import { Pdf2zhClient } from "./pdf2zh-client";
import { TranslationManager, TranslationConfig } from "./translation-manager";
import { UIManager } from "./ui-manager";

class Pdf2zhTranslateExtension extends PLExtension {
  private client: Pdf2zhClient;
  private fileManager: FileManager;
  private translationManager!: TranslationManager;
  private uiManager!: UIManager;

  private disposers: (() => void)[] = [];

  constructor() {
    super({
      id: "paperlib-pdf2zh-translate-extension",
      defaultPreference: {
        langOut: {
          type: "options",
          name: "Target Language",
          description: "Target language for translation",
          value: "zh",
          options: {
            zh: "Chinese",
            en: "English",
            ja: "Japanese",
            ko: "Korean",
            fr: "French",
            de: "German",
            ru: "Russian",
            es: "Spanish",
            pt: "Portuguese",
            it: "Italian",
          },
          order: 0,
        },
        translateService: {
          type: "options",
          name: "Translation Service",
          description: "Translation service to use",
          value: "google",
          options: {
            "": "Default",
            google: "Google",
            bing: "Bing",
            deepl: "DeepL",
            openai: "OpenAI",
            ollama: "Ollama",
            deepseek: "DeepSeek",
            siliconflow: "SiliconFlow",
            openaicompatible: "OpenAI Compatible",
          },
          order: 1,
        },
        outputMode: {
          type: "options",
          name: "Output Mode",
          description: "Which translated PDFs to generate",
          value: "both",
          options: {
            both: "Both (Mono + Bilingual)",
            mono: "Monolingual Only",
            dual: "Bilingual Only",
          },
          order: 2,
        },
        storageMode: {
          type: "options",
          name: "Default Open",
          description:
            "Which PDF version opens by default after translation. Original keeps the source PDF as main. Mono/Dual replaces the main PDF with the translated version.",
          value: "dual",
          options: {
            original: "Original (keep source as main)",
            mono: "Monolingual translation",
            dual: "Bilingual translation",
          },
          order: 3,
        },
        timeoutMinutes: {
          type: "string",
          name: "Timeout (minutes)",
          description:
            "Maximum time in minutes to wait for a translation to complete",
          value: "30",
          order: 4,
        },
        pdf2zhPath: {
          type: "string",
          name: "pdf2zh Binary Path",
          description:
            "Absolute path to the pdf2zh executable (e.g. /home/user/.local/bin/pdf2zh). Leave empty to use system PATH.",
          value: "",
          order: 5,
        },
      },
    });

    this.client = new Pdf2zhClient();
    this.fileManager = new FileManager();
  }

  async initialize(): Promise<void> {
    // Register preferences
    await PLExtAPI.extensionPreferenceService.register(
      this.id,
      this.defaultPreference
    );

    // Create UI manager first (needed by translation manager for slot updates)
    this.uiManager = new UIManager(null as any);

    // Create translation manager with all dependencies
    this.translationManager = new TranslationManager(
      this.client,
      this.fileManager,
      this.uiManager
    );

    // Wire uiManager back to translation manager
    this.uiManager = new UIManager(this.translationManager);
    // Re-inject updated uiManager
    (this.translationManager as any).uiManager = this.uiManager;

    // Expose translation trigger for command/context-menu callbacks
    (globalThis as any).__pdf2zh_startTranslation = async () => {
      await this.startTranslation();
    };

    // Register command
    this.disposers.push(this.uiManager.registerCommand(this.id));

    // Register context menu
    this.disposers.push(this.uiManager.registerContextMenu(this.id));

    // Watch selection changes for slot updates
    this.disposers.push(this.uiManager.watchSelection());

    PLAPI.logService.info(
      "pdf2zh translate extension initialized",
      "",
      false,
      "pdf2zh"
    );
  }

  async dispose(): Promise<void> {
    // Clean up all disposers
    for (const disposer of this.disposers) {
      try {
        disposer();
      } catch {
        // Ignore cleanup errors
      }
    }
    this.disposers = [];

    // Dispose translation manager
    this.translationManager.dispose();

    // Dispose UI manager (clears slots)
    this.uiManager.dispose();

    // Unregister preferences
    PLExtAPI.extensionPreferenceService.unregister(this.id);

    // Clean up global reference
    delete (globalThis as any).__pdf2zh_startTranslation;

    PLAPI.logService.info(
      "pdf2zh translate extension disposed",
      "",
      false,
      "pdf2zh"
    );
  }

  /**
   * Start translation for the currently selected paper.
   */
  private async startTranslation(): Promise<void> {
    const selected = (await PLAPI.uiStateService.getState("selectedPaperEntities")) as any[];
    if (!selected || selected.length === 0) {
      PLAPI.logService.warn(
        "No paper selected",
        "Please select a paper first.",
        true,
        "pdf2zh"
      );
      return;
    }
    if (selected.length > 1) {
      PLAPI.logService.warn(
        "Multiple papers selected",
        "Please select a single paper to translate.",
        true,
        "pdf2zh"
      );
      return;
    }

    const entity = selected[0];
    const config = await this.getConfig();

    await this.translationManager.startTranslation(entity, config);
  }

  /**
   * Read current preferences into a TranslationConfig.
   */
  private async getConfig(): Promise<TranslationConfig> {
    const getPref = async (key: string) => {
      return await PLExtAPI.extensionPreferenceService.get(this.id, key);
    };

    // Update binary path from preferences
    const pdf2zhPath = (await getPref("pdf2zhPath")) || "";
    this.client.setBinaryPath(pdf2zhPath || "pdf2zh");

    return {
      langIn: "", // Auto-detect
      langOut: (await getPref("langOut")) || "zh",
      translateService: (await getPref("translateService")) || "google",
      outputMode: (await getPref("outputMode")) || "both",
      storageMode: (await getPref("storageMode")) || "dual",
      timeoutMinutes: parseInt(
        (await getPref("timeoutMinutes")) || "30",
        10
      ),
    };
  }
}

async function initialize() {
  const extension = new Pdf2zhTranslateExtension();
  await extension.initialize();
  return extension;
}

export { initialize };
