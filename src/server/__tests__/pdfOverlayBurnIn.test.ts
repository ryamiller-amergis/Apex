import { PDFDocument, PDFPage, rgb } from 'pdf-lib';
import type { OverlayTextBox } from '../../shared/types/pdf';
import {
  burnOverlaysOntoPage,
  createOverlayFontCache,
  resolveCustomFontPath,
} from '../services/pdfOverlayBurnIn';

function makeOverlay(overrides: Partial<OverlayTextBox> = {}): OverlayTextBox {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    pageId: 'page-1',
    x: 10,
    y: 10,
    width: 40,
    height: 20,
    text: 'Overlay text',
    fontFamily: 'Helvetica',
    fontSize: 14,
    bold: false,
    italic: false,
    color: '#336699',
    horizontalAlign: 'left',
    verticalAlign: 'top',
    opacity: 80,
    rotation: 0,
    listStyle: 'none',
    linkUrl: null,
    linkDisplayText: null,
    zIndex: 1,
    ...overrides,
  };
}

async function createPage(overlays: OverlayTextBox[]) {
  const document = await PDFDocument.create();
  const page = document.addPage([600, 800]);
  const fonts = await createOverlayFontCache(document, overlays);
  return { document, page, fonts };
}

describe('pdfOverlayBurnIn', () => {
  it('VT-01: renders style and geometry in ascending z-order', async () => {
    const overlays = [
      makeOverlay({
        id: '22222222-2222-4222-8222-222222222222',
        text: 'Higher',
        zIndex: 2,
      }),
      makeOverlay({ text: 'Lower', zIndex: 1 }),
    ];
    const { page, fonts } = await createPage(overlays);
    const drawText = jest.spyOn(page, 'drawText');

    burnOverlaysOntoPage(page, overlays, fonts);

    expect(drawText.mock.calls.map(([text]) => text)).toEqual([
      'Lower',
      'Higher',
    ]);
    expect(drawText.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        size: 14,
        opacity: 0.8,
        x: -120,
      })
    );
  });

  it('VT-03: drops whitespace-only overlays', async () => {
    const overlays = [makeOverlay({ text: ' \n\t ' })];
    const { page, fonts } = await createPage(overlays);
    const drawText = jest.spyOn(page, 'drawText');

    burnOverlaysOntoPage(page, overlays, fonts);

    expect(drawText).not.toHaveBeenCalled();
  });

  it('VT-01: applies list markers and configured font variant', async () => {
    const overlays = [
      makeOverlay({
        text: 'First\nSecond',
        listStyle: 'numbered',
        fontFamily: 'Times-Roman',
        bold: true,
        italic: true,
      }),
    ];
    const { page, fonts } = await createPage(overlays);
    const drawText = jest.spyOn(page, 'drawText');

    burnOverlaysOntoPage(page, overlays, fonts);

    expect(drawText.mock.calls.map(([text]) => text)).toEqual([
      '1. First',
      '2. Second',
    ]);
    expect(drawText.mock.calls[0][1]?.font?.name).toBe('Times-BoldItalic');
  });

  it('VT-01: underlines linked text and adds a URI annotation', async () => {
    const overlays = [
      makeOverlay({
        text: 'ignored',
        linkDisplayText: 'Apex link',
        linkUrl: 'https://example.com/apex',
      }),
    ];
    const { document, page, fonts } = await createPage(overlays);
    const drawText = jest.spyOn(page, 'drawText');
    const drawLine = jest.spyOn(page, 'drawLine');

    burnOverlaysOntoPage(page, overlays, fonts);
    await document.save();

    expect(drawText).toHaveBeenCalledWith('Apex link', expect.any(Object));
    expect(drawLine).toHaveBeenCalledTimes(1);
    expect(page.node.Annots()?.size()).toBe(1);
  });

  it('VT-05: draws no box border or background for additive text', async () => {
    const overlays = [makeOverlay()];
    const { page, fonts } = await createPage(overlays);
    const drawRectangle = jest.spyOn(
      page as PDFPage & { drawRectangle: PDFPage['drawRectangle'] },
      'drawRectangle'
    );

    burnOverlaysOntoPage(page, overlays, fonts);

    expect(drawRectangle).not.toHaveBeenCalled();
  });

  it('draws an opaque cover before replacement text', async () => {
    const overlays = [
      makeOverlay({
        kind: 'replace',
        backgroundColor: '#FFFFFF',
        text: 'Replacement',
      }),
    ];
    const { page, fonts } = await createPage(overlays);
    const drawRectangle = jest.spyOn(page, 'drawRectangle');
    const drawText = jest.spyOn(page, 'drawText');

    burnOverlaysOntoPage(page, overlays, fonts);

    expect(drawRectangle).toHaveBeenCalledWith(
      expect.objectContaining({ opacity: 1 })
    );
    expect(drawRectangle.mock.invocationCallOrder[0]).toBeLessThan(
      drawText.mock.invocationCallOrder[0]
    );
  });

  it('limits the cover to immutable source geometry when replacement text expands', async () => {
    const overlays = [
      makeOverlay({
        kind: 'replace',
        backgroundColor: '#FFFFFF',
        x: 60,
        y: 10,
        width: 35,
        height: 12,
        replacementCover: { x: 85, y: 10, width: 10, height: 3 },
        text: 'Expanded replacement',
      }),
    ];
    const { page, fonts } = await createPage(overlays);
    const drawRectangle = jest.spyOn(page, 'drawRectangle');

    burnOverlaysOntoPage(page, overlays, fonts);

    expect(drawRectangle).toHaveBeenCalledWith(
      expect.objectContaining({
        x: -30,
        y: -12,
        width: 60,
        height: 24,
        opacity: 1,
      })
    );
  });

  it('keeps a replacement cover when its text is cleared', async () => {
    const overlays = [
      makeOverlay({
        kind: 'replace',
        backgroundColor: '#FFFFFF',
        text: '',
      }),
    ];
    const { page, fonts } = await createPage(overlays);
    const drawRectangle = jest.spyOn(page, 'drawRectangle');
    const drawText = jest.spyOn(page, 'drawText');

    burnOverlaysOntoPage(page, overlays, fonts);

    expect(drawRectangle).toHaveBeenCalledTimes(1);
    expect(drawText).not.toHaveBeenCalled();
  });

  it('burns multiline replacement style, colors, final cover, and rotation', async () => {
    const overlays = [
      makeOverlay({
        kind: 'replace',
        text: 'First line\nSecond line',
        fontFamily: 'Courier',
        fontSize: 16,
        bold: true,
        italic: true,
        color: '#F8FAFC',
        backgroundColor: '#17365D',
        x: 12,
        y: 18,
        width: 46,
        height: 24,
        rotation: 15,
      }),
    ];
    const { page, fonts } = await createPage(overlays);
    const drawRectangle = jest.spyOn(page, 'drawRectangle');
    const drawText = jest.spyOn(page, 'drawText');
    const pushOperators = jest.spyOn(page, 'pushOperators');

    burnOverlaysOntoPage(page, overlays, fonts);

    expect(drawRectangle).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 276,
        height: 192,
        color: rgb(23 / 255, 54 / 255, 93 / 255),
        opacity: 1,
      })
    );
    expect(drawText.mock.calls.map(([text]) => text)).toEqual([
      'First line',
      'Second line',
    ]);
    expect(drawText.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        size: 16,
        color: rgb(248 / 255, 250 / 255, 252 / 255),
      })
    );
    expect(drawText.mock.calls[0][1]?.font?.name).toBe('Courier-BoldOblique');
    const transformOperators = pushOperators.mock.calls
      .flatMap((call) => call)
      .filter(
        (operator) => (operator as unknown as { name?: string }).name === 'cm'
      );
    expect(transformOperators).toHaveLength(4);
    const [a, b, c, d, e, f] = (
      transformOperators[3] as unknown as {
        args: Array<{ numberValue: number }>;
      }
    ).args.map((value) => value.numberValue);
    expect(a).toBeCloseTo(Math.cos((15 * Math.PI) / 180), 10);
    expect(b).toBeCloseTo(Math.sin((15 * Math.PI) / 180), 10);
    expect(c).toBeCloseTo(-Math.sin((15 * Math.PI) / 180), 10);
    expect(d).toBeCloseTo(Math.cos((15 * Math.PI) / 180), 10);
    expect(e).toBeCloseTo(210, 10);
    expect(f).toBeCloseTo(560, 10);
    expect(
      (drawText.mock.calls[0][1]?.y as number) -
        (drawText.mock.calls[1][1]?.y as number)
    ).toBeCloseTo(19.2);
  });

  it('VT-01: wraps text to the overlay width', async () => {
    const overlays = [
      makeOverlay({
        width: 5,
        text: 'one two three four',
      }),
    ];
    const { page, fonts } = await createPage(overlays);
    const drawText = jest.spyOn(page, 'drawText');

    burnOverlaysOntoPage(page, overlays, fonts);

    expect(drawText.mock.calls.length).toBeGreaterThan(1);
  });

  it('skips inactive replacement (coverActive === false) entirely', async () => {
    const overlays = [
      makeOverlay({
        kind: 'replace',
        backgroundColor: '#FFFFFF',
        coverActive: false,
        text: 'Sales Assistant',
      }),
    ];
    const { page, fonts } = await createPage(overlays);
    const drawText = jest.spyOn(page, 'drawText');
    const drawRectangle = jest.spyOn(page, 'drawRectangle');

    burnOverlaysOntoPage(page, overlays, fonts);

    expect(drawText).not.toHaveBeenCalled();
    expect(drawRectangle).not.toHaveBeenCalled();
  });

  it('burns replacement with coverActive undefined (backward compat)', async () => {
    const overlays = [
      makeOverlay({
        kind: 'replace',
        backgroundColor: '#FFFFFF',
        text: 'Existing text',
      }),
    ];
    const { page, fonts } = await createPage(overlays);
    const drawText = jest.spyOn(page, 'drawText');
    const drawRectangle = jest.spyOn(page, 'drawRectangle');

    burnOverlaysOntoPage(page, overlays, fonts);

    expect(drawRectangle).toHaveBeenCalled();
    expect(drawText).toHaveBeenCalled();
  });
});

describe('createOverlayFontCache — custom fonts', () => {
  it('resolves a bundled font path by family and variant', () => {
    expect(resolveCustomFontPath('Roboto', 'boldItalic')).toMatch(
      /public[\\/]fonts[\\/]pdf[\\/]Roboto-BoldItalic\.ttf$/
    );
    expect(resolveCustomFontPath('Noto Sans', 'regular')).toMatch(
      /NotoSans-Regular\.ttf$/
    );
  });

  it('registers fontkit and embeds a custom font from bundled bytes', async () => {
    const document = await PDFDocument.create();
    const registerSpy = jest.spyOn(document, 'registerFontkit');
    const fakeFont = { name: 'Roboto' } as unknown as never;
    const embedSpy = jest
      .spyOn(document, 'embedFont')
      .mockResolvedValue(fakeFont);

    const overlays = [makeOverlay({ fontFamily: 'Roboto', bold: true })];
    const cache = await createOverlayFontCache(document, overlays);

    expect(registerSpy).toHaveBeenCalled();
    expect(embedSpy).toHaveBeenCalledWith(expect.anything(), { subset: true });
    expect(cache.size).toBe(1);
  });

  it('still embeds standard fonts without fontkit', async () => {
    const document = await PDFDocument.create();
    const registerSpy = jest.spyOn(document, 'registerFontkit');
    const overlays = [makeOverlay({ fontFamily: 'Helvetica' })];
    const cache = await createOverlayFontCache(document, overlays);
    expect(cache.size).toBe(1);
    expect(registerSpy).not.toHaveBeenCalled();
  });
});
