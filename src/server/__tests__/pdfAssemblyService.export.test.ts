/**
 * Unit tests for pdfAssemblyService.assembleAndExport and sanitizeExportFilename
 * Covers: DoD-0, DoD-2, DoD-3, NFR-security (TBI-003)
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockFindFirst = jest.fn();
const mockSet = jest.fn().mockReturnThis();
const mockWhere = jest.fn().mockResolvedValue([]);
const mockUpdate = jest.fn().mockReturnValue({ set: mockSet });

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      pdfSessions: { findFirst: mockFindFirst },
    },
    update: mockUpdate,
  },
}));

// Mock worker_threads — Worker constructor captures workerData and emits result
const mockPostMessage = jest.fn();
const mockOn = jest.fn();
const mockTerminate = jest.fn();

jest.mock('worker_threads', () => {
  const actualWt = jest.requireActual('worker_threads');
  return {
    ...actualWt,
    Worker: jest.fn().mockImplementation((_path: string, opts: any) => {
      const handlers: Record<string, Function> = {};
      const instance = {
        on: jest.fn((event: string, handler: Function) => {
          handlers[event] = handler;
        }),
        postMessage: mockPostMessage,
        terminate: mockTerminate,
      };
      // Simulate async message delivery after construction
      setTimeout(() => {
        if (handlers['message']) {
          handlers['message']({
            success: true,
            pdfBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
          });
        }
        if (handlers['exit']) {
          handlers['exit'](0);
        }
      }, 0);
      return instance;
    }),
  };
});

// Mock fs for resolveFilePath
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn((p: string) => {
      if (typeof p === 'string' && p.includes('.pdf')) return true;
      // Simulate production: compiled worker .js is present so export uses Worker
      if (typeof p === 'string' && p.includes('pdfExportWorker.js')) return true;
      return actual.existsSync(p);
    }),
    mkdirSync: jest.fn(),
  };
});

import { assembleAndExport, sanitizeExportFilename } from '../services/pdfAssemblyService';
import { PDF_ERROR_CODES } from '../../shared/types/pdf';
import type { PageManifestEntry, PdfFileMetadata } from '../../shared/types/pdf';

// ── Helpers ────────────────────────────────────────────────────────────────────

const USER_ID = 'user-abc';
const SESSION_ID = 'session-export-123';
const FILE_ID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const FILE_ID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    status: 'active',
    fileMetadata: [
      { fileId: FILE_ID_A, originalName: 'a.pdf', storedName: `${FILE_ID_A}.pdf`, sizeBytes: 1000, pageCount: 3 } as PdfFileMetadata,
      { fileId: FILE_ID_B, originalName: 'b.pdf', storedName: `${FILE_ID_B}.pdf`, sizeBytes: 2000, pageCount: 2 } as PdfFileMetadata,
    ],
    pageManifest: [
      { pageId: 'p1', fileId: FILE_ID_A, sourcePageIndex: 0, rotation: 0, deleted: false },
      { pageId: 'p2', fileId: FILE_ID_A, sourcePageIndex: 1, rotation: 90, deleted: false },
      { pageId: 'p3', fileId: FILE_ID_B, sourcePageIndex: 0, rotation: 0, deleted: true },
      { pageId: 'p4', fileId: FILE_ID_B, sourcePageIndex: 1, rotation: 180, deleted: false },
    ] as PageManifestEntry[],
    exportFilename: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2026-01-01T04:00:00Z',
    ...overrides,
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockSet.mockReturnValue({ where: mockWhere });
  mockWhere.mockResolvedValue([]);
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('assembleAndExport', () => {
  // DoD-0: returns assembled PDF as streaming download
  it('DoD-0: returns PDF bytes and filename on successful export', async () => {
    mockFindFirst.mockResolvedValue(makeSession());

    const result = await assembleAndExport(SESSION_ID, USER_ID);

    expect(result.pdfBytes).toBeInstanceOf(Uint8Array);
    expect(result.pdfBytes.length).toBeGreaterThan(0);
    expect(result.filename).toMatch(/^merged-document-\d{8}-\d{4}\.pdf$/);
  });

  // DoD-2: export spawns worker thread
  it('DoD-2: spawns Worker with filtered manifest (deleted excluded)', async () => {
    mockFindFirst.mockResolvedValue(makeSession());
    const { Worker } = require('worker_threads');

    await assembleAndExport(SESSION_ID, USER_ID);

    expect(Worker).toHaveBeenCalledTimes(1);
    const callArgs = Worker.mock.calls[0];
    expect(callArgs[0]).toContain('pdfExportWorker');
    const workerData = callArgs[1].workerData;
    // Deleted page (p3) should be filtered out
    expect(workerData.manifest).toHaveLength(3);
    expect(workerData.manifest.every((p: any) => !p.deleted)).toBe(true);
  });

  // DoD-3: error — session not found
  it('DoD-3: throws SESSION_NOT_FOUND when session does not exist', async () => {
    mockFindFirst.mockResolvedValue(undefined);

    await expect(assembleAndExport(SESSION_ID, USER_ID))
      .rejects.toMatchObject({ code: PDF_ERROR_CODES.SESSION_NOT_FOUND });
  });

  // DoD-3: error — expired session
  it('DoD-3: throws SESSION_EXPIRED for expired session', async () => {
    mockFindFirst.mockResolvedValue(makeSession({ status: 'expired' }));

    await expect(assembleAndExport(SESSION_ID, USER_ID))
      .rejects.toMatchObject({ code: PDF_ERROR_CODES.SESSION_EXPIRED });
  });

  // NFR-security: cross-user access forbidden
  it('NFR-security: throws SESSION_FORBIDDEN for cross-user access', async () => {
    mockFindFirst.mockResolvedValue(makeSession({ userId: 'other-user' }));

    await expect(assembleAndExport(SESSION_ID, USER_ID))
      .rejects.toMatchObject({ code: PDF_ERROR_CODES.SESSION_FORBIDDEN });
  });

  // DoD-3: error — no pages
  it('DoD-3: throws NO_PAGES when all pages are deleted', async () => {
    const allDeleted = makeSession({
      pageManifest: [
        { pageId: 'p1', fileId: FILE_ID_A, sourcePageIndex: 0, rotation: 0, deleted: true },
      ],
    });
    mockFindFirst.mockResolvedValue(allDeleted);

    await expect(assembleAndExport(SESSION_ID, USER_ID))
      .rejects.toMatchObject({ code: PDF_ERROR_CODES.NO_PAGES });
  });

  // DoD-0: session status updated after successful export
  it('DoD-0: updates session status to exported after success', async () => {
    mockFindFirst.mockResolvedValue(makeSession());

    await assembleAndExport(SESSION_ID, USER_ID);

    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'exported' }),
    );
  });

  // AC-2 (filename): custom filename with .pdf enforced
  it('AC-2: uses custom filename with .pdf appended if missing', async () => {
    mockFindFirst.mockResolvedValue(makeSession());

    const result = await assembleAndExport(SESSION_ID, USER_ID, 'my-report');

    expect(result.filename).toBe('my-report.pdf');
  });

  // AC-2: custom filename already has .pdf
  it('AC-2: preserves .pdf extension when already present', async () => {
    mockFindFirst.mockResolvedValue(makeSession());

    const result = await assembleAndExport(SESSION_ID, USER_ID, 'my-report.pdf');

    expect(result.filename).toBe('my-report.pdf');
  });
});

describe('sanitizeExportFilename', () => {
  // BR-008: default filename format
  it('BR-008: generates default filename in merged-document-YYYYMMDD-HHMM.pdf format', () => {
    const result = sanitizeExportFilename();
    expect(result).toMatch(/^merged-document-\d{8}-\d{4}\.pdf$/);
  });

  it('strips disallowed path characters', () => {
    expect(sanitizeExportFilename('my/report:v2.pdf')).toBe('myreportv2.pdf');
  });

  it('appends .pdf when missing', () => {
    expect(sanitizeExportFilename('report')).toBe('report.pdf');
  });

  it('falls back to default for empty string', () => {
    expect(sanitizeExportFilename('')).toMatch(/^merged-document-\d{8}-\d{4}\.pdf$/);
  });

  it('falls back to default for whitespace-only string', () => {
    expect(sanitizeExportFilename('   ')).toMatch(/^merged-document-\d{8}-\d{4}\.pdf$/);
  });

  it('truncates filenames exceeding 255 characters', () => {
    const longName = 'a'.repeat(300);
    const result = sanitizeExportFilename(longName);
    expect(result.length).toBeLessThanOrEqual(255 + 4); // +4 for .pdf
  });
});
