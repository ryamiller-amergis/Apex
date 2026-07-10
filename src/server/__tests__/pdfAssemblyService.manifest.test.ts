/**
 * Unit tests for pdfAssemblyService.updateManifest
 * The Drizzle `db` instance is fully mocked.
 */

// ── DB mock ────────────────────────────────────────────────────────────────────

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

import { updateManifest } from '../services/pdfAssemblyService';
import { PDF_ERROR_CODES } from '../../shared/types/pdf';
import type { PageManifestEntry, PdfFileMetadata } from '../../shared/types/pdf';

// ── Helpers ────────────────────────────────────────────────────────────────────

const USER_ID = 'user-abc';
const SESSION_ID = 'session-123';
const FILE_ID_A = 'file-aaa';
const FILE_ID_B = 'file-bbb';

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    status: 'active',
    fileMetadata: [
      { fileId: FILE_ID_A, originalName: 'a.pdf' } as PdfFileMetadata,
      { fileId: FILE_ID_B, originalName: 'b.pdf' } as PdfFileMetadata,
    ],
    pageManifest: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2026-01-01T04:00:00Z',
    ...overrides,
  };
}

function makeManifestEntry(overrides: Partial<PageManifestEntry> = {}): PageManifestEntry {
  return {
    pageId: 'page-1',
    fileId: FILE_ID_A,
    sourcePageIndex: 0,
    rotation: 0,
    deleted: false,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockSet.mockReturnThis();
  mockWhere.mockResolvedValue([]);
  mockSet.mockReturnValue({ where: mockWhere });
});

describe('updateManifest', () => {
  // ── VT-13: unknown fileId ────────────────────────────────────────────────────
  it('VT-13: rejects manifest with unknown fileId', async () => {
    // Arrange
    mockFindFirst.mockResolvedValue(makeSession());
    const manifest = [makeManifestEntry({ fileId: 'unknown-file-id' })];

    // Act & Assert
    await expect(updateManifest(SESSION_ID, USER_ID, manifest)).rejects.toMatchObject({
      code: PDF_ERROR_CODES.MANIFEST_INVALID_FILE_ID,
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // ── VT-14: invalid rotation ──────────────────────────────────────────────────
  it('VT-14: rejects manifest entry with rotation = 45', async () => {
    // Arrange
    mockFindFirst.mockResolvedValue(makeSession());
    const manifest = [makeManifestEntry({ rotation: 45 as any })];

    // Act & Assert
    await expect(updateManifest(SESSION_ID, USER_ID, manifest)).rejects.toMatchObject({
      code: PDF_ERROR_CODES.MANIFEST_INVALID_ROTATION,
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // ── Valid manifest ───────────────────────────────────────────────────────────
  it('succeeds with valid reordered, rotated, and deleted entries', async () => {
    // Arrange
    mockFindFirst.mockResolvedValue(makeSession());
    const manifest = [
      makeManifestEntry({ pageId: 'p1', fileId: FILE_ID_B, rotation: 90, deleted: false }),
      makeManifestEntry({ pageId: 'p2', fileId: FILE_ID_A, rotation: 180, deleted: true }),
      makeManifestEntry({ pageId: 'p3', fileId: FILE_ID_A, rotation: 0, deleted: false }),
    ];

    // Act
    const result = await updateManifest(SESSION_ID, USER_ID, manifest);

    // Assert
    expect(result.pageCount).toBe(2); // only non-deleted
    expect(result.updatedAt).toBeDefined();
    expect(mockUpdate).toHaveBeenCalled();
  });

  // ── Session not found ────────────────────────────────────────────────────────
  it('throws SESSION_NOT_FOUND when session does not exist', async () => {
    // Arrange
    mockFindFirst.mockResolvedValue(undefined);

    // Act & Assert
    await expect(
      updateManifest(SESSION_ID, USER_ID, [makeManifestEntry()]),
    ).rejects.toMatchObject({
      code: PDF_ERROR_CODES.SESSION_NOT_FOUND,
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // ── Wrong user ───────────────────────────────────────────────────────────────
  it('throws SESSION_FORBIDDEN when user does not own session', async () => {
    // Arrange
    mockFindFirst.mockResolvedValue(makeSession({ userId: 'other-user' }));

    // Act & Assert
    await expect(
      updateManifest(SESSION_ID, USER_ID, [makeManifestEntry()]),
    ).rejects.toMatchObject({
      code: PDF_ERROR_CODES.SESSION_FORBIDDEN,
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // ── Expired session ──────────────────────────────────────────────────────────
  it('throws SESSION_EXPIRED when session status is expired', async () => {
    // Arrange
    mockFindFirst.mockResolvedValue(makeSession({ status: 'expired' }));

    // Act & Assert
    await expect(
      updateManifest(SESSION_ID, USER_ID, [makeManifestEntry()]),
    ).rejects.toMatchObject({
      code: PDF_ERROR_CODES.SESSION_EXPIRED,
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // ── pageCount reflects non-deleted only ──────────────────────────────────────
  it('pageCount counts only non-deleted entries', async () => {
    // Arrange
    mockFindFirst.mockResolvedValue(makeSession());
    const manifest = [
      makeManifestEntry({ pageId: 'p1', fileId: FILE_ID_A, deleted: true }),
      makeManifestEntry({ pageId: 'p2', fileId: FILE_ID_A, deleted: true }),
      makeManifestEntry({ pageId: 'p3', fileId: FILE_ID_B, deleted: false }),
    ];

    // Act
    const result = await updateManifest(SESSION_ID, USER_ID, manifest);

    // Assert
    expect(result.pageCount).toBe(1);
  });
});
