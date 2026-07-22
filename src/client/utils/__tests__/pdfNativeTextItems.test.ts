import { convertPdfTextItems } from '../pdfNativeTextItems';

const viewport = {
  width: 600,
  height: 800,
  scale: 1,
  transform: [1, 0, 0, -1, 0, 800],
};

function item(str: string, x: number, y: number, width: number, fontSize = 12) {
  return {
    str,
    transform: [fontSize, 0, 0, fontSize, x, y],
    width,
    height: fontSize,
    fontName: 'f1',
  };
}

describe('convertPdfTextItems', () => {
  it('keeps adjacent PDF.js items independently selectable', () => {
    const result = convertPdfTextItems(
      [item('Hello', 60, 760, 40), item('world', 105, 760, 45)],
      { f1: { ascent: 0.8 } },
      viewport
    );

    expect(result).toHaveLength(2);
    expect(result.map((entry) => entry.text)).toEqual(['Hello', 'world']);
    expect(result.map((entry) => entry.id)).toEqual([
      'text-item-0',
      'text-item-1',
    ]);
  });

  it('filters whitespace-only items without joining surrounding text', () => {
    const result = convertPdfTextItems(
      [
        item('First', 60, 760, 40),
        item(' ', 100, 760, 4),
        item('Last', 104, 760, 35),
      ],
      { f1: { ascent: 0.8 } },
      viewport
    );

    expect(result.map((entry) => entry.text)).toEqual(['First', 'Last']);
  });

  it('registers a cover over the TextLayer em-box without large bottom bias', () => {
    const fontSize = 12;
    const baselinePdfY = 760;
    const ascentRatio = 0.8;
    const [result] = convertPdfTextItems(
      [item('Canada', 60, baselinePdfY, 60, fontSize)],
      { f1: { ascent: ascentRatio } },
      viewport
    );

    const baselineViewportY = 800 - baselinePdfY;
    const emTop = baselineViewportY - fontSize * ascentRatio;
    const emBottom = emTop + fontSize;
    const coverTop = (result.geometry.y / 100) * 800;
    const coverBottom =
      coverTop + (result.geometry.height / 100) * 800;

    expect(coverTop).toBeLessThanOrEqual(emTop + 0.5);
    expect(coverBottom).toBeGreaterThanOrEqual(emBottom);
    expect(coverBottom).toBeLessThan(emBottom + 6);
    expect(result.fontSize).toBe(12);
  });

  it('clamps cover height so it does not swallow the next line', () => {
    // Tight leading: 12px font with only ~3px gap between em-boxes.
    const upper = item('Joynd Cloud', 60, 700, 120, 12);
    const lower = item('550 n main', 60, 700 - 15, 100, 12);

    const [first, second] = convertPdfTextItems(
      [upper, lower],
      { f1: { ascent: 0.8 } },
      viewport
    );

    const firstBottom =
      (first.geometry.y / 100) * 800 +
      (first.geometry.height / 100) * 800;
    const secondTop = (second.geometry.y / 100) * 800;

    expect(firstBottom).toBeLessThanOrEqual(secondTop + 0.5);
    expect(first.geometry.height).toBeLessThan(3);
  });

  it('preserves an individual item rotation', () => {
    const [result] = convertPdfTextItems(
      [
        {
          str: 'Vertical',
          transform: [0, 12, -12, 0, 100, 700],
          width: 50,
          height: 12,
          fontName: 'f1',
        },
      ],
      { f1: { ascent: 0.8 } },
      viewport
    );

    expect(result.rotation).toBe(-90);
    expect(result.geometry.width).toBeGreaterThan(0);
    expect(result.geometry.height).toBeGreaterThan(0);
  });
});
