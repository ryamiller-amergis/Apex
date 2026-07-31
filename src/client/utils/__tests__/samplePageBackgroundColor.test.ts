import type { OverlayBoxGeometry } from '../../hooks/overlayGeometry';
import {
  samplePageBackgroundColor,
  samplePagePerimeterColor,
  samplePageTextColors,
} from '../samplePageBackgroundColor';

type Rgba = [number, number, number, number];

function parseHex(color: string): { r: number; g: number; b: number } {
  const normalized = color.replace('#', '');
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function toLinear(channel: number): number {
  const normalized = channel / 255;
  if (normalized <= 0.03928) return normalized / 12.92;
  return ((normalized + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(colorA: string, colorB: string): number {
  const first = parseHex(colorA);
  const second = parseHex(colorB);
  const firstL =
    0.2126 * toLinear(first.r) +
    0.7152 * toLinear(first.g) +
    0.0722 * toLinear(first.b);
  const secondL =
    0.2126 * toLinear(second.r) +
    0.7152 * toLinear(second.g) +
    0.0722 * toLinear(second.b);
  const lighter = Math.max(firstL, secondL);
  const darker = Math.min(firstL, secondL);
  return (lighter + 0.05) / (darker + 0.05);
}

function makeCanvas(
  width: number,
  height: number,
  painter: (point: { x: number; y: number }) => Rgba
): HTMLCanvasElement {
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const [r, g, b, a] = painter({ x, y });
      pixels[index] = r;
      pixels[index + 1] = g;
      pixels[index + 2] = b;
      pixels[index + 3] = a;
    }
  }

  const getImageData = jest.fn(
    (sx: number, sy: number, sw: number, sh: number) => {
      const data = new Uint8ClampedArray(sw * sh * 4);
      for (let row = 0; row < sh; row += 1) {
        for (let col = 0; col < sw; col += 1) {
          const src = ((sy + row) * width + (sx + col)) * 4;
          const dst = (row * sw + col) * 4;
          data[dst] = pixels[src] ?? 0;
          data[dst + 1] = pixels[src + 1] ?? 0;
          data[dst + 2] = pixels[src + 2] ?? 0;
          data[dst + 3] = pixels[src + 3] ?? 0;
        }
      }
      return {
        data,
        width: sw,
        height: sh,
        colorSpace: 'srgb' as const,
      };
    }
  );

  return {
    width,
    height,
    getContext: jest.fn(() => ({ getImageData })),
  } as unknown as HTMLCanvasElement;
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

function makeRotatedTextFixture(
  width: number,
  height: number,
  geometry: OverlayBoxGeometry,
  rotation: number,
  colors: { foreground: Rgba; background: Rgba }
): HTMLCanvasElement {
  const left = (geometry.x / 100) * width;
  const top = (geometry.y / 100) * height;
  const boxWidth = (geometry.width / 100) * width;
  const boxHeight = (geometry.height / 100) * height;
  const centerX = left + boxWidth / 2;
  const centerY = top + boxHeight / 2;

  return makeCanvas(width, height, ({ x, y }) => {
    const local = toLocalPoint(x + 0.5, y + 0.5, centerX, centerY, rotation);
    const inGlyph =
      Math.abs(local.x) <= boxWidth / 2 && Math.abs(local.y) <= boxHeight / 2;
    return inGlyph ? colors.foreground : colors.background;
  });
}

function canvasWithoutContext(): HTMLCanvasElement {
  return {
    width: 100,
    height: 100,
    getContext: jest.fn(() => null),
  } as unknown as HTMLCanvasElement;
}

function canvasThrowingGetImageData(): HTMLCanvasElement {
  return {
    width: 100,
    height: 100,
    getContext: jest.fn(() => ({
      getImageData: () => {
        throw new Error('nope');
      },
    })),
  } as unknown as HTMLCanvasElement;
}

function lowContrastCanvas(): HTMLCanvasElement {
  return makeCanvas(100, 100, ({ x, y }) => {
    const inGlyph = x >= 40 && x <= 59 && y >= 40 && y <= 51;
    if (inGlyph) return [122, 122, 122, 255];
    return [119, 119, 119, 255];
  });
}

describe('samplePageTextColors', () => {
  const geometry = { x: 40, y: 40, width: 20, height: 12 };

  it('samples colored foreground inside and median background outside', () => {
    const canvas = makeCanvas(100, 100, ({ x, y }) => {
      const glyph = x >= 42 && x <= 58 && y >= 44 && y <= 50;
      return glyph ? [24, 72, 120, 255] : [245, 238, 225, 255];
    });
    expect(samplePageTextColors(canvas, geometry, 0)).toEqual({
      color: '#184878',
      backgroundColor: '#F5EEE1',
    });
  });

  it('uses the rotated perimeter rather than the axis-aligned interior', () => {
    const rotatedGeometry = { x: 40, y: 30, width: 20, height: 8 };
    const canvas = makeRotatedTextFixture(100, 100, rotatedGeometry, 35, {
      foreground: [15, 15, 15, 255],
      background: [232, 240, 248, 255],
    });
    expect(samplePageTextColors(canvas, rotatedGeometry, 35)).toEqual({
      color: '#0F0F0F',
      backgroundColor: '#E8F0F8',
    });
  });

  it.each([
    ['missing canvas', null],
    ['missing context', canvasWithoutContext()],
    ['pixel exception', canvasThrowingGetImageData()],
  ])('%s falls back to white and black', (_label, canvas) => {
    expect(
      samplePageTextColors(canvas, { x: 10, y: 10, width: 20, height: 5 })
    ).toEqual({ color: '#000000', backgroundColor: '#FFFFFF' });
  });

  it('rejects a low-contrast foreground and chooses the safer black/white color', () => {
    const colors = samplePageTextColors(lowContrastCanvas(), geometry);
    expect(colors.backgroundColor).toBe('#777777');
    expect(colors.color).toBe('#000000');
    expect(
      contrastRatio(colors.color, colors.backgroundColor)
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('ignores transparent pixels and falls back safely', () => {
    const transparentCanvas = makeCanvas(100, 100, () => [20, 40, 60, 0]);
    expect(samplePageTextColors(transparentCanvas, geometry)).toEqual({
      color: '#000000',
      backgroundColor: '#FFFFFF',
    });
  });

  it('falls back when no perimeter samples exist', () => {
    const glyphOnly = makeCanvas(100, 100, ({ x, y }) => {
      const inGlyph = x >= 40 && x <= 59 && y >= 40 && y <= 51;
      return inGlyph ? [10, 10, 10, 255] : [10, 10, 10, 0];
    });
    expect(samplePagePerimeterColor(glyphOnly, geometry)).toBeNull();
    const colors = samplePageTextColors(glyphOnly, geometry);
    expect(colors.backgroundColor).toBe('#FFFFFF');
    expect(
      contrastRatio(colors.color, colors.backgroundColor)
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('falls back to contrast-safe foreground when no interior candidates remain', () => {
    const noInteriorCandidates = makeCanvas(100, 100, ({ x, y }) => {
      const inGlyph = x >= 42 && x <= 58 && y >= 44 && y <= 50;
      return inGlyph ? [244, 237, 226, 255] : [245, 238, 225, 255];
    });
    expect(samplePageTextColors(noInteriorCandidates, geometry)).toEqual({
      color: '#000000',
      backgroundColor: '#F5EEE1',
    });
  });

  it('handles anti-aliased edges by keeping opaque edge samples', () => {
    const antiAliased = makeCanvas(100, 100, ({ x, y }) => {
      if (x >= 42 && x <= 58 && y >= 44 && y <= 50) return [20, 20, 20, 255];
      if (x >= 41 && x <= 59 && y >= 43 && y <= 51) return [230, 230, 230, 210];
      return [250, 250, 250, 255];
    });
    expect(samplePageTextColors(antiAliased, geometry)).toEqual({
      color: '#141414',
      backgroundColor: '#FAFAFA',
    });
  });

  it('chooses white foreground on dark backgrounds', () => {
    const darkBackground = makeCanvas(100, 100, ({ x, y }) => {
      const inGlyph = x >= 42 && x <= 58 && y >= 44 && y <= 50;
      return inGlyph ? [15, 15, 15, 255] : [32, 32, 32, 255];
    });
    const colors = samplePageTextColors(darkBackground, geometry);
    expect(colors.backgroundColor).toBe('#202020');
    expect(colors.color).toBe('#FFFFFF');
    expect(
      contrastRatio(colors.color, colors.backgroundColor)
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe('samplePageBackgroundColor', () => {
  it('returns sampled perimeter when available', () => {
    const canvas = makeCanvas(100, 100, ({ x, y }) => {
      const inGlyph = x >= 42 && x <= 58 && y >= 44 && y <= 50;
      return inGlyph ? [20, 20, 20, 255] : [240, 245, 250, 255];
    });
    expect(
      samplePageBackgroundColor(canvas, { x: 40, y: 40, width: 20, height: 12 })
    ).toBe('#F0F5FA');
  });

  it('preserves backward-compatible fallback parameter behavior', () => {
    expect(
      samplePageBackgroundColor(
        null,
        { x: 10, y: 10, width: 5, height: 2 },
        '#ABCDEF'
      )
    ).toBe('#ABCDEF');
  });
});
