import { PLAPI } from "paperlib-api/api";
import { FileManager, DefaultOpenMode } from "./file-manager";
import { Pdf2zhClient, TranslateOptions, TranslateResult } from "./pdf2zh-client";
import { UIManager } from "./ui-manager";

export interface TranslationConfig {
  langIn: string;
  langOut: string;
  translateService: string;
  outputMode: "both" | "mono" | "dual";
  storageMode: DefaultOpenMode;
  timeoutMinutes: number;
  apiBaseUrl: string;
  apiKey: string;
  modelName: string;
}

export class TranslationManager {
  private client: Pdf2zhClient;
  private fileManager: FileManager;
  private uiManager: UIManager;

  // Track in-progress translations by entity ID to prevent duplicates
  private activeEntityIds: Set<string> = new Set();

  // Track completed translations to show status in slot
  private completedEntityIds: Set<string> = new Set();

  constructor(
    client: Pdf2zhClient,
    fileManager: FileManager,
    uiManager: UIManager
  ) {
    this.client = client;
    this.fileManager = fileManager;
    this.uiManager = uiManager;
  }

  /**
   * Check if a translation is in progress for the given entity.
   */
  isTranslating(entityId: string): boolean {
    return this.activeEntityIds.has(entityId);
  }

  /**
   * Check if translation was completed for the given entity.
   */
  isCompleted(entityId: string): boolean {
    return this.completedEntityIds.has(entityId);
  }

  /**
   * Start a translation for the given paper entity.
   * Runs pdf2zh as a CLI subprocess and awaits completion.
   */
  async startTranslation(entity: any, config: TranslationConfig): Promise<void> {
    const entityId = String(entity._id);

    // Prevent duplicate translations
    if (this.activeEntityIds.has(entityId)) {
      PLAPI.logService.warn(
        "Translation already in progress",
        "Please wait for the current translation to complete.",
        true,
        "pdf2zh"
      );
      return;
    }

    // Reload full entity — uiStateService returns a lightweight preview
    // without supplementaries/defaultSup fields
    const fullEntities = await PLAPI.paperService.load(
      `_id == oid(${entityId})`,
      "addTime",
      "desc"
    );
    if (!fullEntities || fullEntities.length === 0) {
      PLAPI.logService.error(
        "Paper not found",
        `Could not load entity ${entityId}`,
        true,
        "pdf2zh"
      );
      return;
    }
    const fullEntity = fullEntities[0] as any;

    PLAPI.logService.info(
      "[pdf2zh] fullEntity loaded",
      `title=${fullEntity.title}, ` +
      `defaultSup=${JSON.stringify(fullEntity.defaultSup)}, ` +
      `hasSup=${!!fullEntity.supplementaries}, ` +
      `supType=${typeof fullEntity.supplementaries}, ` +
      `supKeys=${fullEntity.supplementaries ? Object.keys(fullEntity.supplementaries).join(",") : "none"}, ` +
      `ownKeys=${Object.keys(fullEntity).join(",")}`,
      true,
      "pdf2zh"
    );

    // Validate entity has a PDF
    const pdfPath = await this.fileManager.resolvePaperPDF(fullEntity);
    if (!pdfPath) {
      PLAPI.logService.warn(
        "No PDF file",
        "The selected paper has no PDF attached.",
        true,
        "pdf2zh"
      );
      return;
    }

    // Check pdf2zh availability
    const available = await this.client.checkAvailable();
    if (!available) {
      PLAPI.logService.error(
        "pdf2zh not found",
        "Please install pdf2zh: pip install pdf2zh-next",
        true,
        "pdf2zh"
      );
      return;
    }

    // Clear previous completion status
    this.completedEntityIds.delete(entityId);
    this.activeEntityIds.add(entityId);

    // Update UI to show "starting" state
    this.uiManager.updateSlotForEntity(entityId, "starting");

    try {
      PLAPI.logService.info(
        "Starting translation...",
        entity.title,
        true,
        "pdf2zh"
      );

      // Build output options from config
      const noMono = config.outputMode === "dual";
      const noDual = config.outputMode === "mono";

      const options: TranslateOptions = {
        langIn: config.langIn,
        langOut: config.langOut,
        service: config.translateService,
        noMono,
        noDual,
        apiBaseUrl: config.apiBaseUrl,
        apiKey: config.apiKey,
        modelName: config.modelName,
      };

      // Create temp output directory
      const outputDir = this.client.createTempDir();

      // Update UI to show "running" state
      this.uiManager.updateSlotForEntity(entityId, "progress", { percent: 0, stage: "" });

      // Progress callback: update slot and notification bar
      const onProgress = (percent: number, stage: string) => {
        this.uiManager.updateSlotForEntity(entityId, "progress", { percent, stage });

        PLAPI.logService.progress(
          `Translating: ${entity.title || "Untitled"}`,
          percent,
          true,
          "pdf2zh",
          entityId
        );
      };

      // Run pdf2zh CLI subprocess with real-time progress
      const result: TranslateResult = await this.client.translate(
        pdfPath,
        options,
        outputDir,
        config.timeoutMinutes,
        onProgress
      );

      // Log stdout/stderr for debugging
      if (result.stderr) {
        PLAPI.logService.info(
          "pdf2zh stderr",
          result.stderr.substring(0, 500),
          false,
          "pdf2zh"
        );
      }

      // Verify output files exist
      if (!result.monoPath && !result.dualPath) {
        throw new Error("No output files generated by pdf2zh");
      }

      PLAPI.logService.info(
        "Translation complete, attaching files...",
        entity.title,
        true,
        "pdf2zh"
      );

      this.uiManager.updateSlotForEntity(entityId, "attaching");

      // Reload entity to get latest state before attaching
      const entities = await PLAPI.paperService.load(
        `_id == oid(${entityId})`,
        "addTime",
        "desc"
      );
      if (!entities || entities.length === 0) {
        throw new Error("Paper entity not found after translation");
      }
      const freshEntity = entities[0];

      // Attach translated PDFs as supplementaries
      await this.fileManager.attachAsSupplementary(
        freshEntity,
        {
          mono: result.monoPath || undefined,
          dual: result.dualPath || undefined,
        },
        config.langOut,
        config.storageMode
      );

      // Cleanup temp output directory
      this.client.cleanupDir(outputDir);

      // Mark as completed
      this.activeEntityIds.delete(entityId);
      this.completedEntityIds.add(entityId);

      this.uiManager.updateSlotForEntity(entityId, "complete");

      PLAPI.logService.info(
        "Translation saved",
        `Translated PDFs added to "${entity.title || "Untitled"}"`,
        true,
        "pdf2zh"
      );
    } catch (e) {
      this.activeEntityIds.delete(entityId);

      this.uiManager.updateSlotForEntity(entityId, "error");

      PLAPI.logService.error(
        "Translation failed",
        `${String(e)} — ${entity.title || "Untitled"}`,
        true,
        "pdf2zh"
      );
    }
  }

  /**
   * Dispose all active state.
   */
  dispose(): void {
    this.activeEntityIds.clear();
  }
}
