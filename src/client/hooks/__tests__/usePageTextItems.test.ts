import { renderHook, waitFor } from '@testing-library/react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { usePageTextItems } from '../usePageTextItems';

function item(
  str: string,
  x: number,
  y: number,
  width: number,
  fontSize = 12,
  fontName = 'f1'
) {
  return {
    str,
    transform: [fontSize, 0, 0, fontSize, x, y],
    width,
    height: fontSize,
    fontName,
  };
}

describe('usePageTextItems', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('publishes converted style metadata from PDF.js text content', async () => {
    const document = {
      getPage: jest.fn().mockResolvedValue({
        getViewport: () => ({
          width: 600,
          height: 800,
          scale: 1,
          transform: [1, 0, 0, -1, 0, 800],
        }),
        getTextContent: jest.fn().mockResolvedValue({
          items: [item('Heading', 60, 760, 60, 16)],
          styles: { f1: { ascent: 0.8, fontFamily: 'Cambria Bold Italic' } },
        }),
      }),
    } as unknown as PDFDocumentProxy;

    const { result } = renderHook(() =>
      usePageTextItems(document, '/files/style-v6.pdf', 0, 0, true)
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.items[0]).toMatchObject({
      fontFamily: 'Times-Roman',
      bold: true,
      italic: true,
      fontSize: 16,
    });
  });
});
