/**
 * Boundary tests for PDF/Word ingestion limits.
 *
 * Page limits use real PDFs generated in memory with pdf-lib. File-size limits
 * mock filesystem metadata so the suite does not need 100–250 MB fixtures.
 */

const mockFindFirst = jest.fn();
const mockWhere = jest.fn().mockResolvedValue([]);
const mockSet = jest.fn().mockReturnValue({ where: mockWhere });
const mockUpdate = jest.fn().mockReturnValue({ set: mockSet });
const mockStatSync = jest.fn();
const mockReadFile = jest.fn();
const mockRename = jest.fn().mockResolvedValue(undefined);
const mockUnlink = jest.fn().mockResolvedValue(undefined);
const mockConvert = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    query: { pdfSessions: { findFirst: mockFindFirst } },
    update: mockUpdate,
  },
}));

jest.mock('fs', () => ({
  statSync: (...args: unknown[]) => mockStatSync(...args),
  mkdirSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(true),
}));

jest.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  rename: (...args: unknown[]) => mockRename(...args),
  copyFile: jest.fn().mockResolvedValue(undefined),
  unlink: (...args: unknown[]) => mockUnlink(...args),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/documentConversionService', () => ({
  documentConversionService: { convert: mockConvert },
}));

jest.mock('../services/pdfArtifactStore', () => ({
  getPdfArtifactStore: () => ({
    putFile: jest.fn().mockResolvedValue(undefined),
    deleteFile: jest.fn().mockResolvedValue(undefined),
    deleteSessionPrefix: jest.fn().mockResolvedValue(undefined),
    exists: jest.fn().mockResolvedValue(true),
    getStream: jest.fn(),
  }),
  readPdfArtifact: jest.fn(),
  buildPdfArtifactKey: ({ userId, sessionId, fileName }: any) =>
    `${userId}/${sessionId}/${fileName}`,
}));

jest.mock('../services/pdfConversionJobService', () => ({
  enqueuePdfConversion: jest.fn(),
  enqueuePdfExport: jest.fn(),
  getPdfConversionJobs: jest.fn().mockResolvedValue([]),
  processPendingPdfJobs: jest.fn().mockResolvedValue(undefined),
  startPdfJobPoller: jest.fn(),
}));

jest.mock('worker_threads', () => ({
  Worker: jest.fn(),
}));

import { PDFDocument } from 'pdf-lib';
import {
  convertAndIngestDocx,
  validateAndIngest,
} from '../services/pdfAssemblyService';
import {
  PDF_ERROR_CODES,
  PDF_MVP_PERFORMANCE_TARGETS,
} from '../../shared/types/pdf';
import type { PageManifestEntry, PdfFileMetadata } from '../../shared/types/pdf';

const SESSION_ID = 'limit-session';
const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MB = 1024 * 1024;
const MAX_FILE_BYTES = 100 * MB;
const MAX_SESSION_BYTES = 250 * MB;

let onePagePdf: Buffer;
let fiftyPagePdf: Buffer;
let fiveHundredPagePdf: Buffer;
let fiveHundredOnePagePdf: Buffer;

async function makePdf(pageCount: number): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index++) {
    document.addPage([72, 72]);
  }
  return Buffer.from(await document.save());
}

function makeManifest(pageCount: number): PageManifestEntry[] {
  return Array.from({ length: pageCount }, (_, index) => ({
    pageId: `existing-page-${index}`,
    fileId: 'existing-file',
    sourcePageIndex: index,
    rotation: 0,
    deleted: false,
  }));
}

function makeSession(options: {
  pageCount?: number;
  existingBytes?: number;
} = {}) {
  const existingBytes = options.existingBytes ?? 0;
  const fileMetadata: PdfFileMetadata[] = existingBytes > 0
    ? [{
        fileId: 'existing-file',
        originalName: 'existing.pdf',
        storedName: 'existing-file.pdf',
        mimeType: PDF_MIME,
        sizeBytes: existingBytes,
        pageCount: options.pageCount ?? 0,
        uploadedAt: '2026-07-11T00:00:00.000Z',
      }]
    : [];

  return {
    id: SESSION_ID,
    userId: 'user-1',
    status: 'active',
    fileMetadata,
    pageManifest: makeManifest(options.pageCount ?? 0),
  };
}

describe('pdfAssemblyService ingestion limits', () => {
  beforeAll(async () => {
    [onePagePdf, fiftyPagePdf, fiveHundredPagePdf, fiveHundredOnePagePdf] = await Promise.all([
      makePdf(1),
      makePdf(PDF_MVP_PERFORMANCE_TARGETS.uploadPageCount),
      makePdf(500),
      makePdf(501),
    ]);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindFirst.mockResolvedValue(makeSession());
    mockStatSync.mockReturnValue({ size: 1024 });
    mockReadFile.mockResolvedValue(onePagePdf);
    mockConvert.mockResolvedValue(onePagePdf);
    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: mockWhere });
  });

  test('accepts a PDF containing exactly 500 pages', async () => {
    mockReadFile.mockResolvedValue(fiveHundredPagePdf);

    const result = await validateAndIngest(
      SESSION_ID,
      '/tmp/exactly-500.pdf',
      'exactly-500.pdf',
      PDF_MIME,
    );

    expect(result.status).toBe('success');
    expect(result.pageCount).toBe(500);
  });

  test(
    'NFR-performance: parses a representative 50-page PDF within the MVP target',
    async () => {
      mockReadFile.mockResolvedValue(fiftyPagePdf);

      const startedAt = performance.now();
      const result = await validateAndIngest(
        SESSION_ID,
        '/tmp/performance-50-pages.pdf',
        'performance-50-pages.pdf',
        PDF_MIME,
      );
      const durationMs = performance.now() - startedAt;

      expect(result.status).toBe('success');
      expect(result.pageCount).toBe(PDF_MVP_PERFORMANCE_TARGETS.uploadPageCount);
      expect(durationMs).toBeLessThan(
        PDF_MVP_PERFORMANCE_TARGETS.uploadAndParseMs,
      );
    },
    PDF_MVP_PERFORMANCE_TARGETS.uploadAndParseMs + 5_000,
  );

  test('rejects a PDF containing 501 pages', async () => {
    mockReadFile.mockResolvedValue(fiveHundredOnePagePdf);

    const result = await validateAndIngest(
      SESSION_ID,
      '/tmp/over-500.pdf',
      'over-500.pdf',
      PDF_MIME,
    );

    expect(result.status).toBe('error');
    expect(result.error?.code).toBe(PDF_ERROR_CODES.SESSION_PAGES_EXCEEDED);
  });

  test('accepts a PDF that brings the session total to exactly 500 pages', async () => {
    mockFindFirst.mockResolvedValue(makeSession({ pageCount: 499 }));

    const result = await validateAndIngest(
      SESSION_ID,
      '/tmp/final-page.pdf',
      'final-page.pdf',
      PDF_MIME,
    );

    expect(result.status).toBe('success');
    expect(result.pageCount).toBe(1);
  });

  test('rejects a PDF that brings the session total above 500 pages', async () => {
    mockFindFirst.mockResolvedValue(makeSession({ pageCount: 500 }));

    const result = await validateAndIngest(
      SESSION_ID,
      '/tmp/page-501.pdf',
      'page-501.pdf',
      PDF_MIME,
    );

    expect(result.status).toBe('error');
    expect(result.error?.code).toBe(PDF_ERROR_CODES.SESSION_PAGES_EXCEEDED);
  });

  test('accepts a PDF whose file size is exactly 100 MB', async () => {
    mockStatSync.mockReturnValue({ size: MAX_FILE_BYTES });

    const result = await validateAndIngest(
      SESSION_ID,
      '/tmp/exactly-100mb.pdf',
      'exactly-100mb.pdf',
      PDF_MIME,
    );

    expect(result.status).toBe('success');
    expect(result.sizeBytes).toBe(MAX_FILE_BYTES);
  });

  test('rejects a PDF whose file size is 100 MB plus one byte', async () => {
    mockStatSync.mockReturnValue({ size: MAX_FILE_BYTES + 1 });

    const result = await validateAndIngest(
      SESSION_ID,
      '/tmp/over-100mb.pdf',
      'over-100mb.pdf',
      PDF_MIME,
    );

    expect(result.status).toBe('error');
    expect(result.error?.code).toBe(PDF_ERROR_CODES.FILE_TOO_LARGE);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  test('accepts a PDF that brings the session total to exactly 250 MB', async () => {
    mockFindFirst.mockResolvedValue(
      makeSession({ existingBytes: MAX_SESSION_BYTES - MAX_FILE_BYTES }),
    );
    mockStatSync.mockReturnValue({ size: MAX_FILE_BYTES });

    const result = await validateAndIngest(
      SESSION_ID,
      '/tmp/session-exact.pdf',
      'session-exact.pdf',
      PDF_MIME,
    );

    expect(result.status).toBe('success');
  });

  test('rejects a PDF that brings the session total above 250 MB', async () => {
    mockFindFirst.mockResolvedValue(
      makeSession({ existingBytes: MAX_SESSION_BYTES - MAX_FILE_BYTES + 1 }),
    );
    mockStatSync.mockReturnValue({ size: MAX_FILE_BYTES });

    const result = await validateAndIngest(
      SESSION_ID,
      '/tmp/session-over.pdf',
      'session-over.pdf',
      PDF_MIME,
    );

    expect(result.status).toBe('error');
    expect(result.error?.code).toBe(PDF_ERROR_CODES.SESSION_SIZE_EXCEEDED);
  });

  test('accepts a converted Word document containing exactly 500 pages', async () => {
    mockReadFile.mockResolvedValue(Buffer.from('docx-input'));
    mockConvert.mockResolvedValue(fiveHundredPagePdf);

    const result = await convertAndIngestDocx(
      SESSION_ID,
      '/tmp/exactly-500.docx',
      'exactly-500.docx',
      DOCX_MIME,
    );

    expect(result.status).toBe('success');
    expect(result.pageCount).toBe(500);
  });

  test('rejects a converted Word document containing 501 pages', async () => {
    mockReadFile.mockResolvedValue(Buffer.from('docx-input'));
    mockConvert.mockResolvedValue(fiveHundredOnePagePdf);

    const result = await convertAndIngestDocx(
      SESSION_ID,
      '/tmp/over-500.docx',
      'over-500.docx',
      DOCX_MIME,
    );

    expect(result.status).toBe('error');
    expect(result.error?.code).toBe(PDF_ERROR_CODES.SESSION_PAGES_EXCEEDED);
  });

  test('accepts a Word source file whose size is exactly 100 MB', async () => {
    mockReadFile.mockResolvedValue(Buffer.from('docx-input'));
    mockStatSync.mockReturnValue({ size: MAX_FILE_BYTES });

    const result = await convertAndIngestDocx(
      SESSION_ID,
      '/tmp/exactly-100mb.docx',
      'exactly-100mb.docx',
      DOCX_MIME,
    );

    expect(result.status).toBe('success');
    expect(mockConvert).toHaveBeenCalledTimes(1);
  });

  test('rejects a Word source file whose size is 100 MB plus one byte', async () => {
    mockReadFile.mockResolvedValue(Buffer.from('docx-input'));
    mockStatSync.mockReturnValue({ size: MAX_FILE_BYTES + 1 });

    const result = await convertAndIngestDocx(
      SESSION_ID,
      '/tmp/over-100mb.docx',
      'over-100mb.docx',
      DOCX_MIME,
    );

    expect(result.status).toBe('error');
    expect(result.error?.code).toBe(PDF_ERROR_CODES.FILE_TOO_LARGE);
    expect(mockConvert).not.toHaveBeenCalled();
  });

  test('accepts a converted Word document that brings the session to 500 pages', async () => {
    mockFindFirst.mockResolvedValue(makeSession({ pageCount: 499 }));
    mockReadFile.mockResolvedValue(Buffer.from('docx-input'));

    const result = await convertAndIngestDocx(
      SESSION_ID,
      '/tmp/final-word-page.docx',
      'final-word-page.docx',
      DOCX_MIME,
    );

    expect(result.status).toBe('success');
  });

  test('rejects a converted Word document that brings the session above 500 pages', async () => {
    mockFindFirst.mockResolvedValue(makeSession({ pageCount: 500 }));
    mockReadFile.mockResolvedValue(Buffer.from('docx-input'));

    const result = await convertAndIngestDocx(
      SESSION_ID,
      '/tmp/word-page-501.docx',
      'word-page-501.docx',
      DOCX_MIME,
    );

    expect(result.status).toBe('error');
    expect(result.error?.code).toBe(PDF_ERROR_CODES.SESSION_PAGES_EXCEEDED);
  });
});
