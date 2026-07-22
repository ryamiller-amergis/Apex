import { fitReplacementGeometry } from '../fitReplacementGeometry';

describe('fitReplacementGeometry', () => {
  const base = {
    x: 10,
    y: 20,
    width: 8,
    height: 2,
    fontFamily: 'Helvetica' as const,
    fontSize: 12,
    bold: false,
    italic: false,
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const mockMeasureText = (resolver: (value: string) => number) => {
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      font: '',
      measureText: (value: string) => ({ width: resolver(value) }),
    } as unknown as CanvasRenderingContext2D);
  };

  it('uses the longest explicit line for width and line count for height without overshoot', () => {
    mockMeasureText((value) => value.length * 10);
    const fitted = fitReplacementGeometry(
      base,
      'short\r\nthis is the longest line\nmid',
      600,
      800
    );
    const emPx = 12 * (96 / 72);
    expect(fitted.width).toBeCloseTo(
      ((24 * 10 + 12 + emPx * 0.2) / 600) * 100
    );
    const perLineHeightPct = ((emPx * 1.2) / 800) * 100;
    expect(fitted.height).toBeCloseTo(
      Math.max(base.height, 3 * perLineHeightPct)
    );
  });

  it('measures canvas text using pt-to-px converted font size', () => {
    const context = {
      font: '',
      measureText: jest.fn((value: string) => {
        const px = Number(context.font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? '0');
        return { width: value.length * px };
      }),
    } as unknown as CanvasRenderingContext2D;
    jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context);

    const fitted = fitReplacementGeometry(base, 'abcd', 600, 800);
    expect((context as { font: string }).font).toContain('16px');
    expect(fitted.width).toBeCloseTo(((4 * 16 + 12 + 16 * 0.2) / 600) * 100);
  });

  it('leaves a safety margin so same-width replacement text does not wrap-and-clip', () => {
    // Regression for "May 2017" -> "May 2016": the fitted content width must
    // exceed the measured text width, or sub-pixel CSS rendering wraps the last
    // word onto a clipped second line. Zero-margin fit (old formula) fails this.
    const measured = 40;
    mockMeasureText(() => measured);
    const fitted = fitReplacementGeometry(base, 'May 2016', 600, 800);
    const emPx = 12 * (96 / 72);
    const contentWidthPx = (fitted.width / 100) * 600 - 12; // minus 6px CSS pad each side
    expect(contentWidthPx).toBeGreaterThan(measured);
    expect(contentWidthPx).toBeCloseTo(measured + emPx * 0.2);
  });

  it('does not auto-shrink manually enlarged dimensions', () => {
    mockMeasureText(() => 4);
    expect(
      fitReplacementGeometry({ ...base, width: 45, height: 30 }, 'x', 600, 800)
    ).toMatchObject({ width: 45, height: 30 });
  });

  it('clamps growth at the right and bottom page boundaries', () => {
    mockMeasureText(() => 2000);
    expect(
      fitReplacementGeometry({ ...base, x: 90, y: 92 }, 'a\nb\nc\nd', 600, 800)
    ).toMatchObject({ x: 90, y: 92, width: 10, height: 8 });
  });

  it('uses deterministic fallback measurement without a canvas context', () => {
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const fitted = fitReplacementGeometry(base, 'fallback\nline', 600, 800);
    expect(fitted.width).toBeGreaterThanOrEqual(base.width);
    expect(fitted.height).toBeGreaterThan(base.height);
  });

  it('uses displayScale for font measurement instead of pt conversion', () => {
    const context = { font: '', measureText: () => ({ width: 80 }) };
    jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context as unknown as CanvasRenderingContext2D);

    fitReplacementGeometry(base, 'text', 600, 800, 1.75);
    expect((context as { font: string }).font).toContain(`${12 * 1.75}px`);
  });

  it('produces approximately scale-invariant percentage geometry across display scales', () => {
    const makeContext = (scale: number) => ({
      font: '',
      measureText: (t: string) => ({ width: t.length * 8 * scale }),
    });

    jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(makeContext(1.0) as unknown as CanvasRenderingContext2D);
    const at1 = fitReplacementGeometry(base, 'hello world test', 600, 800, 1.0);

    jest.restoreAllMocks();
    jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(
        makeContext(1.75) as unknown as CanvasRenderingContext2D
      );
    const at175 = fitReplacementGeometry(
      base,
      'hello world test',
      600 * 1.75,
      800 * 1.75,
      1.75
    );

    jest.restoreAllMocks();
    jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(makeContext(2.0) as unknown as CanvasRenderingContext2D);
    const at2 = fitReplacementGeometry(
      base,
      'hello world test',
      600 * 2,
      800 * 2,
      2.0
    );

    expect(at1.width).toBeGreaterThan(at175.width);
    expect(at175.width).toBeGreaterThan(at2.width);
    expect(at1.width - at2.width).toBeLessThan(2);
  });

  describe('height overshoot regression', () => {
    const sourceHeight = 1.86;
    const realisticOverlay = {
      ...base,
      height: sourceHeight,
      fontSize: 10,
    };

    it('single-line edit keeps height == source height (no vertical growth)', () => {
      mockMeasureText((v) => v.length * 8);
      const fitted = fitReplacementGeometry(
        realisticOverlay,
        'Sales Assist',
        792,
        612,
        1.0
      );

      expect(fitted.height).toBe(sourceHeight);
    });

    it('longer single-line text grows width only, height unchanged', () => {
      mockMeasureText((v) => v.length * 8);
      const fitted = fitReplacementGeometry(
        realisticOverlay,
        'A much longer replacement string here',
        792,
        612,
        1.0
      );

      expect(fitted.height).toBe(sourceHeight);
      expect(fitted.width).toBeGreaterThan(realisticOverlay.width);
    });

    it('two-line text height ≈ 2x em with 1.2 line-height (matches burn-in)', () => {
      mockMeasureText((v) => v.length * 8);
      const emPx = 10 * 1.0;
      const expectedHeight = ((2 * emPx * 1.2) / 612) * 100;
      const fitted = fitReplacementGeometry(
        realisticOverlay,
        'Line one\nLine two',
        792,
        612,
        1.0
      );

      expect(fitted.height).toBeCloseTo(expectedHeight, 1);
      expect(fitted.height).toBeLessThan(expectedHeight * 1.05);
    });

    it('three-line text height ≈ 3x em with 1.2 line-height (matches burn-in)', () => {
      mockMeasureText((v) => v.length * 8);
      const emPx = 10 * 1.0;
      const expectedHeight = ((3 * emPx * 1.2) / 612) * 100;
      const fitted = fitReplacementGeometry(
        realisticOverlay,
        'One\nTwo\nThree',
        792,
        612,
        1.0
      );

      expect(fitted.height).toBeCloseTo(expectedHeight, 1);
    });

    it('multiline does not add extra padding beyond line-height', () => {
      mockMeasureText((v) => v.length * 8);
      const emPx = 10 * 1.0;
      const fitted = fitReplacementGeometry(
        realisticOverlay,
        'First\nSecond',
        792,
        612,
        1.0
      );

      const occupiedPx = (fitted.height / 100) * 612;
      const expectedPx = 2 * emPx * 1.2;
      expect(occupiedPx).toBeCloseTo(expectedPx, 0);
    });

    it('manual-enlarged height is not auto-shrunk', () => {
      mockMeasureText(() => 10);
      const enlarged = { ...realisticOverlay, height: 10 };
      const fitted = fitReplacementGeometry(enlarged, 'short', 792, 612, 1.0);

      expect(fitted.height).toBe(10);
    });

    it('page-bottom clamp respected for multiline', () => {
      mockMeasureText((v) => v.length * 8);
      const nearBottom = { ...realisticOverlay, y: 95 };
      const fitted = fitReplacementGeometry(
        nearBottom,
        'A\nB\nC\nD\nE\nF',
        792,
        612,
        1.0
      );

      expect(fitted.y + fitted.height).toBeLessThanOrEqual(100);
    });
  });
});
