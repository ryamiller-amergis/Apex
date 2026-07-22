const mockFindFirst = jest.fn();
const mockSet = jest.fn();
const mockWhere = jest.fn();
const mockReturning = jest.fn();
const mockUpdate = jest.fn().mockReturnValue({ set: mockSet });

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      pdfSessions: { findFirst: mockFindFirst },
    },
    update: mockUpdate,
  },
}));

import { updateOverlays } from '../services/pdfAssemblyService';
import { PDF_ERROR_CODES, type OverlayTextBox } from '../../shared/types/pdf';

const SESSION_ID = 'session-1';
const USER_ID = 'user-1';

function makeOverlay(index = 0): OverlayTextBox {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    pageId: 'page-1',
    x: 10,
    y: 10,
    width: 30,
    height: 10,
    text: `Overlay ${index}`,
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
    zIndex: index,
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    status: 'active',
    pageManifest: [
      {
        pageId: 'page-1',
        fileId: 'file-1',
        sourcePageIndex: 0,
        rotation: 0,
        deleted: false,
      },
    ],
    textOverlays: [],
    fileMetadata: [],
    ...overrides,
  };
}

describe('updateOverlays', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSet.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ returning: mockReturning });
    mockFindFirst.mockResolvedValue(makeSession());
  });

  it('VT-01: atomically replaces 20 overlays and returns authoritative state', async () => {
    const overlays = Array.from({ length: 20 }, (_, index) =>
      makeOverlay(index)
    );
    mockReturning.mockResolvedValue([{ textOverlays: overlays }]);

    const result = await updateOverlays(SESSION_ID, USER_ID, overlays);

    expect(result).toEqual({
      overlays,
      updatedAt: expect.any(String),
    });
    expect(mockSet).toHaveBeenCalledWith({
      textOverlays: overlays,
      updatedAt: expect.any(String),
    });
    expect(mockSet.mock.calls[0][0]).not.toHaveProperty('pageManifest');
  });

  it('VT-03: an empty list clears all persisted overlays', async () => {
    mockFindFirst.mockResolvedValue(
      makeSession({
        textOverlays: [makeOverlay()],
      })
    );
    mockReturning.mockResolvedValue([{ textOverlays: [] }]);

    await expect(
      updateOverlays(SESSION_ID, USER_ID, [])
    ).resolves.toMatchObject({ overlays: [] });
    expect(mockSet).toHaveBeenCalledWith({
      textOverlays: [],
      updatedAt: expect.any(String),
    });
  });

  it('persists replacement metadata and an empty removal value', async () => {
    const replacement = {
      ...makeOverlay(),
      text: '',
      width: 8,
      height: 2,
      kind: 'replace' as const,
      backgroundColor: '#FFFFFF',
    };
    mockReturning.mockResolvedValue([{ textOverlays: [replacement] }]);

    await expect(
      updateOverlays(SESSION_ID, USER_ID, [replacement])
    ).resolves.toMatchObject({ overlays: [replacement] });
    expect(mockSet).toHaveBeenCalledWith({
      textOverlays: [replacement],
      updatedAt: expect.any(String),
    });
  });

  it('VT-04: rejects cross-user writes before persistence', async () => {
    mockFindFirst.mockResolvedValue(makeSession({ userId: 'other-user' }));

    await expect(
      updateOverlays(SESSION_ID, USER_ID, [makeOverlay()])
    ).rejects.toMatchObject({ code: PDF_ERROR_CODES.SESSION_FORBIDDEN });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects writes to expired sessions before persistence', async () => {
    mockFindFirst.mockResolvedValue(makeSession({ status: 'expired' }));

    await expect(
      updateOverlays(SESSION_ID, USER_ID, [makeOverlay()])
    ).rejects.toMatchObject({ code: PDF_ERROR_CODES.SESSION_EXPIRED });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('VT-03: allows overlay edits during the exported grace period', async () => {
    const overlays = [makeOverlay()];
    mockFindFirst.mockResolvedValue(makeSession({ status: 'exported' }));
    mockReturning.mockResolvedValue([{ textOverlays: overlays }]);

    await expect(
      updateOverlays(SESSION_ID, USER_ID, overlays)
    ).resolves.toMatchObject({ overlays });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('VT-04: re-reads status and rejects a second save after expiry', async () => {
    const overlays = [makeOverlay()];
    mockFindFirst
      .mockResolvedValueOnce(makeSession({ status: 'active' }))
      .mockResolvedValueOnce(makeSession({ status: 'expired' }));
    mockReturning.mockResolvedValue([{ textOverlays: overlays }]);

    await expect(
      updateOverlays(SESSION_ID, USER_ID, overlays)
    ).resolves.toMatchObject({ overlays });
    await expect(
      updateOverlays(SESSION_ID, USER_ID, overlays)
    ).rejects.toMatchObject({ code: PDF_ERROR_CODES.SESSION_EXPIRED });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('VT-06: returns field errors and does not write invalid overlays', async () => {
    const overlay = makeOverlay();
    overlay.linkUrl = 'javascript:alert(1)';

    await expect(
      updateOverlays(SESSION_ID, USER_ID, [overlay])
    ).rejects.toMatchObject({
      code: PDF_ERROR_CODES.OVERLAY_VALIDATION_FAILED,
      errors: [
        expect.objectContaining({
          overlayId: overlay.id,
          field: 'linkUrl',
        }),
      ],
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects overlays bound to deleted pages', async () => {
    mockFindFirst.mockResolvedValue(
      makeSession({
        pageManifest: [
          {
            pageId: 'page-1',
            fileId: 'file-1',
            sourcePageIndex: 0,
            rotation: 0,
            deleted: true,
          },
        ],
      })
    );

    await expect(
      updateOverlays(SESSION_ID, USER_ID, [makeOverlay()])
    ).rejects.toMatchObject({
      code: PDF_ERROR_CODES.OVERLAY_VALIDATION_FAILED,
      errors: [expect.objectContaining({ field: 'pageId' })],
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('VT-02: propagates a persistence failure after one write attempt', async () => {
    mockReturning.mockRejectedValue(new Error('database unavailable'));

    await expect(
      updateOverlays(SESSION_ID, USER_ID, [makeOverlay()])
    ).rejects.toThrow('database unavailable');
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});
