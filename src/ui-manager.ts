import { PLAPI, PLMainAPI } from "paperlib-api/api";
import { TranslationManager } from "./translation-manager";

type SlotState =
  | "idle"
  | "starting"
  | "progress"
  | "attaching"
  | "complete"
  | "error";

interface ProgressData {
  percent: number;
  stage: string;
}

const SLOT_ID = "paperDetailsPanelSlot2" as const;
const SLOT_KEY = "pdf2zh-translate";

export class UIManager {
  private translationManager: TranslationManager;
  private currentEntityId: string | null = null;

  /** Cache last known progress per entity so reopening the panel restores it */
  private progressCache: Map<string, ProgressData> = new Map();

  constructor(translationManager: TranslationManager) {
    this.translationManager = translationManager;
  }

  /**
   * Called when the selected paper changes.
   * Updates the slot to reflect the current paper's translation state.
   */
  onSelectionChanged(entityId: string | null): void {
    this.currentEntityId = entityId;

    if (!entityId) {
      this.clearSlot();
      return;
    }

    if (this.translationManager.isTranslating(entityId)) {
      const cached = this.progressCache.get(entityId) || { percent: 0, stage: "" };
      this.updateSlotForEntity(entityId, "progress", cached);
    } else if (this.translationManager.isCompleted(entityId)) {
      this.updateSlotForEntity(entityId, "complete");
    } else {
      this.updateSlotForEntity(entityId, "idle");
    }
  }

  /**
   * Update the slot content for a given entity.
   * Only updates if the entity matches the current selection.
   */
  updateSlotForEntity(
    entityId: string,
    state: SlotState,
    data?: ProgressData,
    langOut?: string
  ): void {
    // Only update slot if this entity is currently selected
    if (this.currentEntityId !== entityId) {
      return;
    }

    // Cache progress data for panel reopen
    if (state === "progress" && data) {
      this.progressCache.set(entityId, data);
    } else if (state === "complete" || state === "error") {
      this.progressCache.delete(entityId);
    }

    const content = this.generateSlotHTML(state, data, langOut);

    PLAPI.uiSlotService.updateSlot(SLOT_ID, {
      [SLOT_KEY]: {
        title: "PDF Translation",
        content,
      },
    });
  }

  /**
   * Clear the slot content entirely.
   */
  clearSlot(): void {
    PLAPI.uiSlotService.updateSlot(SLOT_ID, {
      [SLOT_KEY]: undefined,
    });
  }

  /**
   * Generate HTML content for the slot based on translation state.
   */
  private generateSlotHTML(
    state: SlotState,
    data?: ProgressData,
    langOut?: string
  ): string {
    const baseStyle = "font-size:11px;";

    switch (state) {
      case "idle":
        return `<div style="display:flex;align-items:center;gap:6px;">
          <span style="${baseStyle}color:#6b7280;">
            Use \u2318\u21E7P \u2192 "Translate PDF" or right-click to translate this PDF
          </span>
        </div>`;

      case "starting":
        return `<div style="display:flex;align-items:center;gap:6px;">
          <span style="${baseStyle}color:#3b82f6;">
            \u23F3 Checking pdf2zh availability...
          </span>
        </div>`;

      case "progress": {
        const percent = data?.percent ?? 0;
        const stage = data?.stage ?? "";
        return `<div style="display:flex;align-items:center;gap:8px;">
          <span style="${baseStyle}color:#3b82f6;">
            \u23F3 Translating... ${percent}%${stage ? ` \u00B7 ${stage}` : ""}
          </span>
          <div style="flex:1;max-width:100px;height:3px;background:#e5e7eb;border-radius:2px;">
            <div style="height:100%;width:${percent}%;background:#3b82f6;border-radius:2px;"></div>
          </div>
        </div>`;
      }

      case "attaching":
        return `<div style="display:flex;align-items:center;gap:6px;">
          <span style="${baseStyle}color:#3b82f6;">
            \u23F3 Attaching translated PDFs...
          </span>
        </div>`;

      case "complete": {
        const lang = langOut ? ` to ${langOut.toUpperCase()}` : "";
        return `<div style="display:flex;align-items:center;gap:6px;">
          <span style="${baseStyle}color:#22c55e;">
            \u2705 Translation${lang} saved as supplementaries
          </span>
        </div>`;
      }

      case "error":
        return `<div style="display:flex;align-items:center;gap:6px;">
          <span style="${baseStyle}color:#ef4444;">
            \u274C Translation failed \u2014 check log for details
          </span>
        </div>`;

      default:
        return "";
    }
  }

  /**
   * Register the extension command.
   */
  registerCommand(extensionId: string): () => void {
    PLAPI.commandService.registerExternel({
      id: "pdf2zh_translate",
      description: "Translate PDF with pdf2zh",
      event: "pdf2zh_translate",
    });

    const onCommand = async () => {
      const selected = (await PLAPI.uiStateService.getState(
        "selectedPaperEntities"
      )) as any[];
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
      // Signal the main extension to start translation
      await (globalThis as any).__pdf2zh_startTranslation();
    };

    PLAPI.commandService.on("pdf2zh_translate" as any, onCommand);

    return () => {
      // Commands are not explicitly unregistered in Paperlib's API
    };
  }

  /**
   * Register the context menu item.
   */
  registerContextMenu(extensionId: string): () => void {
    PLMainAPI.contextMenuService.registerContextMenu(extensionId, [
      { id: "translate_pdf", label: "Translate PDF (pdf2zh)" },
    ]);

    const onContextMenu = async (value: any) => {
      const { extID, itemID } = value.value || value;
      if (extID === extensionId && itemID === "translate_pdf") {
        await (globalThis as any).__pdf2zh_startTranslation();
      }
    };

    PLMainAPI.contextMenuService.on(
      "dataContextMenuFromExtensionsClicked" as any,
      onContextMenu
    );

    return () => {
      try {
        PLMainAPI.contextMenuService.unregisterContextMenu(extensionId);
      } catch {
        // Ignore
      }
    };
  }

  /**
   * Set up a listener for selection changes.
   */
  watchSelection(): () => void {
    const disposer = PLAPI.uiStateService.onChanged(
      "selectedPaperEntities",
      (newValue: any) => {
        const entities = newValue.value || newValue;
        if (entities && entities.length === 1) {
          const entity = entities[0];
          this.onSelectionChanged(String(entity._id));
        } else {
          this.onSelectionChanged(null);
        }
      }
    );

    return () => {
      if (disposer) {
        try {
          disposer();
        } catch {
          // Ignore
        }
      }
    };
  }

  /**
   * Dispose all UI resources.
   */
  dispose(): void {
    this.clearSlot();
  }
}
