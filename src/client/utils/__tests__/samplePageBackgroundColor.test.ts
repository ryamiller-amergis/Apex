import { samplePageBackgroundColor } from '../samplePageBackgroundColor';

describe('samplePageBackgroundColor', () => {
  it('returns the page background color around a text region', () => {
    const width = 100;
    const height = 100;
    const pixels = new Uint8ClampedArray(width * height * 4);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const inGlyph = x >= 40 && x < 60 && y >= 40 && y < 52;
        pixels[index] = inGlyph ? 17 : 242;
        pixels[index + 1] = inGlyph ? 17 : 237;
        pixels[index + 2] = inGlyph ? 17 : 230;
        pixels[index + 3] = 255;
      }
    }

    const getImageData = jest.fn(
      (sx: number, sy: number, sw: number, sh: number) => {
        const data = new Uint8ClampedArray(sw * sh * 4);
        for (let row = 0; row < sh; row += 1) {
          for (let col = 0; col < sw; col += 1) {
            const src = ((sy + row) * width + (sx + col)) * 4;
            const dst = (row * sw + col) * 4;
            data[dst] = pixels[src]!;
            data[dst + 1] = pixels[src + 1]!;
            data[dst + 2] = pixels[src + 2]!;
            data[dst + 3] = pixels[src + 3]!;
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
    const getContext = jest.fn(() => ({ getImageData }));

    const canvas = {
      width,
      height,
      getContext,
    } as unknown as HTMLCanvasElement;

    const color = samplePageBackgroundColor(canvas, {
      x: 40,
      y: 40,
      width: 20,
      height: 12,
    });

    expect(getContext).toHaveBeenCalled();
    expect(color).toBe('#F2EDE6');
  });

  it('falls back when the canvas cannot be sampled', () => {
    expect(
      samplePageBackgroundColor(null, {
        x: 10,
        y: 10,
        width: 5,
        height: 2,
      })
    ).toBe('#FFFFFF');
  });
});
