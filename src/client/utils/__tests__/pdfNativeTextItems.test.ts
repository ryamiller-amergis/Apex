import {
  calculateReplacementBounds,
  convertPdfTextItems,
  mapPdfFontToOverlayFamily,
} from '../pdfNativeTextItems';
import type { NativePdfTextItem } from '../pdfNativeTextItems';

const viewport = {
  width: 600,
  height: 800,
  scale: 1,
  transform: [1, 0, 0, -1, 0, 800],
};

function nativeItem(
  id: string,
  geometry: NativePdfTextItem['geometry'],
  rotation = 0
): NativePdfTextItem {
  return {
    id,
    text: id,
    geometry,
    fontSize: 12,
    rotation,
    fontFamily: 'Helvetica',
    bold: false,
    italic: false,
  };
}

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
  it('accepts canonical optional sampled color fields on native items', () => {
    const contractItem: NativePdfTextItem = {
      id: 'text-item-contract',
      text: 'Contract sample',
      geometry: { x: 10, y: 20, width: 30, height: 5 },
      fontSize: 12,
      rotation: 0,
      fontFamily: 'Courier',
      bold: false,
      italic: false,
      color: '#000000',
      backgroundColor: '#FFFFFF',
    };

    expect(contractItem).toMatchObject({
      fontFamily: 'Courier',
      color: '#000000',
      backgroundColor: '#FFFFFF',
    });
  });

  it.each([
    ['ABCDEF+CourierNewPS-BoldOblique', undefined, 'Courier', true, true],
    ['f-serif', 'Cambria Italic', 'Merriweather', false, true],
    ['Arial-Semibold', 'Arial', 'Helvetica', true, false],
    ['generated-f1', undefined, 'Helvetica', false, false],
  ])(
    'maps %s / %s to supported style',
    (fontName, fontFamily, expectedFamily, bold, italic) => {
      const source = { ...item('Styled', 60, 760, 40, 15), fontName };
      const [result] = convertPdfTextItems(
        [source],
        { [fontName]: { ascent: 0.8, fontFamily } },
        viewport
      );
      expect(result).toMatchObject({
        fontFamily: expectedFamily,
        bold,
        italic,
        fontSize: 15,
        rotation: 0,
      });
    }
  );

  it('merges adjacent same-style items into a phrase', () => {
    const result = convertPdfTextItems(
      [item('Hello', 60, 760, 40), item('world', 105, 760, 45)],
      { f1: { ascent: 0.8 } },
      viewport
    );

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Hello world');
  });

  it('merges mixed bold/italic items with same font family using first item style', () => {
    const result = convertPdfTextItems(
      [
        { ...item('First', 60, 760, 40), fontName: 'Helvetica-Bold' },
        { ...item('Second', 105, 760, 45), fontName: 'Helvetica-Oblique' },
      ],
      {
        'Helvetica-Bold': { ascent: 0.8, fontFamily: 'Helvetica' },
        'Helvetica-Oblique': { ascent: 0.8, fontFamily: 'Helvetica' },
      },
      viewport
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      text: 'First Second',
      fontFamily: 'Helvetica',
      bold: true,
      italic: false,
    });
  });

  it('merges whitespace-filtered gap items into one phrase', () => {
    const result = convertPdfTextItems(
      [
        item('First', 60, 760, 40),
        item(' ', 100, 760, 4),
        item('Last', 104, 760, 35),
      ],
      { f1: { ascent: 0.8 } },
      viewport
    );

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('First Last');
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
    const coverBottom = coverTop + (result.geometry.height / 100) * 800;

    expect(coverTop).toBeLessThanOrEqual(emTop + 0.5);
    expect(coverBottom).toBeGreaterThanOrEqual(emBottom);
    expect(coverBottom).toBeLessThan(emBottom + 6);
    expect(result.fontSize).toBe(12);
  });

  it('clamps cover height so it does not swallow the next line', () => {
    const upper = item('Joynd Cloud', 60, 700, 120, 12);
    const lower = item('550 n main', 60, 700 - 15, 100, 12);

    const [first, second] = convertPdfTextItems(
      [upper, lower],
      { f1: { ascent: 0.8 } },
      viewport
    );

    const firstBottom =
      (first.geometry.y / 100) * 800 + (first.geometry.height / 100) * 800;
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

describe('calculateReplacementBounds', () => {
  it('stops horizontal growth before same-line neighbors and vertical growth before content below', () => {
    const selected = nativeItem('amount', {
      x: 85,
      y: 10,
      width: 10,
      height: 3,
    });
    const label = nativeItem('balance-label', {
      x: 65,
      y: 10,
      width: 18,
      height: 3,
    });
    const below = nativeItem('invoice-date', {
      x: 84,
      y: 18,
      width: 11,
      height: 3,
    });

    expect(
      calculateReplacementBounds(selected, [selected, label, below])
    ).toEqual({
      xMin: 83.25,
      xMax: 100,
      yMax: 17.75,
    });
  });

  it('ignores text with a different rotation', () => {
    const selected = nativeItem('selected', {
      x: 40,
      y: 20,
      width: 10,
      height: 3,
    });
    const rotated = nativeItem(
      'rotated',
      { x: 20, y: 20, width: 18, height: 3 },
      90
    );

    expect(calculateReplacementBounds(selected, [selected, rotated])).toEqual({
      xMin: 0,
      xMax: 100,
      yMax: 100,
    });
  });
});

describe('phrase-level merging', () => {
  it('merges "Car-" + "$55" into one phrase with space', () => {
    const result = convertPdfTextItems(
      [item('Car-', 60, 760, 30), item('$55', 93, 760, 25)],
      { f1: { ascent: 0.8 } },
      viewport
    );

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Car- $55');
    expect(result[0].fontSize).toBe(12);
    expect(result[0].rotation).toBe(0);
  });

  it('merges "May" + "2017" into one phrase with space', () => {
    const result = convertPdfTextItems(
      [item('May', 60, 760, 25), item('2017', 89, 760, 30)],
      { f1: { ascent: 0.8 } },
      viewport
    );

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('May 2017');
  });

  it('does NOT merge items with a large horizontal gap (columns)', () => {
    const result = convertPdfTextItems(
      [item('Name', 60, 760, 30), item('Value', 200, 760, 40)],
      { f1: { ascent: 0.8 } },
      viewport
    );

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('Name');
    expect(result[1].text).toBe('Value');
  });

  it('does NOT merge items on different baselines/lines', () => {
    const result = convertPdfTextItems(
      [item('Line1', 60, 760, 40), item('Line2', 60, 740, 40)],
      { f1: { ascent: 0.8 } },
      viewport
    );

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('Line1');
    expect(result[1].text).toBe('Line2');
  });

  it('does NOT merge items with different rotation', () => {
    const horizontal = item('Horiz', 60, 760, 40);
    const rotated = {
      str: 'Rotated',
      transform: [0, 12, -12, 0, 100, 760],
      width: 50,
      height: 12,
      fontName: 'f1',
    };

    const result = convertPdfTextItems(
      [horizontal, rotated],
      { f1: { ascent: 0.8 } },
      viewport
    );

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('Horiz');
    expect(result[1].text).toBe('Rotated');
  });

  it('does NOT merge items with clearly different font size', () => {
    const result = convertPdfTextItems(
      [item('Big', 60, 760, 40, 16), item('Small', 110, 760, 30, 10)],
      { f1: { ascent: 0.8 } },
      viewport
    );

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('Big');
    expect(result[1].text).toBe('Small');
  });

  it('merges rotated (~90deg) adjacent fragments along advance direction', () => {
    const result = convertPdfTextItems(
      [
        {
          str: 'May',
          transform: [0, 12, -12, 0, 100, 500],
          width: 25,
          height: 12,
          fontName: 'f1',
        },
        {
          str: '2017',
          transform: [0, 12, -12, 0, 100, 529],
          width: 30,
          height: 12,
          fontName: 'f1',
        },
      ],
      { f1: { ascent: 0.8 } },
      viewport
    );

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('May 2017');
    expect(result[0].rotation).toBe(-90);
  });

  it('keeps a single isolated item unchanged', () => {
    const [result] = convertPdfTextItems(
      [item('Alone', 60, 760, 50)],
      { f1: { ascent: 0.8 } },
      viewport
    );

    expect(result.text).toBe('Alone');
    expect(result.id).toBe('text-item-0');
    expect(result.fontSize).toBe(12);
  });

  it('inserts space for whitespace gap but not for abutting items', () => {
    const result = convertPdfTextItems(
      [
        item('ab', 60, 760, 20),
        item('cd', 80, 760, 20),
        item('ef', 100, 760, 20),
      ],
      { f1: { ascent: 0.8 } },
      viewport
    );

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('abcdef');
  });

  it('inserts space when gap represents word boundary', () => {
    const result = convertPdfTextItems(
      [item('hello', 60, 760, 30), item('world', 94, 760, 30)],
      { f1: { ascent: 0.8 } },
      viewport
    );

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('hello world');
  });

  it('produces merged geometry that fully covers both fragments horizontally and vertically', () => {
    const items = [item('Car-', 60, 760, 30), item('$55', 93, 760, 25)];
    const result = convertPdfTextItems(
      items,
      { f1: { ascent: 0.8 } },
      viewport
    );

    expect(result).toHaveLength(1);
    const geom = result[0].geometry;
    const leftPx = (geom.x / 100) * viewport.width;
    const rightPx = leftPx + (geom.width / 100) * viewport.width;
    const topPx = (geom.y / 100) * viewport.height;
    const bottomPx = topPx + (geom.height / 100) * viewport.height;

    const emTop = 800 - 760 - 12 * 0.8;
    const emBottom = emTop + 12;

    expect(leftPx).toBeLessThanOrEqual(60);
    expect(rightPx).toBeGreaterThanOrEqual(93 + 25);
    expect(topPx).toBeLessThanOrEqual(emTop + 0.5);
    expect(bottomPx).toBeGreaterThanOrEqual(emBottom);
  });

  it('merged rotated geometry covers both source fragments after rotation', () => {
    const result = convertPdfTextItems(
      [
        {
          str: 'May',
          transform: [0, 12, -12, 0, 100, 500],
          width: 25,
          height: 12,
          fontName: 'f1',
        },
        {
          str: '2017',
          transform: [0, 12, -12, 0, 100, 529],
          width: 30,
          height: 12,
          fontName: 'f1',
        },
      ],
      { f1: { ascent: 0.8 } },
      viewport
    );

    expect(result).toHaveLength(1);

    const geom = result[0].geometry;
    const widthPx = (geom.width / 100) * viewport.width;
    const heightPx = (geom.height / 100) * viewport.height;

    expect(widthPx).toBeGreaterThan(25 + 30);

    expect(heightPx).toBeGreaterThanOrEqual(12);

    const cy = (geom.y / 100) * viewport.height + heightPx / 2;
    const visualTop = cy - widthPx / 2;
    const visualBottom = cy + widthPx / 2;

    expect(visualBottom - visualTop).toBeGreaterThan(50);
  });

  it('uses first item style and produces deterministic id for merged phrases', () => {
    const result = convertPdfTextItems(
      [
        { ...item('Hello', 60, 760, 40, 14), fontName: 'Arial-Bold' },
        { ...item('World', 104, 760, 45, 14), fontName: 'Arial' },
      ],
      {
        'Arial-Bold': { ascent: 0.8, fontFamily: 'Arial' },
        Arial: { ascent: 0.8, fontFamily: 'Arial' },
      },
      viewport
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fontFamily: 'Helvetica',
      bold: true,
      italic: false,
      fontSize: 14,
    });
    expect(result[0].id).toMatch(/^text-phrase-/);
  });

  it('merges three consecutive fragments into one phrase', () => {
    const result = convertPdfTextItems(
      [item('A', 60, 760, 10), item('B', 73, 760, 10), item('C', 86, 760, 10)],
      { f1: { ascent: 0.8 } },
      viewport
    );

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('A B C');
  });

  it('does not merge when next item slightly precedes current in advance direction (backward jump)', () => {
    const result = convertPdfTextItems(
      [item('End', 200, 760, 40), item('Start', 50, 760, 30)],
      { f1: { ascent: 0.8 } },
      viewport
    );

    expect(result).toHaveLength(2);
  });

  it('uses max fontSize across merged items (I1)', () => {
    const result = convertPdfTextItems(
      [item('A', 60, 760, 20, 12), item('B', 82, 760, 20, 14)],
      { f1: { ascent: 0.8 } },
      viewport
    );

    expect(result).toHaveLength(1);
    expect(result[0].fontSize).toBe(14);
  });

  it('does NOT merge items with different font family (I2)', () => {
    const result = convertPdfTextItems(
      [
        { ...item('Serif', 60, 760, 40), fontName: 'Times-Regular' },
        { ...item('Sans', 105, 760, 40), fontName: 'Arial' },
      ],
      {
        'Times-Regular': { ascent: 0.8, fontFamily: 'Times New Roman' },
        Arial: { ascent: 0.8, fontFamily: 'Arial' },
      },
      viewport
    );

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('Serif');
    expect(result[1].text).toBe('Sans');
  });
});

describe('mapPdfFontToOverlayFamily', () => {
  it.each([
    ['ABCDEF+Calibri', 'Roboto'],
    ['Aptos-Bold', 'Roboto'],
    ['Segoe UI Semibold', 'Roboto'],
    ['ArialMT', 'Helvetica'],
    ['Helvetica-Oblique', 'Helvetica'],
    ['TimesNewRomanPSMT', 'Times-Roman'],
    ['Georgia-Italic', 'Merriweather'],
    ['Garamond', 'Merriweather'],
    ['CourierNewPS-BoldMT', 'Courier'],
    ['Consolas', 'Courier'],
    ['Verdana', 'Roboto'],
    ['', 'Helvetica'],
  ])('maps %s -> %s', (hint, expected) => {
    expect(mapPdfFontToOverlayFamily(hint)).toBe(expected);
  });
});
