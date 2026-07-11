import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';
import { PDFDocument, PDFPage, degrees } from 'pdf-lib';
import type { ExportWorkerInput, ExportWorkerOutput } from '../../shared/types/pdf';

/**
 * Core assembly logic extracted for testability.
 * Loads source PDFs, copies pages in manifest order with rotations,
 * excludes deleted pages, and returns the assembled PDF bytes.
 */
export async function assemblePdf(input: ExportWorkerInput): Promise<ExportWorkerOutput> {
  try {
    const { manifest, filePaths } = input;
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
      if (!filePath) {
        return { success: false, error: `Source file not found for fileId: ${fileId}` };
      }
      if (!fs.existsSync(filePath)) {
        return { success: false, error: `File missing on disk: ${filePath}` };
      }

      const fileBytes = fs.readFileSync(filePath);
      const sourceDoc = await PDFDocument.load(fileBytes);
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

    for (const copiedPage of copiedPagesByOutputIndex) {
      outputDoc.addPage(copiedPage);
    }

    const pdfBytes = await outputDoc.save();
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
      parentPort!.postMessage(result);
    })
    .catch((err) => {
      parentPort!.postMessage({
        success: false,
        error: err instanceof Error ? err.message : 'Worker crash',
      } as ExportWorkerOutput);
    });
}
