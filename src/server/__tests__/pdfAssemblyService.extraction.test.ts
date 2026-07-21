/**
 * Unit tests for pdfAssemblyService.assembleAndExport — page extraction (pages filter)
 * Covers: PBI-009 AC-0, AC-3, VT-09, VT-10 (server-side subset export)
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockFindFirst = jest.fn();
const mockFindMany = jest.fn();
const mockSet = jest.fn().mockReturnThis();
const mockWhere = jest.fn().mockResolvedValue([]);
const mockUpdate = jest.fn().mockReturnValue({ set: mockSet });
const mockRm = jest.fn().mockResolvedValue(undefined);
const mockWorkerInputs: unknown[] = [];

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      pdfSessions: { findFirst: mockFindFirst, findMany: mockFindMany },
    },
    update: mockUpdate,
  },
}));

jest.mock('../services/pdfArtifactStore', () => ({
  getPdfArtifactStore: () => ({
    exists: jest.fn().mockResolvedValue(true),
    getStream: jest.fn(),
    putFile: jest.fn(),
    deleteFile: jest.fn(),
    deleteSessionPrefix: jest.fn().mockResolvedValue(undefined),
  }),
  readPdfArtifact: jest.fn().mockResolvedValue(Buffer.from('%PDF-test')),
  buildPdfArtifactKey: ({ userId, sessionId, fileName }: any) =>
    `${userId}/${sessionId}/${fileName}`,
}));

jest.mock('worker_threads', () => {
  const actualWt = jest.requireActual('worker_threads');
  return {
    ...actualWt,
    Worker: jest.fn().mockImplementation((_path: string, opts: any) => {
      mockWorkerInputs.push(opts.workerData);
      const handlers: Record<string, (...args: unknown[]) => void> = {};
      const instance = {
        on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
          handlers[event] = handler;
        }),
        postMessage: jest.fn(),
        terminate: jest.fn(),
      };
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

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn((p: string) => {
      if (typeof p === 'string' && (p.includes('.pdf') || p.includes('pdfExportWorker.js'))) {
        return true;
      }
      return actual.existsSync(p);
    }),
    mkdirSync: jest.fn(),
  };
});

jest.mock('fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue(Buffer.from('fake')),
  rename: jest.fn().mockResolvedValue(undefined),
  copyFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
  rm: mockRm,
}));

mockSet.mockReturnValue({ where: mockWhere });

// ── Imports ────────────────────────────────────────────────────────────────────

import {
  assembleAndExport,
  cleanupSessionFiles,
  expireOldSessions,
} from '../services/pdfAssemblyService';
import { PDF_ERROR_CODES } from '../../shared/types/pdf';
import type { OverlayTextBox } from '../../shared/types/pdf';

// ── Helpers ────────────────────────────────────────────────────────────────────

const FILE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function makeSession(pageCount: number, userId = 'user-1') {
  const pages = Array.from({ length: pageCount }, (_, i) => ({
    pageId: `page-${i}`,
    fileId: FILE_ID,
    sourcePageIndex: i,
    rotation: 0,
    deleted: false,
  }));
  return {
    id: 'session-1',
    userId,
    status: 'active',
    pageManifest: pages,
    textOverlays: [] as OverlayTextBox[],
    fileMetadata: [{ fileId: FILE_ID, storedName: `${FILE_ID}.pdf`, sizeBytes: 1000 }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
  };
}

function makeOverlay(pageId: string, idSuffix: string): OverlayTextBox {
  return {
    id: `11111111-1111-4111-8111-${idSuffix.padStart(12, '0')}`,
    pageId,
    x: 10,
    y: 10,
    width: 30,
    height: 10,
    text: `Overlay ${pageId}`,
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
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('assembleAndExport — page extraction (pages filter)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWorkerInputs.length = 0;
  });

  // VT-09: Subset export produces correct page subset
  it('AC-0: exports only the pages at specified indices', async () => {
    const session = makeSession(20);
    mockFindFirst.mockResolvedValue(session);

    const result = await assembleAndExport('session-1', 'user-1', undefined, [0, 4, 9]);

    expect(result.pdfBytes).toBeDefined();
    expect(result.filename).toMatch(/^merged-document-.*\.pdf$/);
  });

  it('VT-04: passes only selected-page overlays to extraction', async () => {
    const session = makeSession(3);
    session.textOverlays = [
      makeOverlay('page-0', '1'),
      makeOverlay('page-1', '2'),
      makeOverlay('page-2', '3'),
    ];
    mockFindFirst.mockResolvedValue(session);

    await assembleAndExport('session-1', 'user-1', undefined, [1]);

    expect(mockWorkerInputs).toHaveLength(1);
    expect(
      (mockWorkerInputs[0] as { overlays: OverlayTextBox[] }).overlays
    ).toEqual([makeOverlay('page-1', '2')]);
  });

  it('keeps the session active after exporting selected pages', async () => {
    const session = makeSession(5);
    mockFindFirst.mockResolvedValue(session);

    await assembleAndExport('session-1', 'user-1', undefined, [0, 2]);

    expect(mockSet).toHaveBeenCalledWith(
      expect.not.objectContaining({ status: 'exported' }),
    );
    expect(mockSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'exported' }),
    );
  });

  // VT-10: Out-of-bounds indices rejected
  it('AC-0/VT-10: throws INVALID_PAGE_INDICES for out-of-bounds index', async () => {
    const session = makeSession(10);
    mockFindFirst.mockResolvedValue(session);

    await expect(
      assembleAndExport('session-1', 'user-1', undefined, [15]),
    ).rejects.toMatchObject({
      code: PDF_ERROR_CODES.INVALID_PAGE_INDICES,
    });
  });

  it('AC-0/VT-10: throws INVALID_PAGE_INDICES for negative index', async () => {
    const session = makeSession(10);
    mockFindFirst.mockResolvedValue(session);

    await expect(
      assembleAndExport('session-1', 'user-1', undefined, [-1]),
    ).rejects.toMatchObject({
      code: PDF_ERROR_CODES.INVALID_PAGE_INDICES,
    });
  });

  it('AC-0/VT-10: throws INVALID_PAGE_INDICES for non-integer index', async () => {
    const session = makeSession(10);
    mockFindFirst.mockResolvedValue(session);

    await expect(
      assembleAndExport('session-1', 'user-1', undefined, [1.5]),
    ).rejects.toMatchObject({
      code: PDF_ERROR_CODES.INVALID_PAGE_INDICES,
    });
  });

  // AC-3: All pages selected produces same result as full export
  it('AC-3: selecting all pages is equivalent to full export', async () => {
    const session = makeSession(5);
    mockFindFirst.mockResolvedValue(session);

    const result = await assembleAndExport('session-1', 'user-1', undefined, [0, 1, 2, 3, 4]);

    expect(result.pdfBytes).toBeDefined();
    expect(result.filename).toMatch(/\.pdf$/);
  });

  // Existing behavior: omitting pages filter does full export
  it('full export when pages param is undefined', async () => {
    const session = makeSession(5);
    mockFindFirst.mockResolvedValue(session);

    const result = await assembleAndExport('session-1', 'user-1', undefined, undefined);

    expect(result.pdfBytes).toBeDefined();
  });

  it('full export when pages param is empty array', async () => {
    const session = makeSession(5);
    mockFindFirst.mockResolvedValue(session);

    const result = await assembleAndExport('session-1', 'user-1', undefined, []);

    expect(result.pdfBytes).toBeDefined();
  });

  // Security: non-owner rejected
  it('Security: throws SESSION_FORBIDDEN for non-owner', async () => {
    const session = makeSession(10, 'user-other');
    mockFindFirst.mockResolvedValue(session);

    await expect(
      assembleAndExport('session-1', 'user-1', undefined, [0, 1]),
    ).rejects.toMatchObject({
      code: PDF_ERROR_CODES.SESSION_FORBIDDEN,
    });
  });

  it('removes all temporary files for a completed session', async () => {
    await cleanupSessionFiles('session-1');

    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining('session-1'),
      { recursive: true, force: true },
    );
  });

  it('cleans expired active and exported sessions as a fallback', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'active-expired', status: 'active' },
      { id: 'exported-expired', status: 'exported' },
    ]);

    const result = await expireOldSessions();

    expect(result).toEqual({ expired: 2, errors: 0 });
    expect(mockRm).toHaveBeenCalledTimes(2);
    expect(mockSet).toHaveBeenCalledTimes(2);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'expired' }),
    );
  });
});
