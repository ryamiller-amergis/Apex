/**
 * Unit tests for pdfAssemblyService — .docx upload routing and conversion.
 * Covers: DoD-2, DoD-3 (TBI-004); AC-0, AC-1, AC-3, NFR-security, BR-007 (PBI-012)
 *
 * Mocks: documentConversionService, Drizzle db, fs, pdf-lib
 */

// ── Mock state ──────────────────────────────────────────────────────────────────

const mockConvert = jest.fn();
const mockFindFirst = jest.fn();
const mockUpdate = jest.fn().mockReturnValue({
  set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
});

// ── Mocks ───────────────────────────────────────────────────────────────────────

jest.mock('../services/documentConversionService', () => ({
  documentConversionService: { convert: mockConvert },
  DocumentConversionService: jest.fn(),
  ConversionError: class ConversionError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  },
}));

jest.mock('../db/drizzle', () => ({
  db: {
    query: { pdfSessions: { findFirst: mockFindFirst } },
    update: mockUpdate,
  },
}));

jest.mock('pdf-lib', () => ({
  PDFDocument: {
    load: jest.fn().mockResolvedValue({
      getPageCount: jest.fn().mockReturnValue(5),
      isEncrypted: false,
    }),
  },
}));

// Mock fs for file operations
const mockStatSync = jest.fn().mockReturnValue({ size: 1024 });
const mockReadFile = jest.fn();
const mockRename = jest.fn().mockResolvedValue(undefined);
const mockWriteFile = jest.fn().mockResolvedValue(undefined);
const mockUnlink = jest.fn().mockResolvedValue(undefined);
const mockMkdirSync = jest.fn();
const mockExistsSync = jest.fn().mockReturnValue(true);

jest.mock('fs', () => ({
  statSync: (...args: any[]) => mockStatSync(...args),
  mkdirSync: (...args: any[]) => mockMkdirSync(...args),
  existsSync: (...args: any[]) => mockExistsSync(...args),
}));

jest.mock('fs/promises', () => ({
  readFile: (...args: any[]) => mockReadFile(...args),
  rename: (...args: any[]) => mockRename(...args),
  writeFile: (...args: any[]) => mockWriteFile(...args),
  unlink: (...args: any[]) => mockUnlink(...args),
  copyFile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('worker_threads', () => ({
  Worker: jest.fn(),
}));

// ── Imports ─────────────────────────────────────────────────────────────────────

import { validateAndIngest } from '../services/pdfAssemblyService';
import { PDF_ERROR_CODES } from '../../shared/types/pdf';

// ── Fixtures ────────────────────────────────────────────────────────────────────

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME = 'application/pdf';
const SESSION_ID = 'test-session-id';

const mockSession = {
  id: SESSION_ID,
  userId: 'user-1',
  status: 'active',
  fileMetadata: [],
  pageManifest: [],
};

const validPdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x35]);
const docxBuffer = Buffer.from('fake-docx-content');

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('pdfAssemblyService — .docx upload routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindFirst.mockResolvedValue({ ...mockSession });
    mockReadFile.mockResolvedValue(docxBuffer);
    mockConvert.mockResolvedValue(validPdfBuffer);
    mockStatSync.mockReturnValue({ size: 1024 });
  });

  // ── DoD-2: upload endpoint detects .docx and routes through conversion ──────

  test('DoD-2: calls documentConversionService.convert for .docx MIME type', async () => {
    const result = await validateAndIngest(SESSION_ID, '/tmp/upload.docx', 'report.docx', DOCX_MIME);

    expect(mockConvert).toHaveBeenCalledTimes(1);
    expect(mockConvert).toHaveBeenCalledWith(docxBuffer, 'report.docx');
    expect(result.status).toBe('success');
  });

  test('AC-0: recognizes a .docx filename when drag-and-drop supplies no MIME type', async () => {
    const result = await validateAndIngest(
      SESSION_ID,
      '/tmp/upload.docx',
      'report.docx',
      '',
    );

    expect(mockConvert).toHaveBeenCalledWith(docxBuffer, 'report.docx');
    expect(result.status).toBe('success');
  });

  test('DoD-2: does NOT call documentConversionService.convert for .pdf MIME type', async () => {
    mockReadFile.mockResolvedValue(validPdfBuffer);

    await validateAndIngest(SESSION_ID, '/tmp/upload.pdf', 'doc.pdf', PDF_MIME);

    expect(mockConvert).not.toHaveBeenCalled();
  });

  // ── DoD-3: file_metadata records convertedFrom ────────────────────────────────

  test('DoD-3: returns convertedFrom in FileUploadResult for .docx', async () => {
    const result = await validateAndIngest(SESSION_ID, '/tmp/upload.docx', 'notes.docx', DOCX_MIME);

    expect(result.status).toBe('success');
    expect(result.convertedFrom).toBe('notes.docx');
  });

  test('DoD-3: stores convertedFrom in session file_metadata', async () => {
    await validateAndIngest(SESSION_ID, '/tmp/upload.docx', 'notes.docx', DOCX_MIME);

    const setCall = mockUpdate.mock.results[0]?.value.set;
    expect(setCall).toHaveBeenCalled();
    const setArg = setCall.mock.calls[0][0];
    const storedMeta = setArg.fileMetadata;
    expect(storedMeta).toBeDefined();
    const converted = storedMeta.find((f: any) => f.convertedFrom);
    expect(converted).toBeDefined();
    expect(converted.convertedFrom).toBe('notes.docx');
    expect(converted.originalMimeType).toBe(DOCX_MIME);
  });

  // ── AC-0: successful upload returns success with pageCount ──────────────────

  test('AC-0: successful .docx upload returns status success with pageCount', async () => {
    const result = await validateAndIngest(SESSION_ID, '/tmp/upload.docx', 'doc.docx', DOCX_MIME);

    expect(result.status).toBe('success');
    expect(result.pageCount).toBe(5);
    expect(result.fileId).toBeDefined();
  });

  // ── AC-1: failed conversion returns actionable error ────────────────────────

  test('AC-1: returns CONVERSION_FAILED with actionable message when conversion fails', async () => {
    const convError = new Error(
      'This Word document could not be converted. Try saving it as PDF from Word directly and uploading the PDF.',
    );
    (convError as any).code = PDF_ERROR_CODES.CONVERSION_FAILED;
    mockConvert.mockRejectedValue(convError);

    const result = await validateAndIngest(SESSION_ID, '/tmp/upload.docx', 'bad.docx', DOCX_MIME);

    expect(result.status).toBe('error');
    expect(result.error?.code).toBe(PDF_ERROR_CODES.CONVERSION_FAILED);
    expect(result.error?.message).toBe(
      'This Word document could not be converted. Try saving it as PDF from Word directly and uploading the PDF.',
    );
  });

  test('AC-1: returns CONVERSION_TIMEOUT when conversion times out', async () => {
    const timeoutError = new Error('Timeout');
    (timeoutError as any).code = PDF_ERROR_CODES.CONVERSION_TIMEOUT;
    mockConvert.mockRejectedValue(timeoutError);

    const result = await validateAndIngest(SESSION_ID, '/tmp/upload.docx', 'slow.docx', DOCX_MIME);

    expect(result.status).toBe('error');
    expect(result.error?.code).toBe(PDF_ERROR_CODES.CONVERSION_TIMEOUT);
  });

  // ── AC-3 / BR-007: converted pages stored as first-class PDF ────────────────

  test('AC-3: converted file stored as .pdf with standard manifest entries', async () => {
    const result = await validateAndIngest(SESSION_ID, '/tmp/upload.docx', 'report.docx', DOCX_MIME);

    expect(result.status).toBe('success');
    // File is stored as PDF (writeFile called with PDF buffer)
    expect(mockWriteFile).toHaveBeenCalled();
    const writtenBuffer = mockWriteFile.mock.calls[0][1];
    expect(Buffer.isBuffer(writtenBuffer) || writtenBuffer instanceof Uint8Array).toBe(true);

    // Manifest entries are created
    const setCall = mockUpdate.mock.results[0]?.value.set;
    const setArg = setCall.mock.calls[0][0];
    expect(setArg.pageManifest).toBeDefined();
    expect(setArg.pageManifest.length).toBe(5);
    // Each manifest entry has rotation 0 and deleted false (same as native PDF)
    for (const entry of setArg.pageManifest) {
      expect(entry.rotation).toBe(0);
      expect(entry.deleted).toBe(false);
    }
  });

  // ── NFR-security: original .docx deleted after conversion ───────────────────

  test('NFR-security: deletes original .docx from disk after successful conversion', async () => {
    await validateAndIngest(SESSION_ID, '/tmp/upload.docx', 'report.docx', DOCX_MIME);

    expect(mockUnlink).toHaveBeenCalledWith('/tmp/upload.docx');
  });

  test('NFR-security: deletes original .docx from disk even when conversion fails', async () => {
    mockConvert.mockRejectedValue(new Error('Conversion failed'));

    await validateAndIngest(SESSION_ID, '/tmp/upload.docx', 'bad.docx', DOCX_MIME);

    expect(mockUnlink).toHaveBeenCalledWith('/tmp/upload.docx');
  });
});
