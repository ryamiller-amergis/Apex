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
import {
  countEditableFields,
  createMultilineFieldPdf,
  createPlainPdf,
  createReadOnlyFieldPdf,
  createRepeatedFieldNamePdf,
  createRotatedPageWithFieldPdf,
  createSingleFieldPdf,
} from './helpers/pdfTestFixtures';

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

// ── AcroForm fill/flatten proof (hard gate for form-filling feature) ────────────
//
// These tests prove the strategy required by the PDF form-filling plan:
//   setText → updateAppearances → flatten → copyPages
// The assembled output must (a) have no editable fields and (b) preserve values.
//
// NOTE: assemblePdf itself does NOT yet fill/flatten — that belongs to the
// pdfFormService helpers added in the model-persistence / server-form-catalog tasks.
// These tests exercise the fill+flatten step in isolation and verify the
// output is then safe to pass to assemblePdf via fileBytes.

describe('AcroForm fill/flatten strategy (fixture proof)', () => {
  // FORM-1: Single text field — fill, flatten, assemble; output has no editable fields
  it('FORM-1: fills a single text field and flattens it before assembly', async () => {
    const sourceBytes = await createSingleFieldPdf();
    const sourceDoc = await PDFDocument.load(sourceBytes);
    const form = sourceDoc.getForm();
    form.getTextField('firstName').setText('Jane Doe');
    form.flatten();
    const flatBytes = new Uint8Array(await sourceDoc.save());

    // flatBytes must have no editable form fields
    expect(await countEditableFields(flatBytes)).toBe(0);

    // assembling the flattened bytes via fileBytes must succeed
    const result = await assemblePdf({
      manifest: [{ pageId: 'p1', fileId: 'f1', sourcePageIndex: 0, rotation: 0, deleted: false }],
      fileBytes: { f1: flatBytes },
    });
    expect(result.success).toBe(true);

    const outputDoc = await PDFDocument.load(result.pdfBytes!);
    expect(outputDoc.getPageCount()).toBe(1);
    expect(await countEditableFields(result.pdfBytes!)).toBe(0);
  });

  // FORM-2: Multiline field — fill, flatten, assemble; value survives reordering
  it('FORM-2: fills a multiline field and preserves it after page reorder', async () => {
    // Two-page PDF: page 0 has the form field, page 1 is blank.
    const doc = await PDFDocument.create();
    const formPage = doc.addPage([612, 792]);
    doc.addPage([612, 792]);
    const form = doc.getForm();
    const field = form.createTextField('notes');
    field.enableMultiline();
    field.setText('');
    field.addToPage(formPage, { x: 72, y: 500, width: 400, height: 100 });
    const sourceBytes = new Uint8Array(await doc.save());

    const sourceDoc = await PDFDocument.load(sourceBytes);
    sourceDoc.getForm().getTextField('notes').setText('Line 1\nLine 2');
    sourceDoc.getForm().flatten();
    const flatBytes = new Uint8Array(await sourceDoc.save());

    expect(await countEditableFields(flatBytes)).toBe(0);

    // Reorder: export page 1 first (blank), then page 0 (form page)
    const result = await assemblePdf({
      manifest: [
        { pageId: 'blank', fileId: 'f1', sourcePageIndex: 1, rotation: 0, deleted: false },
        { pageId: 'form', fileId: 'f1', sourcePageIndex: 0, rotation: 0, deleted: false },
      ],
      fileBytes: { f1: flatBytes },
    });
    expect(result.success).toBe(true);
    expect(await countEditableFields(result.pdfBytes!)).toBe(0);
    const outputDoc = await PDFDocument.load(result.pdfBytes!);
    expect(outputDoc.getPageCount()).toBe(2);
  });

  // FORM-3: Read-only field — flatten must not remove its visual content
  it('FORM-3: flattening a read-only field removes the widget but retains its visual', async () => {
    const sourceBytes = await createReadOnlyFieldPdf();
    const sourceDoc = await PDFDocument.load(sourceBytes);
    sourceDoc.getForm().flatten();
    const flatBytes = new Uint8Array(await sourceDoc.save());

    // No interactive fields remain
    expect(await countEditableFields(flatBytes)).toBe(0);

    const result = await assemblePdf({
      manifest: [{ pageId: 'p1', fileId: 'f1', sourcePageIndex: 0, rotation: 0, deleted: false }],
      fileBytes: { f1: flatBytes },
    });
    expect(result.success).toBe(true);
  });

  // FORM-4: Repeated field name — setting value once must propagate to all widgets
  it('FORM-4: repeated field name on two pages — both widgets carry the filled value', async () => {
    const sourceBytes = await createRepeatedFieldNamePdf();
    const sourceDoc = await PDFDocument.load(sourceBytes);
    const form = sourceDoc.getForm();
    form.getTextField('sharedField').setText('Shared value');
    form.flatten();
    const flatBytes = new Uint8Array(await sourceDoc.save());

    expect(await countEditableFields(flatBytes)).toBe(0);

    const result = await assemblePdf({
      manifest: [
        { pageId: 'p0', fileId: 'f1', sourcePageIndex: 0, rotation: 0, deleted: false },
        { pageId: 'p1', fileId: 'f1', sourcePageIndex: 1, rotation: 0, deleted: false },
      ],
      fileBytes: { f1: flatBytes },
    });
    expect(result.success).toBe(true);
    expect(await countEditableFields(result.pdfBytes!)).toBe(0);
    expect((await PDFDocument.load(result.pdfBytes!)).getPageCount()).toBe(2);
  });

  // FORM-5: Selected-page export — only chosen pages included, fields still flat
  it('FORM-5: selected-page export with form retains flatness and correct page count', async () => {
    const sourceBytes = await createRepeatedFieldNamePdf();
    const sourceDoc = await PDFDocument.load(sourceBytes);
    sourceDoc.getForm().getTextField('sharedField').setText('Selected only');
    sourceDoc.getForm().flatten();
    const flatBytes = new Uint8Array(await sourceDoc.save());

    // Export only page 1 (index 1), skip page 0
    const result = await assemblePdf({
      manifest: [
        { pageId: 'p0', fileId: 'f1', sourcePageIndex: 0, rotation: 0, deleted: true },
        { pageId: 'p1', fileId: 'f1', sourcePageIndex: 1, rotation: 0, deleted: false },
      ],
      fileBytes: { f1: flatBytes },
    });
    expect(result.success).toBe(true);
    expect(await countEditableFields(result.pdfBytes!)).toBe(0);
    expect((await PDFDocument.load(result.pdfBytes!)).getPageCount()).toBe(1);
  });

  // FORM-6: Rotated-page fixture — rotation survives fill → flatten → copyPages
  it('FORM-6: rotated page with a form field retains rotation after fill/flatten/assemble', async () => {
    const sourceBytes = await createRotatedPageWithFieldPdf();
    const sourceDoc = await PDFDocument.load(sourceBytes);
    sourceDoc.getForm().getTextField('rotatedField').setText('Rotated value');
    sourceDoc.getForm().flatten();
    const flatBytes = new Uint8Array(await sourceDoc.save());

    const result = await assemblePdf({
      manifest: [
        { pageId: 'p1', fileId: 'f1', sourcePageIndex: 0, rotation: 90, deleted: false },
      ],
      fileBytes: { f1: flatBytes },
    });
    expect(result.success).toBe(true);
    expect(await countEditableFields(result.pdfBytes!)).toBe(0);

    const outputDoc = await PDFDocument.load(result.pdfBytes!);
    expect(outputDoc.getPage(0).getRotation().angle).toBe(90);
  });

  // FORM-7: Mixed source — form PDF + plain PDF in one assembly; both are flat
  it('FORM-7: assembles a flattened form PDF alongside a plain PDF with no field leakage', async () => {
    const formBytes = await createSingleFieldPdf();
    const formDoc = await PDFDocument.load(formBytes);
    formDoc.getForm().getTextField('firstName').setText('Mixed test');
    formDoc.getForm().flatten();
    const flatFormBytes = new Uint8Array(await formDoc.save());

    const plainBytes = await createPlainPdf(1);

    const result = await assemblePdf({
      manifest: [
        { pageId: 'form-page', fileId: 'form', sourcePageIndex: 0, rotation: 0, deleted: false },
        { pageId: 'plain-page', fileId: 'plain', sourcePageIndex: 0, rotation: 0, deleted: false },
      ],
      fileBytes: { form: flatFormBytes, plain: new Uint8Array(plainBytes) },
    });
    expect(result.success).toBe(true);
    expect(await countEditableFields(result.pdfBytes!)).toBe(0);
    expect((await PDFDocument.load(result.pdfBytes!)).getPageCount()).toBe(2);
  });
});

// ── End-to-end: form fill + signature burn-in ─────────────────────────────────

describe('Export with form values and signature overlays', () => {
  // Known-good 1×1 transparent PNG (base64-encoded) from Node.js canvas.
  // Generated from: createCanvas(1,1).toBuffer('image/png')
  // This is a conformant PNG that pdf-lib can embed.
  const MINIMAL_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  function makeMinimalPng(): Buffer {
    return Buffer.from(MINIMAL_PNG_B64, 'base64');
  }

  it('SIG-1: assembles a form field + signature overlay without errors', async () => {
    const pngBuf = makeMinimalPng();
    // Mock the artifact read to return the PNG for the signature asset
    mockReadPdfArtifact.mockResolvedValue(pngBuf);

    const sourceBytes = await createSingleFieldPdf();

    const result = await assemblePdf({
      manifest: [{ pageId: 'p1', fileId: 'f1', sourcePageIndex: 0, rotation: 0, deleted: false }],
      fileBytes: { f1: new Uint8Array(sourceBytes) },
      formFieldValues: [{ fileId: 'f1', fieldName: 'firstName', value: 'Jane Doe' }],
      signatureOverlays: [{
        id: 'sig-1',
        pageId: 'p1',
        assetId: 'asset-uuid',
        x: 10,
        y: 10,
        width: 30,
        height: 15,
        rotation: 0,
        opacity: 100,
        zIndex: 1,
      }],
      signatureArtifacts: {
        'asset-uuid': { userId: 'u1', sessionId: 's1', fileName: 'sig-asset-uuid.png' },
      },
    });

    expect(result.success).toBe(true);
    expect(await countEditableFields(result.pdfBytes!)).toBe(0);
  });

  it('SIG-2: returns an error when a referenced signature asset is not in the artifacts map', async () => {
    const sourceBytes = await createPlainPdf(1);

    const result = await assemblePdf({
      manifest: [{ pageId: 'p1', fileId: 'f1', sourcePageIndex: 0, rotation: 0, deleted: false }],
      fileBytes: { f1: new Uint8Array(sourceBytes) },
      signatureOverlays: [{
        id: 'sig-1',
        pageId: 'p1',
        assetId: 'missing-uuid',
        x: 10,
        y: 10,
        width: 20,
        height: 10,
        rotation: 0,
        opacity: 100,
        zIndex: 1,
      }],
      signatureArtifacts: {}, // deliberate — missing-uuid not present
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/missing/i);
  });

  it('SIG-3: a deleted page with a signature overlay is excluded from export', async () => {
    const pngBuf = makeMinimalPng();
    mockReadPdfArtifact.mockResolvedValue(pngBuf);

    const sourceBytes = await createPlainPdf(2);

    const result = await assemblePdf({
      manifest: [
        { pageId: 'p0', fileId: 'f1', sourcePageIndex: 0, rotation: 0, deleted: true },
        { pageId: 'p1', fileId: 'f1', sourcePageIndex: 1, rotation: 0, deleted: false },
      ],
      fileBytes: { f1: new Uint8Array(sourceBytes) },
      signatureOverlays: [{
        id: 'sig-del',
        pageId: 'p0', // belongs to the deleted page — must be skipped
        assetId: 'asset-uuid',
        x: 5,
        y: 5,
        width: 20,
        height: 10,
        rotation: 0,
        opacity: 100,
        zIndex: 1,
      }],
      signatureArtifacts: {
        'asset-uuid': { userId: 'u1', sessionId: 's1', fileName: 'sig-asset-uuid.png' },
      },
    });

    // The deleted page's overlay is on a page not included in the export;
    // assemblePdf should succeed because the overlay is filtered out before embed.
    expect(result.success).toBe(true);
    expect((await PDFDocument.load(result.pdfBytes!)).getPageCount()).toBe(1);
    // readPdfArtifact must NOT have been called because no active overlay references that asset
    expect(mockReadPdfArtifact).not.toHaveBeenCalled();
  });

  afterEach(() => {
    mockReadPdfArtifact.mockReset();
  });
});
