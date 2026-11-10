import {
  collectLogoModelText,
  createCursorSvgLogoProvider,
  extractSvgList,
  isUnavailableLogoModel,
  readLogoModelFailure,
} from '../services/build/cursorSvgLogoProvider';
import { LogoProviderError } from '../services/build/logoImageProvider';
import { sanitizeLogoSvg } from '../services/build/logoSvgSanitizer';

const safeSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="180" fill="#2563eb"/></svg>';

describe('Cursor SVG logo provider', () => {
  it('generates, validates, and rasterizes the requested number of options', async () => {
    const rasterize = jest.fn(async (svg: string) =>
      Buffer.from(`png:${svg.length}`)
    );
    const runtime = {
      generate: jest.fn(
        async (_input: {
          prompt: string;
          modelId: string;
          signal: AbortSignal;
        }) => JSON.stringify({ svgs: [safeSvg, safeSvg] })
      ),
    };
    const provider = createCursorSvgLogoProvider({ runtime, rasterize });

    const images = await provider.generate({
      prompt: 'Use a blue compass mark',
      applicationPrompt: 'Create a trip-planning application called Wayfinder.',
      count: 2,
      seed: 42,
      modelId: 'composer-2.5',
    });

    expect(provider.id).toBe('cursor_svg');
    expect(images).toHaveLength(2);
    expect(rasterize).toHaveBeenCalledTimes(2);
    expect(runtime.generate.mock.calls[0]?.[0]?.prompt).toContain('Wayfinder');
  });

  it('reads SVG markup when the model does not return a JSON object', async () => {
    const second =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect x="80" y="80" width="352" height="352" fill="#0f766e"/></svg>';
    const rasterize = jest.fn(async (svg: string) =>
      Buffer.from(`png:${svg.length}`)
    );
    const provider = createCursorSvgLogoProvider({
      rasterize,
      runtime: {
        generate: async () =>
          `Here are two marks:\n${safeSvg}\n${second}`,
      },
    });

    const images = await provider.generate({
      prompt: 'A compass',
      count: 2,
      seed: 1,
    });

    expect(images).toHaveLength(2);
    expect(extractSvgList(`\`\`\`json\n${JSON.stringify({ svgs: [safeSvg] })}\n\`\`\``)).toEqual([
      safeSvg,
    ]);
  });

  it('reports a blocked model so generation can use the logo model', () => {
    const message =
      'Model Blocked This model has been blocked by your team admin settings.';

    expect(
      readLogoModelFailure(
        [{ type: 'status', status: 'ERROR', message }],
        { status: 'error', error: { message } }
      )
    ).toBe(message);
    expect(isUnavailableLogoModel(message)).toBe(true);
    expect(isUnavailableLogoModel('The reply had no SVG.')).toBe(false);
  });

  it('keeps the turn-end answer the fast interactive lane uses', () => {
    const text = collectLogoModelText(
      [
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'partial' }] },
        },
        { type: 'apex_turn_end', text: JSON.stringify({ svgs: [safeSvg] }) },
      ],
      'ignored'
    );

    expect(extractSvgList(text)).toEqual([safeSvg]);
  });

  it('rejects active or externally referenced SVG content', async () => {
    expect(() =>
      sanitizeLogoSvg(
        '<svg viewBox="0 0 512 512"><script>alert(1)</script></svg>'
      )
    ).toThrow(LogoProviderError);
    expect(() =>
      sanitizeLogoSvg(
        '<svg viewBox="0 0 512 512"><image href="https://example.test/logo.png"/></svg>'
      )
    ).toThrow(LogoProviderError);
  });
});
