import { renderHook, waitFor } from '@testing-library/react';

// ── Mock ImageBitmap and OffscreenCanvas ───────────────────────────────────────

const mockImageBitmap = { width: 100, height: 150, close: jest.fn() };

(globalThis as Record<string, unknown>).createImageBitmap = jest.fn().mockResolvedValue(mockImageBitmap);

class MockOffscreenCanvas {
  width: number;
  height: number;
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
  }
  getContext() {
    return { fillRect: jest.fn(), drawImage: jest.fn() };
  }
}

(globalThis as Record<string, unknown>).OffscreenCanvas = MockOffscreenCanvas;

// ── Mock pdfjs-dist ────────────────────────────────────────────────────────────

jest.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
}));

import { useThumbnailRenderer } from '../useThumbnailRenderer';

// ── Helpers ────────────────────────────────────────────────────────────────────

function createMockDocument(numPages = 5) {
  const mockViewport = { width: 100, height: 150 };
  const renderPromise = { promise: Promise.resolve() };
  const mockPage = {
    getViewport: jest.fn().mockReturnValue(mockViewport),
    render: jest.fn().mockReturnValue(renderPromise),
  };

  return {
    numPages,
    getPage: jest.fn().mockResolvedValue(mockPage),
    destroy: jest.fn(),
    _mockPage: mockPage,
    _mockViewport: mockViewport,
  };
}

describe('useThumbnailRenderer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns idle state when document is null', () => {
    const { result } = renderHook(() => useThumbnailRenderer(null, 0, 0));

    expect(result.current.status).toBe('idle');
    expect(result.current.imageBitmap).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('renders thumbnail and returns loaded state', async () => {
    const doc = createMockDocument();

    const { result } = renderHook(() =>
      useThumbnailRenderer(doc as never, 0, 0, 1),
    );

    expect(result.current.status).toBe('loading');

    await waitFor(() => {
      expect(result.current.status).toBe('loaded');
    });

    expect(result.current.imageBitmap).toBe(mockImageBitmap);
    expect(result.current.error).toBeNull();
    expect(doc.getPage).toHaveBeenCalledWith(1); // pageIndex 0 → pdf page 1
  });

  it('uses rotation in viewport', async () => {
    const doc = createMockDocument();

    renderHook(() => useThumbnailRenderer(doc as never, 2, 90, 1));

    await waitFor(() => {
      expect(doc._mockPage.getViewport).toHaveBeenCalledWith({
        scale: 1,
        rotation: 90,
      });
    });
  });

  it('handles render errors gracefully', async () => {
    const mockPage = {
      getViewport: jest.fn().mockReturnValue({ width: 100, height: 150 }),
      render: jest.fn().mockReturnValue({
        promise: Promise.reject(new Error('Render failed')),
      }),
    };

    const doc = {
      numPages: 5,
      getPage: jest.fn().mockResolvedValue(mockPage),
      destroy: jest.fn(),
    };

    const { result } = renderHook(() =>
      useThumbnailRenderer(doc as never, 0, 0, 1),
    );

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });

    expect(result.current.error).toBe('Render failed');
    expect(result.current.imageBitmap).toBeNull();
  });

  it('returns cached ImageBitmap on re-render with same params', async () => {
    const doc = createMockDocument();

    const { result, rerender } = renderHook(
      ({ pageIndex, rotation }: { pageIndex: number; rotation: 0 | 90 | 180 | 270 }) =>
        useThumbnailRenderer(doc as never, pageIndex, rotation, 1),
      { initialProps: { pageIndex: 0, rotation: 0 as const } },
    );

    await waitFor(() => {
      expect(result.current.status).toBe('loaded');
    });

    const firstBitmap = result.current.imageBitmap;

    rerender({ pageIndex: 0, rotation: 0 as const });

    expect(result.current.status).toBe('loaded');
    expect(result.current.imageBitmap).toBe(firstBitmap);
    // getPage should only have been called once due to cache
    expect(doc.getPage).toHaveBeenCalledTimes(1);
  });
});
