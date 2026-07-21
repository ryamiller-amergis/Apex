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

jest.mock('../services/pdfConversionJobService', () => ({
  enqueuePdfConversion: jest.fn(),
  enqueuePdfExport: jest.fn(),
  getPdfConversionJobs: jest.fn().mockResolvedValue([]),
  processPendingPdfJobs: jest.fn().mockResolvedValue(undefined),
  startPdfJobPoller: jest.fn(),
}));

jest.mock('../services/pdfArtifactStore', () => ({
  buildPdfArtifactKey: ({
    userId,
    sessionId,
    fileName,
  }: Record<string, string>) => `${userId}/${sessionId}/${fileName}`,
  getPdfArtifactStore: jest.fn(),
  readPdfArtifact: jest.fn(),
}));

jest.mock('worker_threads', () => ({
  Worker: jest.fn(),
}));

import {
  getSession,
  replaceTextOverlays,
} from '../services/pdfAssemblyService';
import { isOverlayTextBox, type OverlayTextBox } from '../../shared/types/pdf';

function makeOverlay(index = 0): OverlayTextBox {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    pageId: `page-${index % 3}`,
    x: 10,
    y: 15,
    width: 30,
    height: 10,
    text: `Overlay ${index}`,
    fontFamily: index % 2 === 0 ? 'Helvetica' : 'Times-Roman',
    fontSize: 14,
    bold: true,
    italic: false,
    color: '#123456',
    horizontalAlign: 'center',
    verticalAlign: 'middle',
    opacity: 75,
    rotation: 15,
    listStyle: 'bullet',
    linkUrl: 'https://example.com',
    linkDisplayText: 'Example',
    zIndex: index,
  };
}

describe('PDF session overlay data model', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSet.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ returning: mockReturning });
  });

  it('round-trips every overlay attribute through JSON serialization', () => {
    const overlays = [makeOverlay(1), makeOverlay(2)];

    const restored: unknown = JSON.parse(JSON.stringify(overlays));

    expect(Array.isArray(restored)).toBe(true);
    expect((restored as unknown[]).every(isOverlayTextBox)).toBe(true);
    expect(restored).toEqual(overlays);
  });

  it('rejects persisted overlay shapes missing page binding or geometry', () => {
    const { pageId: _pageId, ...withoutPageId } = makeOverlay();
    const { width: _width, ...withoutWidth } = makeOverlay();

    expect(isOverlayTextBox(withoutPageId)).toBe(false);
    expect(isOverlayTextBox(withoutWidth)).toBe(false);
  });

  it('represents 50 overlays as a flat session-level collection', () => {
    const textOverlays = Array.from({ length: 50 }, (_, index) =>
      makeOverlay(index)
    );

    expect(textOverlays).toHaveLength(50);
    expect(textOverlays.every(isOverlayTextBox)).toBe(true);
    expect(
      textOverlays.every((overlay) => typeof overlay.pageId === 'string')
    ).toBe(true);
  });

  it('normalizes missing legacy overlay storage to an empty array on load', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      status: 'active',
      pageManifest: [],
      fileMetadata: [],
    });

    await expect(getSession('session-1')).resolves.toMatchObject({
      id: 'session-1',
      textOverlays: [],
    });
  });

  it('persists and reloads overlays without updating the page manifest', async () => {
    const textOverlays = [makeOverlay()];
    mockReturning.mockResolvedValue([{ textOverlays }]);

    await expect(
      replaceTextOverlays('session-1', textOverlays)
    ).resolves.toEqual(textOverlays);
    expect(mockSet).toHaveBeenCalledWith({
      textOverlays,
      updatedAt: expect.any(String),
    });
    expect(mockSet.mock.calls[0][0]).not.toHaveProperty('pageManifest');

    mockFindFirst.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      status: 'active',
      pageManifest: [{ pageId: 'page-0' }],
      fileMetadata: [],
      textOverlays,
    });

    await expect(getSession('session-1')).resolves.toMatchObject({
      textOverlays,
    });
  });

  it('propagates an overlay persistence failure without a second write', async () => {
    mockReturning.mockRejectedValue(new Error('database unavailable'));

    await expect(
      replaceTextOverlays('session-1', [makeOverlay()])
    ).rejects.toThrow('database unavailable');
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});
