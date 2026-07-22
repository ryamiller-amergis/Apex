import { PDFDocument, PDFPage } from 'pdf-lib';
import type { OverlayTextBox } from '../../shared/types/pdf';
import {
  burnOverlaysOntoPage,
  createStandardFontCache,
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
  const fonts = await createStandardFontCache(document, overlays);
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
});
