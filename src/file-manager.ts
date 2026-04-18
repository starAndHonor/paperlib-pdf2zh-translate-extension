import { PLAPI } from "paperlib-api/api";
import fs from "fs";

/**
 * Controls which version opens by default after translation.
 * - "original": keep original as main, translations are supplementaries
 * - "mono": set monolingual translation as default supplementary
 * - "dual": set bilingual translation as default supplementary
 *
 * NOTE: "mono"/"dual" modes require Paperlib with the new Entity model
 * (supplementaries dict + defaultSup). On the old PaperEntity model (supURLs),
 * all files are added as supplementaries without a default override.
 */
export type DefaultOpenMode = "original" | "mono" | "dual";

/** URL path prefix used for temp translation output files. */
const PDF2ZH_TEMP_MARKER = "paperlib-pdf2zh";

export class FileManager {
  /**
   * Resolve the local file path of a paper's main PDF.
   */
  async resolvePaperPDF(entity: any): Promise<string | null> {
    const mainURL: string | undefined = entity.mainURL;
    if (!mainURL) {
      PLAPI.logService.warn(
        "[pdf2zh] No mainURL",
        "The paper entity has no mainURL field.",
        true,
        "pdf2zh"
      );
      return null;
    }

    try {
      const accessedUrl = await PLAPI.fileService.access(mainURL, true);
      if (!accessedUrl) {
        return null;
      }

      const localPath = accessedUrl.replace(/^file:\/\//, "");
      if (!localPath) {
        return null;
      }
      return decodeURIComponent(localPath);
    } catch (e) {
      PLAPI.logService.error(
        "[pdf2zh] access failed",
        String(e),
        true,
        "pdf2zh"
      );
      return null;
    }
  }

  /**
   * Attach translated PDFs to a paper entity as supplementaries.
   *
   * Compatible with both Paperlib data models:
   * - Old PaperEntity model: uses `supURLs` (string array)
   * - New Entity model: uses `supplementaries` (dict) + `defaultSup`
   */
  async attachAsSupplementary(
    entity: any,
    files: { mono?: string; dual?: string },
    langOut: string,
    defaultOpen: DefaultOpenMode
  ): Promise<void> {
    // Clean up old pdf2zh translations and stale supURLs
    await this.cleanupOldTranslationURLs(entity);

    // New Entity model path: supplementaries dict exists
    if (entity.supplementaries && typeof entity.supplementaries === "object" && !Array.isArray(entity.supplementaries)) {
      await this.attachViaSupplementaries(entity, files, langOut, defaultOpen);
    } else {
      // Old PaperEntity model path: supURLs array
      this.attachViaSupURLs(entity, files);
    }
  }

  /**
   * Scan entity for all existing pdf2zh translations.
   * Works with both old and new data models.
   */
  findAllExistingTranslations(
    entity: any
  ): Array<{ id?: string; url: string; name?: string }> {
    const results: Array<{ id?: string; url: string; name?: string }> = [];

    // New model: check supplementaries dict
    if (entity.supplementaries && typeof entity.supplementaries === "object" && !Array.isArray(entity.supplementaries)) {
      for (const [id, sup] of Object.entries(entity.supplementaries) as Array<[string, any]>) {
        if (sup?.url) {
          results.push({ id, url: sup.url, name: sup.name });
        }
      }
    }

    // Old model: check supURLs for pdf2zh temp paths that have been moved to library
    if (entity.supURLs && Array.isArray(entity.supURLs)) {
      for (const url of entity.supURLs) {
        results.push({ url });
      }
    }

    return results;
  }

  /**
   * Old model: add files via supURLs array.
   */
  private attachViaSupURLs(entity: any, files: { mono?: string; dual?: string }): void {
    const supURLs: string[] = entity.supURLs ? [...entity.supURLs] : [];

    // Verify files exist before adding to supURLs
    for (const [key, filePath] of Object.entries(files)) {
      if (!filePath) continue;
      const exists = fs.existsSync(filePath);
      PLAPI.logService.info(
        "[pdf2zh] File check",
        `${key}=${filePath}, exists=${exists}`,
        true,
        "pdf2zh"
      );
      if (!exists) {
        PLAPI.logService.error(
          "[pdf2zh] Source file missing",
          `${key}=${filePath}`,
          true,
          "pdf2zh"
        );
        continue;
      }
      supURLs.push(`file://${filePath}`);
    }

    entity.supURLs = supURLs;
  }

  /**
   * New model: add files via supplementaries dict with named entries.
   * Also sets defaultSup if requested.
   */
  private async attachViaSupplementaries(
    entity: any,
    files: { mono?: string; dual?: string },
    langOut: string,
    defaultOpen: DefaultOpenMode
  ): Promise<void> {
    const langLabel = this.getLanguageLabel(langOut);
    let defaultSupId: string | undefined;

    if (files.dual) {
      const supId = this.generateSupId();
      entity.supplementaries[supId] = {
        _id: supId,
        url: `file://${files.dual}`,
        name: `[pdf2zh] [${langLabel}] Bilingual`,
      };
      if (defaultOpen === "dual") {
        defaultSupId = supId;
      }
    }

    if (files.mono) {
      const supId = this.generateSupId();
      entity.supplementaries[supId] = {
        _id: supId,
        url: `file://${files.mono}`,
        name: `[pdf2zh] [${langLabel}] Mono`,
      };
      if (defaultOpen === "mono") {
        defaultSupId = supId;
      }
    }

    if (defaultSupId) {
      entity.defaultSup = defaultSupId;
    }
  }

  /**
   * Remove stale supURLs entries and old pdf2zh translation URLs.
   * For the old model: validates each entry via fileService.access()
   * and removes entries whose files no longer exist.
   */
  private async cleanupOldTranslationURLs(entity: any): Promise<void> {
    if (!entity.supURLs || !Array.isArray(entity.supURLs) || entity.supURLs.length === 0) {
      return;
    }

    const validURLs: string[] = [];
    for (const url of entity.supURLs) {
      // Remove entries from our temp dir (in-progress or failed translations)
      if (url.includes(PDF2ZH_TEMP_MARKER)) {
        continue;
      }

      // Verify file is accessible via Paperlib's file service
      try {
        const accessed = await PLAPI.fileService.access(url, true);
        if (accessed) {
          validURLs.push(url);
        } else {
          PLAPI.logService.info(
            "[pdf2zh] Removing stale supURL",
            url,
            false,
            "pdf2zh"
          );
        }
      } catch {
        // File not found or inaccessible — remove it
        PLAPI.logService.info(
          "[pdf2zh] Removing inaccessible supURL",
          url,
          false,
          "pdf2zh"
        );
      }
    }

    entity.supURLs = validURLs;

    // Also remove supplementaries dict entries with pdf2zh prefix (new model)
    if (entity.supplementaries && typeof entity.supplementaries === "object" && !Array.isArray(entity.supplementaries)) {
      for (const [id, sup] of Object.entries(entity.supplementaries) as Array<[string, any]>) {
        if (sup?.name?.startsWith("[pdf2zh]")) {
          delete entity.supplementaries[id];
        }
      }
    }
  }

  private generateSupId(): string {
    const randomPart = Math.random().toString(36);
    const timestampPart = Date.now().toString(36);
    return (
      randomPart.slice(randomPart.length - 4) +
      timestampPart.slice(timestampPart.length - 4)
    );
  }

  private getLanguageLabel(langCode: string): string {
    const labels: Record<string, string> = {
      zh: "ZH",
      en: "EN",
      ja: "JA",
      ko: "KO",
      fr: "FR",
      de: "DE",
      ru: "RU",
      es: "ES",
      pt: "PT",
      it: "IT",
    };
    return labels[langCode] || langCode.toUpperCase();
  }
}
