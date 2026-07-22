import type { OverlayBoxGeometry } from '../hooks/overlayGeometry';

const FALLBACK = '#FFFFFF';
const OUTSET_PX = 4;
const GLYPH_BACKGROUND_DISTANCE = 32;
const REQUIRED_CONTRAST = 4.5;
const MIN_ALPHA = 200;

type RgbPixel = [number, number, number];

type RawSamples = {
  interior: RgbPixel[];
  perimeter: RgbPixel[];
};

export type SampledPageTextColors = {
  color: string;
  backgroundColor: string;
};

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

function medianHex(pixels: RgbPixel[] | null | undefined): string | null {
  if (!pixels || pixels.length === 0) return null;
  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];
  for (const [r, g, b] of pixels) {
    reds.push(r);
    greens.push(g);
    blues.push(b);
  }
  return toHex(median(reds), median(greens), median(blues));
}

function parseHex(color: string): RgbPixel {
  const normalized = color.replace('#', '');
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function rgbDistance(first: RgbPixel, second: RgbPixel): number {
  const dr = first[0] - second[0];
  const dg = first[1] - second[1];
  const db = first[2] - second[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function toLinear(channel: number): number {
  const normalized = channel / 255;
  if (normalized <= 0.03928) return normalized / 12.92;
  return ((normalized + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(colorA: string, colorB: string): number {
  const first = parseHex(colorA);
  const second = parseHex(colorB);
  const firstLuminance =
    0.2126 * toLinear(first[0]) +
    0.7152 * toLinear(first[1]) +
    0.0722 * toLinear(first[2]);
  const secondLuminance =
    0.2126 * toLinear(second[0]) +
    0.7152 * toLinear(second[1]) +
    0.0722 * toLinear(second[2]);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function contrastSafeForeground(backgroundColor: string): string {
  return contrastRatio('#000000', backgroundColor) >=
    contrastRatio('#FFFFFF', backgroundColor)
    ? '#000000'
    : '#FFFFFF';
}

function toLocalPoint(
  pageX: number,
  pageY: number,
  centerX: number,
  centerY: number,
  rotation: number
): { x: number; y: number } {
  const radians = (-rotation * Math.PI) / 180;
  const dx = pageX - centerX;
  const dy = pageY - centerY;
  return {
    x: dx * Math.cos(radians) - dy * Math.sin(radians),
    y: dx * Math.sin(radians) + dy * Math.cos(radians),
  };
}

function toPagePoint(
  localX: number,
  localY: number,
  centerX: number,
  centerY: number,
  rotation: number
): { x: number; y: number } {
  const radians = (rotation * Math.PI) / 180;
  return {
    x: centerX + localX * Math.cos(radians) - localY * Math.sin(radians),
    y: centerY + localX * Math.sin(radians) + localY * Math.cos(radians),
  };
}

function readSamples(
  canvas: HTMLCanvasElement | null | undefined,
  geometry: OverlayBoxGeometry,
  rotation: number
): RawSamples | null {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) return null;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  const left = (geometry.x / 100) * canvas.width;
  const top = (geometry.y / 100) * canvas.height;
  const width = (geometry.width / 100) * canvas.width;
  const height = (geometry.height / 100) * canvas.height;
  const centerX = left + width / 2;
  const centerY = top + height / 2;

  const halfOuterWidth = width / 2 + OUTSET_PX;
  const halfOuterHeight = height / 2 + OUTSET_PX;
  const corners = [
    toPagePoint(-halfOuterWidth, -halfOuterHeight, centerX, centerY, rotation),
    toPagePoint(halfOuterWidth, -halfOuterHeight, centerX, centerY, rotation),
    toPagePoint(halfOuterWidth, halfOuterHeight, centerX, centerY, rotation),
    toPagePoint(-halfOuterWidth, halfOuterHeight, centerX, centerY, rotation),
  ];

  const sampleLeft = Math.max(
    0,
    Math.floor(Math.min(...corners.map((point) => point.x)))
  );
  const sampleTop = Math.max(
    0,
    Math.floor(Math.min(...corners.map((point) => point.y)))
  );
  const sampleRight = Math.min(
    canvas.width,
    Math.ceil(Math.max(...corners.map((point) => point.x)))
  );
  const sampleBottom = Math.min(
    canvas.height,
    Math.ceil(Math.max(...corners.map((point) => point.y)))
  );
  const sampleWidth = sampleRight - sampleLeft;
  const sampleHeight = sampleBottom - sampleTop;
  if (sampleWidth <= 0 || sampleHeight <= 0) return null;

  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(
      sampleLeft,
      sampleTop,
      sampleWidth,
      sampleHeight
    );
  } catch {
    return null;
  }

  const interior: RgbPixel[] = [];
  const perimeter: RgbPixel[] = [];
  const { data } = imageData;

  for (let row = 0; row < sampleHeight; row += 1) {
    for (let col = 0; col < sampleWidth; col += 1) {
      const index = (row * sampleWidth + col) * 4;
      const alpha = data[index + 3] ?? 0;
      if (alpha < MIN_ALPHA) continue;

      const pageX = sampleLeft + col + 0.5;
      const pageY = sampleTop + row + 0.5;
      const local = toLocalPoint(pageX, pageY, centerX, centerY, rotation);

      const insideGlyph =
        Math.abs(local.x) <= width / 2 && Math.abs(local.y) <= height / 2;
      const insideOuter =
        Math.abs(local.x) <= width / 2 + OUTSET_PX &&
        Math.abs(local.y) <= height / 2 + OUTSET_PX;
      const inPerimeter = insideOuter && !insideGlyph;
      if (!insideGlyph && !inPerimeter) continue;

      const r = data[index] ?? 255;
      const g = data[index + 1] ?? 255;
      const b = data[index + 2] ?? 255;

      if (insideGlyph) {
        interior.push([r, g, b]);
      } else {
        perimeter.push([r, g, b]);
      }
    }
  }

  return { interior, perimeter };
}

export function samplePagePerimeterColor(
  canvas: HTMLCanvasElement | null | undefined,
  geometry: OverlayBoxGeometry,
  rotation = 0
): string | null {
  const samples = readSamples(canvas, geometry, rotation);
  return medianHex(samples?.perimeter);
}

export function samplePageTextColors(
  canvas: HTMLCanvasElement | null | undefined,
  geometry: OverlayBoxGeometry,
  rotation = 0
): SampledPageTextColors {
  const samples = readSamples(canvas, geometry, rotation);
  const backgroundColor = medianHex(samples?.perimeter) ?? '#FFFFFF';
  const backgroundRgb = parseHex(backgroundColor);
  const candidates = (samples?.interior ?? []).filter(
    (pixel) => rgbDistance(pixel, backgroundRgb) >= GLYPH_BACKGROUND_DISTANCE
  );
  const sampledForeground = medianHex(candidates);
  const color =
    sampledForeground &&
    contrastRatio(sampledForeground, backgroundColor) >= REQUIRED_CONTRAST
      ? sampledForeground
      : contrastSafeForeground(backgroundColor);
  return { color, backgroundColor };
}

export function samplePageBackgroundColor(
  canvas: HTMLCanvasElement | null | undefined,
  geometry: OverlayBoxGeometry,
  fallback: string = FALLBACK
): string {
  return samplePagePerimeterColor(canvas, geometry) ?? fallback;
}
