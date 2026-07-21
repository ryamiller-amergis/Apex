/**
 * Unit tests for PDF session create / close / concurrent-limit eviction.
 */

const mockFindFirst = jest.fn();
const mockFindMany = jest.fn();
const mockSet = jest.fn().mockReturnThis();
const mockWhere = jest.fn().mockResolvedValue([]);
const mockUpdate = jest.fn().mockReturnValue({ set: mockSet });
const mockInsertValues = jest.fn();
const mockReturning = jest.fn();
const mockInsert = jest.fn().mockReturnValue({ values: mockInsertValues });
const mockRm = jest.fn().mockResolvedValue(undefined);
const mockMkdirSync = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      pdfSessions: { findFirst: mockFindFirst, findMany: mockFindMany },
    },
    update: mockUpdate,
    insert: mockInsert,
  },
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  };
});

jest.mock('fs/promises', () => ({
  rm: (...args: unknown[]) => mockRm(...args),
}));

jest.mock('../services/pdfArtifactStore', () => ({
  getPdfArtifactStore: () => ({
    deleteSessionPrefix: jest.fn().mockResolvedValue(undefined),
  }),
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

mockSet.mockReturnValue({ where: mockWhere });
mockInsertValues.mockReturnValue({ returning: mockReturning });

import {
  closeSession,
  createSession,
} from '../services/pdfAssemblyService';
import { PDF_ERROR_CODES } from '../../shared/types/pdf';

function makeActive(id: string, createdAt: string) {
  return {
    id,
    userId: 'user-1',
    status: 'active' as const,
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    pageManifest: [],
    fileMetadata: [],
  };
}

describe('pdfAssemblyService session lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSet.mockReturnValue({ where: mockWhere });
    mockInsertValues.mockReturnValue({ returning: mockReturning });
    mockWhere.mockResolvedValue([]);
    // No past-due sessions by default
    mockFindMany.mockResolvedValue([]);
    mockReturning.mockResolvedValue([
      {
        id: 'new-session',
        userId: 'user-1',
        status: 'active',
        createdAt: '2026-07-17T12:00:00.000Z',
        expiresAt: '2026-07-17T16:00:00.000Z',
      },
    ]);
  });

  describe('closeSession', () => {
    it('expires an owned active session and removes temp files', async () => {
      mockFindFirst.mockResolvedValue(makeActive('sess-1', '2026-07-17T10:00:00.000Z'));

      await expect(closeSession('sess-1', 'user-1')).resolves.toBe(true);

      expect(mockRm).toHaveBeenCalledWith(
        expect.stringContaining('sess-1'),
        { recursive: true, force: true },
      );
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'expired' }),
      );
    });

    it('returns false for a missing or foreign session', async () => {
      mockFindFirst.mockResolvedValue(undefined);
      await expect(closeSession('missing', 'user-1')).resolves.toBe(false);

      mockFindFirst.mockResolvedValue({
        ...makeActive('sess-1', '2026-07-17T10:00:00.000Z'),
        userId: 'other-user',
      });
      await expect(closeSession('sess-1', 'user-1')).resolves.toBe(false);
      expect(mockRm).not.toHaveBeenCalled();
    });

    it('is a no-op success when already expired', async () => {
      mockFindFirst.mockResolvedValue({
        ...makeActive('sess-1', '2026-07-17T10:00:00.000Z'),
        status: 'expired',
      });

      await expect(closeSession('sess-1', 'user-1')).resolves.toBe(true);
      expect(mockRm).not.toHaveBeenCalled();
    });
  });

  describe('createSession', () => {
    it('creates a session when under the concurrent limit', async () => {
      // expireOldSessions then getActiveSessions
      mockFindMany
        .mockResolvedValueOnce([]) // expireOldSessions
        .mockResolvedValueOnce([]); // getActiveSessions

      const result = await createSession('user-1', 'proj-1');

      expect(result.sessionId).toBe('new-session');
      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          projectId: 'proj-1',
          status: 'active',
          textOverlays: [],
        }),
      );
      expect(mockMkdirSync).not.toHaveBeenCalled();
    });

    it('closes replaceSessionId before creating', async () => {
      mockFindMany
        .mockResolvedValueOnce([]) // expireOldSessions
        .mockResolvedValueOnce([]); // getActiveSessions after replace
      mockFindFirst.mockResolvedValue(makeActive('old-sess', '2026-07-17T09:00:00.000Z'));

      await createSession('user-1', undefined, { replaceSessionId: 'old-sess' });

      expect(mockFindFirst).toHaveBeenCalled();
      expect(mockRm).toHaveBeenCalledWith(
        expect.stringContaining('old-sess'),
        { recursive: true, force: true },
      );
      expect(mockInsertValues).toHaveBeenCalled();
    });

    it('evicts the oldest active sessions when at the concurrent limit', async () => {
      const oldest = makeActive('sess-old', '2026-07-17T08:00:00.000Z');
      const mid = makeActive('sess-mid', '2026-07-17T09:00:00.000Z');
      const newest = makeActive('sess-new', '2026-07-17T10:00:00.000Z');

      mockFindMany
        .mockResolvedValueOnce([]) // expireOldSessions
        .mockResolvedValueOnce([newest, mid, oldest]) // at limit (newest first)
        .mockResolvedValueOnce([newest, mid]); // after closing oldest

      // closeSession looks up the oldest
      mockFindFirst.mockResolvedValue(oldest);

      const result = await createSession('user-1');

      expect(result.sessionId).toBe('new-session');
      expect(mockRm).toHaveBeenCalledWith(
        expect.stringContaining('sess-old'),
        { recursive: true, force: true },
      );
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'expired' }),
      );
      expect(mockInsertValues).toHaveBeenCalled();
    });

    it('throws SESSION_LIMIT_REACHED when eviction cannot close a session', async () => {
      const stuck = makeActive('sess-stuck', '2026-07-17T08:00:00.000Z');
      mockFindMany
        .mockResolvedValueOnce([])
        .mockResolvedValue([stuck, stuck, stuck]); // stay at limit
      // closeSession fails (wrong owner / missing)
      mockFindFirst.mockResolvedValue(undefined);

      await expect(createSession('user-1')).rejects.toMatchObject({
        code: PDF_ERROR_CODES.SESSION_LIMIT_REACHED,
      });
      expect(mockInsertValues).not.toHaveBeenCalled();
    });
  });
});
