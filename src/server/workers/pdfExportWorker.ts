import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';
import { PDFDocument, PDFPage, degrees } from 'pdf-lib';
import type {
  ExportWorkerInput,
  ExportWorkerOutput,
} from '../../shared/types/pdf';
import {
  getPdfArtifactStore,
  readPdfArtifact,
} from '../services/pdfArtifactStore';
import {
  burnOverlaysOntoPage,
  createOverlayFontCache,
} from '../services/pdfOverlayBurnIn';
import { fillAndFlattenForm } from '../services/pdfFormService';
import {
  embedSignatureAssets,
  burnSignaturesOntoPage,
} from '../services/pdfSignatureBurnIn';
import {
  aprysePdfEditingService,
  type ApryseTextReplacement,
} from '../services/aprysePdfEditingService';

/**
 * Core assembly logic extracted for testability.
 * Loads source PDFs, copies pages in manifest order with rotations,
 * excludes deleted pages, and returns the assembled PDF bytes.
 */
export async function assemblePdf(
  input: ExportWorkerInput
): Promise<ExportWorkerOutput> {
  try {
    const {
      manifest,
      filePaths = {},
      fileBytes = {},
      artifactFiles = {},
      outputRef,
      overlays = [],
      formFieldValues = [],
      signatureOverlays = [],
      signatureArtifacts = {},
    } = input;
    const outputDoc = await PDFDocument.create();
    const activeEntries = manifest.filter((entry) => !entry.deleted);
    const outputPageById = new Map(
      activeEntries.map((entry, index) => [entry.pageId, index + 1] as const)
    );
    const apryseReplacements: ApryseTextReplacement[] = [];
    const apryseOverlayIds = new Set<string>();
    if (aprysePdfEditingService.isConfigured()) {
      for (const overlay of overlays) {
        const pageNumber = outputPageById.get(overlay.pageId);
        if (
          pageNumber === undefined ||
          overlay.kind !== 'replace' ||
          overlay.coverActive === false ||
          !overlay.replacementOriginalText ||
          overlay.replacementOriginalText === overlay.text
        ) {
          continue;
        }
        apryseOverlayIds.add(overlay.id);
        apryseReplacements.push({
          pageNumber,
          originalText: overlay.replacementOriginalText,
          replacementText: overlay.text,
        });
      }
    }
    const burnInOverlays = overlays.filter(
      (overlay) => !apryseOverlayIds.has(overlay.id)
    );
    const entriesByFile = new Map<
      string,
      Array<{ entry: (typeof activeEntries)[number]; outputIndex: number }>
    >();

    activeEntries.forEach((entry, outputIndex) => {
      const groupedEntries = entriesByFile.get(entry.fileId) ?? [];
      groupedEntries.push({ entry, outputIndex });
      entriesByFile.set(entry.fileId, groupedEntries);
    });

    const copiedPagesByOutputIndex: PDFPage[] = [];

    for (const [fileId, groupedEntries] of entriesByFile) {
      const filePath = filePaths[fileId];
      let providedBytes = fileBytes[fileId];
      const artifactRef = artifactFiles[fileId];
      if (!providedBytes && artifactRef) {
        providedBytes = await readPdfArtifact(artifactRef);
      }
      if (!filePath && !providedBytes) {
        return {
          success: false,
          error: `Source file not found for fileId: ${fileId}`,
        };
      }
      if (filePath && !fs.existsSync(filePath)) {
        return { success: false, error: `File missing on disk: ${filePath}` };
      }

      const rawSourceBytes = providedBytes ?? fs.readFileSync(filePath);

      // ── Step 1: fill and flatten AcroForm fields before copyPages ──────────
      // Values scoped to this fileId are passed; others are ignored by the service.
      const fileFormValues = formFieldValues.filter((v) => v.fileId === fileId);
      const flattenedBytes = await fillAndFlattenForm(
        rawSourceBytes,
        fileFormValues
      );

      const sourceDoc = await PDFDocument.load(flattenedBytes);
      const pageCount = sourceDoc.getPageCount();
      const invalidEntry = groupedEntries.find(
        ({ entry }) =>
          entry.sourcePageIndex < 0 || entry.sourcePageIndex >= pageCount
      );
      if (invalidEntry) {
        return {
          success: false,
          error: `Invalid page index ${invalidEntry.entry.sourcePageIndex} for fileId: ${fileId}`,
        };
      }

      // One copyPages call per source avoids repeated pdf-lib setup for large exports.
      const copiedPages = await outputDoc.copyPages(
        sourceDoc,
        groupedEntries.map(({ entry }) => entry.sourcePageIndex)
      );
      copiedPages.forEach((copiedPage, index) => {
        const { entry, outputIndex } = groupedEntries[index];
        if (entry.rotation !== 0) {
          copiedPage.setRotation(degrees(entry.rotation));
        }
        copiedPagesByOutputIndex[outputIndex] = copiedPage;
      });
    }

    // ── Step 2: load and embed signature PNG assets ─────────────────────────
    // Only load assets that are actually referenced by overlays in this export.
    const exportedPageIds = new Set(activeEntries.map((e) => e.pageId));
    const activeSignatureOverlays = signatureOverlays.filter((o) =>
      exportedPageIds.has(o.pageId)
    );
    const neededAssetIds = new Set(
      activeSignatureOverlays.map((o) => o.assetId)
    );
    const signatureByteMap = new Map<string, Uint8Array | Buffer>();

    for (const assetId of neededAssetIds) {
      const ref = signatureArtifacts[assetId];
      if (!ref) {
        return {
          success: false,
          error: `Signature asset reference missing for assetId "${assetId}". Cannot export without all signatures.`,
        };
      }
      const pngBytes = await readPdfArtifact(ref);
      signatureByteMap.set(assetId, pngBytes);
    }

    const embeddedSignatures = await embedSignatureAssets(
      outputDoc,
      signatureByteMap
    );

    // ── Step 3: add pages, burn text overlays, burn signature overlays ──────
    const pagesByPageId = new Map<string, PDFPage>();
    for (let i = 0; i < copiedPagesByOutputIndex.length; i++) {
      pagesByPageId.set(activeEntries[i].pageId, copiedPagesByOutputIndex[i]);
    }
    const fontCache = await createOverlayFontCache(
      outputDoc,
      burnInOverlays,
      pagesByPageId
    );
    for (let index = 0; index < copiedPagesByOutputIndex.length; index++) {
      const copiedPage = copiedPagesByOutputIndex[index];
      outputDoc.addPage(copiedPage);
      const pageId = activeEntries[index].pageId;

      burnOverlaysOntoPage(
        copiedPage,
        burnInOverlays.filter((overlay) => overlay.pageId === pageId),
        fontCache
      );

      burnSignaturesOntoPage(
        copiedPage,
        activeSignatureOverlays.filter((o) => o.pageId === pageId),
        embeddedSignatures
      );
    }

    let pdfBytes = new Uint8Array(await outputDoc.save());
    if (apryseReplacements.length > 0) {
      pdfBytes = await aprysePdfEditingService.replaceText(
        pdfBytes,
        apryseReplacements
      );
    }
    if (outputRef) {
      await getPdfArtifactStore().putFile(outputRef, pdfBytes);
    }
    return { success: true, pdfBytes };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown assembly error';
    return { success: false, error: message };
  }
}

// Worker entry point — only runs when loaded as a worker thread
if (parentPort && workerData) {
  const input = workerData as ExportWorkerInput;
  assemblePdf(input)
    .then((result) => {
      parentPort!.postMessage(
        input.outputRef && result.success
          ? ({ success: true } satisfies ExportWorkerOutput)
          : result
      );
    })
    .catch((err) => {
      parentPort!.postMessage({
        success: false,
        error: err instanceof Error ? err.message : 'Worker crash',
      } as ExportWorkerOutput);
    });
}
