import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';
import { PDFDocument, PDFPage, degrees } from 'pdf-lib';
import type { ExportWorkerInput, ExportWorkerOutput } from '../../shared/types/pdf';
import { getPdfArtifactStore, readPdfArtifact } from '../services/pdfArtifactStore';
import {
  burnOverlaysOntoPage,
  createStandardFontCache,
} from '../services/pdfOverlayBurnIn';

/**
 * Core assembly logic extracted for testability.
 * Loads source PDFs, copies pages in manifest order with rotations,
 * excludes deleted pages, and returns the assembled PDF bytes.
 */
export async function assemblePdf(input: ExportWorkerInput): Promise<ExportWorkerOutput> {
  try {
    const {
      manifest,
      filePaths = {},
      fileBytes = {},
      artifactFiles = {},
      outputRef,
      overlays = [],
    } = input;
    const outputDoc = await PDFDocument.create();
    const activeEntries = manifest.filter((entry) => !entry.deleted);
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
        return { success: false, error: `Source file not found for fileId: ${fileId}` };
      }
      if (filePath && !fs.existsSync(filePath)) {
        return { success: false, error: `File missing on disk: ${filePath}` };
      }

      const sourceBytes = providedBytes ?? fs.readFileSync(filePath);
      const sourceDoc = await PDFDocument.load(sourceBytes);
      const pageCount = sourceDoc.getPageCount();
      const invalidEntry = groupedEntries.find(
        ({ entry }) =>
          entry.sourcePageIndex < 0 || entry.sourcePageIndex >= pageCount,
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
        groupedEntries.map(({ entry }) => entry.sourcePageIndex),
      );
      copiedPages.forEach((copiedPage, index) => {
        const { entry, outputIndex } = groupedEntries[index];
        if (entry.rotation !== 0) {
          copiedPage.setRotation(degrees(entry.rotation));
        }
        copiedPagesByOutputIndex[outputIndex] = copiedPage;
      });
    }

    const fontCache = await createStandardFontCache(outputDoc, overlays);
    for (let index = 0; index < copiedPagesByOutputIndex.length; index++) {
      const copiedPage = copiedPagesByOutputIndex[index];
      outputDoc.addPage(copiedPage);
      const pageId = activeEntries[index].pageId;
      burnOverlaysOntoPage(
        copiedPage,
        overlays.filter((overlay) => overlay.pageId === pageId),
        fontCache
      );
    }

    const pdfBytes = await outputDoc.save();
    if (outputRef) {
      await getPdfArtifactStore().putFile(outputRef, pdfBytes);
    }
    return { success: true, pdfBytes: new Uint8Array(pdfBytes) };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown assembly error';
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
          ? { success: true } satisfies ExportWorkerOutput
          : result,
      );
    })
    .catch((err) => {
      parentPort!.postMessage({
        success: false,
        error: err instanceof Error ? err.message : 'Worker crash',
      } as ExportWorkerOutput);
    });
}
