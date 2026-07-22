import type { OverlayBoxGeometry } from '../hooks/overlayGeometry';

const FALLBACK = '#FFFFFF';
const OUTSET_PX = 4;
const INSET_PX = 1;

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')
    .toUpperCase()}`;
}

function median(values: number[]): number {
  if (values.length === 0) return 255;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

/**
 * Samples pixels in a thin ring around the overlay geometry and returns the
 * median RGB as #RRGGBB. Dark glyph pixels are filtered out so the cover
 * matches the page background rather than the text itself.
 */
export function samplePageBackgroundColor(
  canvas: HTMLCanvasElement | null | undefined,
  geometry: OverlayBoxGeometry,
  fallback: string = FALLBACK
): string {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) return fallback;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return fallback;

  const left = (geometry.x / 100) * canvas.width;
  const top = (geometry.y / 100) * canvas.height;
  const width = (geometry.width / 100) * canvas.width;
  const height = (geometry.height / 100) * canvas.height;

  const sampleLeft = Math.max(0, Math.floor(left - OUTSET_PX));
  const sampleTop = Math.max(0, Math.floor(top - OUTSET_PX));
  const sampleRight = Math.min(canvas.width, Math.ceil(left + width + OUTSET_PX));
  const sampleBottom = Math.min(
    canvas.height,
    Math.ceil(top + height + OUTSET_PX)
  );
  const sampleWidth = sampleRight - sampleLeft;
  const sampleHeight = sampleBottom - sampleTop;
  if (sampleWidth <= 0 || sampleHeight <= 0) return fallback;

  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(
      sampleLeft,
      sampleTop,
      sampleWidth,
      sampleHeight
    );
  } catch {
    return fallback;
  }

  const innerLeft = left + INSET_PX;
  const innerTop = top + INSET_PX;
  const innerRight = left + width - INSET_PX;
  const innerBottom = top + height - INSET_PX;

  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];
  const { data } = imageData;

  for (let row = 0; row < sampleHeight; row += 1) {
    for (let col = 0; col < sampleWidth; col += 1) {
      const pageX = sampleLeft + col;
      const pageY = sampleTop + row;
      const insideInner =
        pageX >= innerLeft &&
        pageX <= innerRight &&
        pageY >= innerTop &&
        pageY <= innerBottom;
      if (insideInner) continue;

      const index = (row * sampleWidth + col) * 4;
      const alpha = data[index + 3] ?? 0;
      if (alpha < 200) continue;

      const r = data[index] ?? 255;
      const g = data[index + 1] ?? 255;
      const b = data[index + 2] ?? 255;
      // Skip dark ink pixels so glyph edges do not tint the cover.
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (luminance < 140) continue;

      reds.push(r);
      greens.push(g);
      blues.push(b);
    }
  }

  if (reds.length === 0) return fallback;
  return toHex(median(reds), median(greens), median(blues));
}
