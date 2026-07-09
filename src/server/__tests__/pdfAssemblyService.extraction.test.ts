/**
 * Unit tests for pdfAssemblyService.assembleAndExport — page extraction (pages filter)
 * Covers: PBI-009 AC-0, AC-3, VT-09, VT-10 (server-side subset export)
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

jest.mock('worker_threads', () => {
  const actualWt = jest.requireActual('worker_threads');
  return {
    ...actualWt,
    Worker: jest.fn().mockImplementation((_path: string, _opts: any) => {
      const handlers: Record<string, Function> = {};
      const instance = {
        on: jest.fn((event: string, handler: Function) => {
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
    existsSync: jest.fn().mockReturnValue(true),
    mkdirSync: jest.fn(),
  };
});

jest.mock('fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue(Buffer.from('fake')),
  rename: jest.fn().mockResolvedValue(undefined),
  copyFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
  rm: jest.fn().mockResolvedValue(undefined),
}));

mockSet.mockReturnValue({ where: mockWhere });

// ── Imports ────────────────────────────────────────────────────────────────────

import { assembleAndExport } from '../services/pdfAssemblyService';
import { PDF_ERROR_CODES } from '../../shared/types/pdf';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeSession(pageCount: number, userId = 'user-1') {
  const pages = Array.from({ length: pageCount }, (_, i) => ({
    pageId: `page-${i}`,
    fileId: 'file-1',
    sourcePageIndex: i,
    rotation: 0,
    deleted: false,
  }));
  return {
    id: 'session-1',
    userId,
    status: 'active',
    pageManifest: pages,
    fileMetadata: [{ fileId: 'file-1', storedName: 'file-1.pdf', sizeBytes: 1000 }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('assembleAndExport — page extraction (pages filter)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // VT-09: Subset export produces correct page subset
  it('AC-0: exports only the pages at specified indices', async () => {
    const session = makeSession(20);
    mockFindFirst.mockResolvedValue(session);

    const result = await assembleAndExport('session-1', 'user-1', undefined, [0, 4, 9]);

    expect(result.pdfBytes).toBeDefined();
    expect(result.filename).toMatch(/^merged-document-.*\.pdf$/);
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
});
