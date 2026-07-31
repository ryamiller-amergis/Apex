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
    // Use a wide box (80%) so none of the three explicit lines wrap. Each char = 10px,
    // longest line = 24 chars = 240px; (80/100)*600 = 480px > 240px → no wrap.
    mockMeasureText((value) => value.length * 10);
    const wideBase = { ...base, width: 80 };
    const fitted = fitReplacementGeometry(
      wideBase,
      'short\r\nthis is the longest line\nmid',
      600,
      800
    );
    const emPx = 12 * (96 / 72);
    expect(fitted.width).toBe(wideBase.width);
    const perLineHeightPct = ((emPx * 1.2) / 800) * 100;
    expect(fitted.height).toBeCloseTo(
      Math.max(wideBase.height, 3 * perLineHeightPct)
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

  it('grows leftward near the right edge before wrapping', () => {
    mockMeasureText(() => 300);
    const fitted = fitReplacementGeometry(
      { ...base, x: 80, width: 12 },
      'A longer replacement near the right edge',
      600,
      800
    );

    expect(fitted.x).toBeLessThan(80);
    expect(fitted.width).toBeGreaterThan(20);
    expect(fitted.x + fitted.width).toBeLessThanOrEqual(100);
    expect(fitted.height).toBeCloseTo(((12 * (96 / 72) * 1.2) / 800) * 100);
  });

  it('stops growth at collision bounds and wraps inside the remaining space', () => {
    mockMeasureText((value) => value.length * 10);
    const fitted = fitReplacementGeometry(
      {
        ...base,
        x: 85,
        y: 10,
        width: 10,
        height: 3,
        replacementBounds: { xMin: 83.25, xMax: 100, yMax: 17.75 },
      },
      'longer replacement',
      600,
      800
    );

    expect(fitted.x).toBeCloseTo(83.25);
    expect(fitted.width).toBeCloseTo(16.75);
    expect(fitted.x + fitted.width).toBeCloseTo(100);
    expect(fitted.replacementOverflow).toBe(false);
  });

  it('marks overflow instead of expanding across neighboring content', () => {
    mockMeasureText((value) => value.length * 10);
    const fitted = fitReplacementGeometry(
      {
        ...base,
        x: 85,
        y: 10,
        width: 10,
        height: 3,
        replacementBounds: { xMin: 83.25, xMax: 100, yMax: 12 },
      },
      'longer replacement',
      600,
      800
    );

    expect(fitted.x).toBeGreaterThanOrEqual(83.25);
    expect(fitted.x + fitted.width).toBeLessThanOrEqual(100);
    expect(fitted.height).toBeCloseTo(2);
    expect(fitted.replacementOverflow).toBe(true);
  });

  it('repairs an oversized persisted height while preserving its width', () => {
    mockMeasureText(() => 4);
    const fitted = fitReplacementGeometry(
      { ...base, width: 45, height: 30 },
      'x',
      600,
      800
    );

    expect(fitted.width).toBe(45);
    expect(fitted.height).toBeCloseTo(((12 * (96 / 72) * 1.2) / 800) * 100);
  });

  it('clamps growth at the right and bottom page boundaries', () => {
    mockMeasureText(() => 2000);
    expect(
      fitReplacementGeometry({ ...base, x: 90, y: 92 }, 'a\nb\nc\nd', 600, 800)
    ).toMatchObject({ x: 0, y: 92, width: 100, height: 8 });
  });

  it('uses deterministic fallback measurement without a canvas context', () => {
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    // Use a wide box so the two explicit lines don't wrap in fallback mode
    const fitted = fitReplacementGeometry(
      { ...base, width: 80 },
      'fallback\nline',
      600,
      800
    );
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

    it('single-line text that fits in the box keeps height == source height', () => {
      // Box is wide enough that 'Sales Assist' (12 chars × 8px = 96px) fits
      // inside (20% × 792px = 158px). Word-wrap never fires → height is max of
      // source height and 1-line em height.
      mockMeasureText((v) => v.length * 8);
      const wideOverlay = { ...realisticOverlay, width: 20 };
      const emPx = 10 * 1.0;
      const oneLinePct = ((emPx * 1.2) / 612) * 100;
      const fitted = fitReplacementGeometry(
        wideOverlay,
        'Sales Assist',
        792,
        612,
        1.0
      );

      expect(fitted.height).toBeCloseTo(Math.max(sourceHeight, oneLinePct));
    });

    it('single-line text wider than box wraps and grows height', () => {
      // Text is longer than the remaining page width → auto-grown width is
      // clamped, text wraps, both width and height grow.
      mockMeasureText((v) => v.length * 8);
      const fitted = fitReplacementGeometry(
        realisticOverlay,
        'a'.repeat(100),
        792,
        612,
        1.0
      );

      expect(fitted.height).toBeGreaterThan(sourceHeight);
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

    it('repairs a previously auto-enlarged height on the next text edit', () => {
      mockMeasureText(() => 10);
      const enlarged = { ...realisticOverlay, height: 10 };
      const fitted = fitReplacementGeometry(enlarged, 'short', 792, 612, 1.0);

      expect(fitted.height).toBeCloseTo(((10 * 1.2) / 612) * 100);
    });

    it('long single-line text that wraps grows the box height', () => {
      // Text is so long (100 chars × 8px = 800px) that even a 90%-wide box
      // (maximum with x=10: 90% × 792 = 712px) cannot fit it on one line.
      // Width is clamped at 90%, wrap prediction fires, height grows.
      mockMeasureText((v) => v.length * 8);
      const emPx = 10 * 1.0;
      const longText = 'a'.repeat(100); // 100 × 8px = 800px > 90% × 792 = 712px
      const fitted = fitReplacementGeometry(
        realisticOverlay,
        longText,
        792,
        612,
        1.0
      );

      // Width expands left and right to the full page before wrapping.
      expect(fitted.x).toBe(0);
      expect(fitted.width).toBeCloseTo(100, 0);
      // Height must grow beyond 1 line since text still wraps at full width.
      const oneLinePct = ((1 * emPx * 1.2) / 612) * 100;
      expect(fitted.height).toBeGreaterThan(oneLinePct);
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
