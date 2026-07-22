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

  it('never shrinks below the original cover size', () => {
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      font: '',
      measureText: (value: string) => ({ width: value.length * 4 }),
    } as unknown as CanvasRenderingContext2D);

    const fitted = fitReplacementGeometry(base, 'Hi', 600, 800);
    expect(fitted.width).toBeGreaterThanOrEqual(base.width);
    expect(fitted.height).toBe(base.height);
    expect(fitted.x).toBe(base.x);
    expect(fitted.y).toBe(base.y);
  });

  it('grows width when replacement text is longer than the cover', () => {
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      font: '',
      measureText: (value: string) => ({ width: value.length * 10 }),
    } as unknown as CanvasRenderingContext2D);

    const fitted = fitReplacementGeometry(
      base,
      'A much longer replacement phrase',
      600,
      800
    );
    expect(fitted.width).toBeGreaterThan(base.width);
    expect(fitted.height).toBe(base.height);
  });

  it('keeps height locked even when text contains newlines', () => {
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      font: '',
      measureText: (value: string) => ({ width: value.length * 8 }),
    } as unknown as CanvasRenderingContext2D);

    const fitted = fitReplacementGeometry(
      base,
      'line one\nline two\nline three',
      600,
      800
    );
    expect(fitted.height).toBe(base.height);
    expect(fitted.width).toBeGreaterThan(base.width);
  });
});
