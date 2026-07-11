import { renderHook } from '@testing-library/react';
import { useBlankDetection } from '../useBlankDetection';

function createMockCanvas(
  width: number,
  height: number,
  fillFn?: (data: Uint8ClampedArray, w: number, h: number) => void,
): HTMLCanvasElement {
  const totalPixels = width * height;
  const data = new Uint8ClampedArray(totalPixels * 4);

  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }

  if (fillFn) {
    fillFn(data, width, height);
  }

  const imageData = { data, width, height };
  const ctx = { getImageData: jest.fn().mockReturnValue(imageData) };
  const canvas = {
    width,
    height,
    getContext: jest.fn().mockReturnValue(ctx),
  } as unknown as HTMLCanvasElement;

  return canvas;
}

const MOCK_BITMAP = { width: 100, height: 150, close: jest.fn() };

describe('useBlankDetection', () => {
  it('returns isBlank=true for an all-white canvas (VT-01)', () => {
    const canvas = createMockCanvas(150, 200);

    const { result } = renderHook(() => useBlankDetection(canvas, MOCK_BITMAP));

    expect(result.current.isBlank).toBe(true);
  });

  it('returns isBlank=false for a canvas with 10% colored pixels (VT-02)', () => {
    const canvas = createMockCanvas(150, 200, (data, w, h) => {
      const totalPixels = w * h;
      const coloredCount = Math.floor(totalPixels * 0.1);
      for (let i = 0; i < coloredCount; i++) {
        const offset = i * 4;
        data[offset] = 0;
        data[offset + 1] = 0;
        data[offset + 2] = 0;
      }
    });

    const { result } = renderHook(() => useBlankDetection(canvas, MOCK_BITMAP));

    expect(result.current.isBlank).toBe(false);
  });

  it('returns isBlank=true for a canvas with 0.3% colored pixels — below threshold (VT-03)', () => {
    const canvas = createMockCanvas(150, 200, (data, w, h) => {
      const totalPixels = w * h;
      const coloredCount = Math.floor(totalPixels * 0.003);
      for (let i = 0; i < coloredCount; i++) {
        const offset = i * 4;
        data[offset] = 0;
        data[offset + 1] = 0;
        data[offset + 2] = 0;
      }
    });

    const { result } = renderHook(() => useBlankDetection(canvas, MOCK_BITMAP));

    expect(result.current.isBlank).toBe(true);
  });

  it('returns isBlank=false for a canvas with 0.8% colored pixels — above threshold (VT-04)', () => {
    const canvas = createMockCanvas(150, 200, (data, w, h) => {
      const totalPixels = w * h;
      const coloredCount = Math.floor(totalPixels * 0.008);
      for (let i = 0; i < coloredCount; i++) {
        const offset = i * 4;
        data[offset] = 0;
        data[offset + 1] = 0;
        data[offset + 2] = 0;
      }
    });

    const { result } = renderHook(() => useBlankDetection(canvas, MOCK_BITMAP));

    expect(result.current.isBlank).toBe(false);
  });

  it('returns isBlank=true for near-white noise at luminance 251 (VT-05)', () => {
    const canvas = createMockCanvas(150, 200, (data) => {
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 251;
        data[i + 1] = 251;
        data[i + 2] = 251;
      }
    });

    const { result } = renderHook(() => useBlankDetection(canvas, MOCK_BITMAP));

    expect(result.current.isBlank).toBe(true);
  });

  it('returns isBlank=false for a simulated header/footer with ~2% pixel coverage (VT-06)', () => {
    const canvas = createMockCanvas(150, 200, (data, w, h) => {
      const totalPixels = w * h;
      const coloredCount = Math.floor(totalPixels * 0.02);
      for (let i = 0; i < coloredCount; i++) {
        const offset = i * 4;
        data[offset] = 30;
        data[offset + 1] = 30;
        data[offset + 2] = 30;
      }
    });

    const { result } = renderHook(() => useBlankDetection(canvas, MOCK_BITMAP));

    expect(result.current.isBlank).toBe(false);
  });

  it('returns isBlank=false when canvas is null', () => {
    const { result } = renderHook(() => useBlankDetection(null, MOCK_BITMAP));

    expect(result.current.isBlank).toBe(false);
  });

  it('returns isBlank=false when getContext returns null', () => {
    const canvas = {
      width: 150,
      height: 200,
      getContext: jest.fn().mockReturnValue(null),
    } as unknown as HTMLCanvasElement;

    const { result } = renderHook(() => useBlankDetection(canvas, MOCK_BITMAP));

    expect(result.current.isBlank).toBe(false);
  });

  it('returns isBlank=false when renderKey is falsy (loading state)', () => {
    const canvas = createMockCanvas(150, 200);

    const { result } = renderHook(() => useBlankDetection(canvas, null));

    expect(result.current.isBlank).toBe(false);
  });

  it('returns isBlank=false when renderKey is undefined', () => {
    const canvas = createMockCanvas(150, 200);

    const { result } = renderHook(() => useBlankDetection(canvas));

    expect(result.current.isBlank).toBe(false);
  });

  it('re-runs detection when renderKey changes', () => {
    const canvas = createMockCanvas(150, 200);

    const { result, rerender } = renderHook(
      ({ renderKey }) => useBlankDetection(canvas, renderKey),
      { initialProps: { renderKey: 'bitmap-1' as unknown } },
    );

    expect(result.current.isBlank).toBe(true);

    rerender({ renderKey: 'bitmap-2' });

    expect(result.current.isBlank).toBe(true);
  });
});
