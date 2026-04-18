import { PLAPI } from "paperlib-api/api";

/**
 * Controls which version is set as the default opened PDF after translation.
 * - "original": keep original as main, add translations as supplementaries
 * - "mono": replace main PDF with monolingual translation
 * - "dual": replace main PDF with bilingual translation
 */
export type DefaultOpenMode = "original" | "mono" | "dual";

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
   * Attach translated PDFs to a paper entity.
   * Uses paperService.update() to change mainURL and add supURLs.
   */
  async attachAsSupplementary(
    entity: any,
    files: { mono?: string; dual?: string },
    langOut: string,
    defaultOpen: DefaultOpenMode
  ): Promise<void> {
    const langLabel = this.getLanguageLabel(langOut);

    // Determine which file becomes the main PDF based on user preference
    let newMainURL: string | undefined;
    if (defaultOpen === "mono" && files.mono) {
      newMainURL = `file://${files.mono}`;
    } else if (defaultOpen === "dual" && files.dual) {
      newMainURL = `file://${files.dual}`;
    }

    // Update mainURL if replacing
    if (newMainURL) {
      PLAPI.logService.info(
        "[pdf2zh] Setting main URL",
        newMainURL,
        true,
        "pdf2zh"
      );
      entity.mainURL = newMainURL;
    }

    // Collect supplementary URLs (files not set as main)
    const supURLs: string[] = entity.supURLs ? [...entity.supURLs] : [];

    if (files.mono && newMainURL !== `file://${files.mono}`) {
      supURLs.push(`file://${files.mono}`);
    }
    if (files.dual && newMainURL !== `file://${files.dual}`) {
      supURLs.push(`file://${files.dual}`);
    }

    entity.supURLs = supURLs;

    // Persist via paperService.update() — moves files into library and saves
    PLAPI.logService.info(
      "[pdf2zh] Updating entity",
      `mainURL=${entity.mainURL}, supURLs=${JSON.stringify(supURLs)}`,
      true,
      "pdf2zh"
    );

    await PLAPI.paperService.update([entity], true, true);
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
