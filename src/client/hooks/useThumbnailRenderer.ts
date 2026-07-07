import { useState, useEffect, useRef } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { ThumbnailRenderState } from '../../shared/types/pdf';

const MAX_CACHE_SIZE = 200;

export function useThumbnailRenderer(
  document: PDFDocumentProxy | null,
  pageIndex: number,
  rotation: 0 | 90 | 180 | 270,
  scale: number = 1,
  fileUrl?: string,
): ThumbnailRenderState {
  const [state, setState] = useState<ThumbnailRenderState>({
    status: 'idle',
    imageBitmap: null,
    error: null,
  });

  const cacheRef = useRef<Map<string, ImageBitmap>>(new Map());
  const cacheKeysRef = useRef<string[]>([]);

  useEffect(() => {
    if (!document) {
      setState({ status: 'idle', imageBitmap: null, error: null });
      return;
    }

    const cacheKey = `${fileUrl ?? ''}:${pageIndex}:${rotation}:${scale}`;
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setState({ status: 'loaded', imageBitmap: cached, error: null });
      return;
    }

    let cancelled = false;
    setState({ status: 'loading', imageBitmap: null, error: null });

    (async () => {
      try {
        const page = await document.getPage(pageIndex + 1);
        const viewport = page.getViewport({ scale, rotation });
        const canvas = new OffscreenCanvas(viewport.width, viewport.height);
        const canvasContext = canvas.getContext('2d')!;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (page as any).render({ canvasContext, viewport, canvas: null }).promise;
        const bitmap = await createImageBitmap(canvas);

        if (cancelled) {
          bitmap.close();
          return;
        }

        if (cacheRef.current.size >= MAX_CACHE_SIZE) {
          const evictKey = cacheKeysRef.current.shift()!;
          const evicted = cacheRef.current.get(evictKey);
          if (evicted) evicted.close();
          cacheRef.current.delete(evictKey);
        }

        cacheRef.current.set(cacheKey, bitmap);
        cacheKeysRef.current.push(cacheKey);

        setState({ status: 'loaded', imageBitmap: bitmap, error: null });
      } catch (err: unknown) {
        if (!cancelled) {
          setState({
            status: 'error',
            imageBitmap: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [document, pageIndex, rotation, scale, fileUrl]);

  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      for (const bitmap of cache.values()) {
        bitmap.close();
      }
      cache.clear();
      cacheKeysRef.current = [];
    };
  }, []);

  return state;
}
