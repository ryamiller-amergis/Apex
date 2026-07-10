import { useMemo } from 'react';

export interface BlankDetectionResult {
  isBlank: boolean;
}

const LUMINANCE_THRESHOLD = 250;
const BLANK_RATIO_THRESHOLD = 0.005;

export function isPageBlank(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;

  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const totalPixels = width * height;
  let nonBackgroundPixels = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r < LUMINANCE_THRESHOLD || g < LUMINANCE_THRESHOLD || b < LUMINANCE_THRESHOLD) {
      nonBackgroundPixels++;
    }
  }

  const ratio = nonBackgroundPixels / totalPixels;
  return ratio <= BLANK_RATIO_THRESHOLD;
}

export function useBlankDetection(canvas: HTMLCanvasElement | null, renderKey?: unknown): BlankDetectionResult {
  const isBlank = useMemo(() => {
    if (!canvas || !renderKey) return false;
    return isPageBlank(canvas);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas, renderKey]);

  return { isBlank };
}
