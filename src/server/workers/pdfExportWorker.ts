import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';
import { PDFDocument, degrees } from 'pdf-lib';
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
    const loadedDocs = new Map<string, PDFDocument>();

    for (const entry of manifest) {
      if (entry.deleted) continue;

      const filePath = filePaths[entry.fileId];
      if (!filePath) {
        return { success: false, error: `Source file not found for fileId: ${entry.fileId}` };
      }

      let sourceDoc = loadedDocs.get(entry.fileId);
      if (!sourceDoc) {
        if (!fs.existsSync(filePath)) {
          return { success: false, error: `File missing on disk: ${filePath}` };
        }
        const fileBytes = fs.readFileSync(filePath);
        sourceDoc = await PDFDocument.load(fileBytes);
        loadedDocs.set(entry.fileId, sourceDoc);
      }

      if (entry.sourcePageIndex < 0 || entry.sourcePageIndex >= sourceDoc.getPageCount()) {
        return { success: false, error: `Invalid page index ${entry.sourcePageIndex} for fileId: ${entry.fileId}` };
      }

      const [copiedPage] = await outputDoc.copyPages(sourceDoc, [entry.sourcePageIndex]);

      if (entry.rotation !== 0) {
        copiedPage.setRotation(degrees(entry.rotation));
      }

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
