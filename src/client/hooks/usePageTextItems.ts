import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  convertPdfTextItems,
  type NativePdfTextItem,
  type PdfTextItemLike,
} from '../utils/pdfNativeTextItems';

export type PageTextItemsState =
  | { status: 'idle'; items: NativePdfTextItem[] }
  | { status: 'loading'; items: NativePdfTextItem[] }
  | { status: 'ready'; items: NativePdfTextItem[] }
  | { status: 'unavailable'; items: NativePdfTextItem[] }
  | { status: 'error'; items: NativePdfTextItem[]; message: string };

const cache = new Map<string, NativePdfTextItem[]>();

/** Bump when native-text geometry conversion changes so stale covers are not reused. */
const TEXT_ITEMS_GEOMETRY_VERSION = 4;

export function usePageTextItems(
  document: PDFDocumentProxy | null,
  fileUrl: string | null,
  pageIndex: number,
  rotation: 0 | 90 | 180 | 270,
  enabled: boolean
): PageTextItemsState {
  const [state, setState] = useState<PageTextItemsState>({
    status: 'idle',
    items: [],
  });
  const requestRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'idle', items: [] });
      return;
    }
    if (!document || !fileUrl) {
      setState({ status: 'unavailable', items: [] });
      return;
    }

    const cacheKey = `${fileUrl}:${pageIndex}:${rotation}:g${TEXT_ITEMS_GEOMETRY_VERSION}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      setState({
        status: cached.length > 0 ? 'ready' : 'unavailable',
        items: cached,
      });
      return;
    }

    const requestId = ++requestRef.current;
    setState({ status: 'loading', items: [] });

    void (async () => {
      try {
        const page = await document.getPage(pageIndex + 1);
        const viewport = page.getViewport({ scale: 1, rotation });
        const content = await page.getTextContent();
        if (requestRef.current !== requestId) return;

        const textItems = content.items.filter(
          (item): item is typeof item & PdfTextItemLike => 'str' in item
        );
        const items = convertPdfTextItems(textItems, content.styles, viewport);
        cache.set(cacheKey, items);
        setState({
          status: items.length > 0 ? 'ready' : 'unavailable',
          items,
        });
      } catch (error) {
        if (requestRef.current !== requestId) return;
        setState({
          status: 'error',
          items: [],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      requestRef.current += 1;
    };
  }, [document, enabled, fileUrl, pageIndex, rotation]);

  return state;
}
