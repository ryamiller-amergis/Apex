/**
 * Unit tests for the pdfExportWorker assembly logic.
 * Tests the exported assemblePdf function directly (not as a worker thread).
 * Covers: DoD-1 (manifest order, rotations, deleted exclusion), DoD-3 (missing file error)
 */

const mockReadPdfArtifact = jest.fn();
const mockArtifactPut = jest.fn();

jest.mock('../services/pdfArtifactStore', () => ({
  readPdfArtifact: (...args: unknown[]) => mockReadPdfArtifact(...args),
  getPdfArtifactStore: () => ({
    putFile: (...args: unknown[]) => mockArtifactPut(...args),
  }),
}));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { PDFDocument, degrees } from 'pdf-lib';
import { assemblePdf } from '../workers/pdfExportWorker';
import {
  PDF_MVP_PERFORMANCE_TARGETS,
  type ExportWorkerInput,
  type OverlayTextBox,
  type PageManifestEntry,
} from '../../shared/types/pdf';

// ── Helpers ────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-export-test-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createTestPdf(pageCount: number, filePath: string): Promise<void> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    doc.addPage([612, 792]); // standard letter size
  }
  const bytes = await doc.save();
  fs.writeFileSync(filePath, bytes);
}

function makeOverlay(
  pageId: string,
  overrides: Partial<OverlayTextBox> = {},
): OverlayTextBox {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    pageId,
    x: 10,
    y: 10,
    width: 30,
    height: 10,
    text: 'Burned overlay',
    fontFamily: 'Helvetica',
    fontSize: 14,
    bold: false,
    italic: false,
    color: '#000000',
    horizontalAlign: 'left',
    verticalAlign: 'top',
    opacity: 100,
    rotation: 0,
    listStyle: 'none',
    linkUrl: null,
    linkDisplayText: null,
    zIndex: 1,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('assemblePdf (worker core logic)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // DoD-1: pages assembled in manifest order
  it('DoD-1: assembles pages in manifest order from multiple source files', async () => {
    const fileA = path.join(tmpDir, 'source-a.pdf');
    const fileB = path.join(tmpDir, 'source-b.pdf');
    await createTestPdf(3, fileA);
    await createTestPdf(2, fileB);

    const input: ExportWorkerInput = {
      manifest: [
        { pageId: 'p1', fileId: 'fileA', sourcePageIndex: 2, rotation: 0, deleted: false },
        { pageId: 'p2', fileId: 'fileB', sourcePageIndex: 0, rotation: 0, deleted: false },
        { pageId: 'p3', fileId: 'fileA', sourcePageIndex: 0, rotation: 0, deleted: false },
      ],
      filePaths: { fileA: fileA, fileB: fileB },
    };

    const result = await assemblePdf(input);

    expect(result.success).toBe(true);
    expect(result.pdfBytes).toBeDefined();

    const outputDoc = await PDFDocument.load(result.pdfBytes!);
    expect(outputDoc.getPageCount()).toBe(3);
  });

  // DoD-1: rotations applied
  it('DoD-1: applies rotation to copied pages', async () => {
    const file = path.join(tmpDir, 'rotation-test.pdf');
    await createTestPdf(2, file);

    const input: ExportWorkerInput = {
      manifest: [
        { pageId: 'p1', fileId: 'f1', sourcePageIndex: 0, rotation: 90, deleted: false },
        { pageId: 'p2', fileId: 'f1', sourcePageIndex: 1, rotation: 270, deleted: false },
      ],
      filePaths: { f1: file },
    };

    const result = await assemblePdf(input);
    expect(result.success).toBe(true);

    const outputDoc = await PDFDocument.load(result.pdfBytes!);
    expect(outputDoc.getPage(0).getRotation().angle).toBe(90);
    expect(outputDoc.getPage(1).getRotation().angle).toBe(270);
  });

  it('reads source artifacts and writes the result through the store', async () => {
    const source = await PDFDocument.create();
    source.addPage([612, 792]);
    mockReadPdfArtifact.mockResolvedValue(Buffer.from(await source.save()));
    mockArtifactPut.mockResolvedValue(undefined);
    const outputRef = {
      userId: 'user-1',
      sessionId: 'session-1',
      fileName: 'job-1.pdf',
    };

    const result = await assemblePdf({
      manifest: [{
        pageId: 'p1',
        fileId: 'file-1',
        sourcePageIndex: 0,
        rotation: 0,
        deleted: false,
      }],
      artifactFiles: {
        'file-1': {
          userId: 'user-1',
          sessionId: 'session-1',
          fileName: 'file-1.pdf',
        },
      },
      outputRef,
    });

    expect(result.success).toBe(true);
    expect(mockReadPdfArtifact).toHaveBeenCalledWith(expect.objectContaining({
      fileName: 'file-1.pdf',
    }));
    expect(mockArtifactPut).toHaveBeenCalledWith(outputRef, expect.any(Uint8Array));
  });

  it('VT-04: burns only the included page overlays into an extraction', async () => {
    const file = path.join(tmpDir, 'overlay-extraction.pdf');
    await createTestPdf(2, file);

    const result = await assemblePdf({
      manifest: [
        {
          pageId: 'included-page',
          fileId: 'f1',
          sourcePageIndex: 1,
          rotation: 0,
          deleted: false,
        },
      ],
      overlays: [
        makeOverlay('included-page', {
          linkUrl: 'https://example.com/included',
        }),
      ],
      filePaths: { f1: file },
    });

    expect(result.success).toBe(true);
    const outputDoc = await PDFDocument.load(result.pdfBytes!);
    expect(outputDoc.getPageCount()).toBe(1);
    expect(outputDoc.getPage(0).node.Annots()?.size()).toBe(1);
  });

  // DoD-1: deleted pages excluded
  it('DoD-1: excludes deleted pages from output', async () => {
    const file = path.join(tmpDir, 'delete-test.pdf');
    await createTestPdf(3, file);

    const input: ExportWorkerInput = {
      manifest: [
        { pageId: 'p1', fileId: 'f1', sourcePageIndex: 0, rotation: 0, deleted: false },
        { pageId: 'p2', fileId: 'f1', sourcePageIndex: 1, rotation: 0, deleted: true },
        { pageId: 'p3', fileId: 'f1', sourcePageIndex: 2, rotation: 0, deleted: false },
      ],
      filePaths: { f1: file },
    };

    const result = await assemblePdf(input);
    expect(result.success).toBe(true);

    const outputDoc = await PDFDocument.load(result.pdfBytes!);
    expect(outputDoc.getPageCount()).toBe(2);
  });

  // DoD-3: missing file on disk
  it('DoD-3: returns error when source file is missing on disk', async () => {
    const input: ExportWorkerInput = {
      manifest: [
        { pageId: 'p1', fileId: 'missing', sourcePageIndex: 0, rotation: 0, deleted: false },
      ],
      filePaths: { missing: path.join(tmpDir, 'does-not-exist.pdf') },
    };

    const result = await assemblePdf(input);
    expect(result.success).toBe(false);
    expect(result.error).toContain('missing');
  });

  // DoD-1: zero rotation leaves page unchanged
  it('DoD-1: zero rotation does not alter page rotation', async () => {
    const file = path.join(tmpDir, 'no-rotation.pdf');
    await createTestPdf(1, file);

    const input: ExportWorkerInput = {
      manifest: [
        { pageId: 'p1', fileId: 'f1', sourcePageIndex: 0, rotation: 0, deleted: false },
      ],
      filePaths: { f1: file },
    };

    const result = await assemblePdf(input);
    expect(result.success).toBe(true);

    const outputDoc = await PDFDocument.load(result.pdfBytes!);
    expect(outputDoc.getPage(0).getRotation().angle).toBe(0);
  });

  // Edge case: all entries deleted — worker still succeeds (service layer prevents this)
  it('succeeds when all manifest entries are deleted', async () => {
    const file = path.join(tmpDir, 'all-deleted.pdf');
    await createTestPdf(1, file);

    const input: ExportWorkerInput = {
      manifest: [
        { pageId: 'p1', fileId: 'f1', sourcePageIndex: 0, rotation: 0, deleted: true },
      ],
      filePaths: { f1: file },
    };

    const result = await assemblePdf(input);
    expect(result.success).toBe(true);
    expect(result.pdfBytes).toBeDefined();
  });

  it(
    'NFR-performance: assembles a representative 100-page PDF within the MVP target',
    async () => {
      const file = path.join(tmpDir, 'performance-100-pages.pdf');
      await createTestPdf(PDF_MVP_PERFORMANCE_TARGETS.exportPageCount, file);
      const manifest: PageManifestEntry[] = Array.from(
        { length: PDF_MVP_PERFORMANCE_TARGETS.exportPageCount },
        (_, index) => ({
          pageId: `performance-page-${index}`,
          fileId: 'performance-file',
          sourcePageIndex: index,
          rotation: 0,
          deleted: false,
        }),
      );

      const startedAt = performance.now();
      const result = await assemblePdf({
        manifest,
        filePaths: { 'performance-file': file },
      });
      const durationMs = performance.now() - startedAt;

      expect(result.success).toBe(true);
      expect(durationMs).toBeLessThan(
        PDF_MVP_PERFORMANCE_TARGETS.assembleAndExportMs,
      );

      const outputDoc = await PDFDocument.load(result.pdfBytes!);
      expect(outputDoc.getPageCount()).toBe(
        PDF_MVP_PERFORMANCE_TARGETS.exportPageCount,
      );
    },
    PDF_MVP_PERFORMANCE_TARGETS.assembleAndExportMs + 5_000,
  );
});
