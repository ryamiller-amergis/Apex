import { useState, useEffect, useRef } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { ThumbnailRenderState } from '../../shared/types/pdf';

const MAX_CACHE_SIZE = 200;

interface CachedThumbnail {
  imageBitmap: ImageBitmap;
  hasTextContent: boolean;
}

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
    hasTextContent: false,
    error: null,
  });

  const cacheRef = useRef<Map<string, CachedThumbnail>>(new Map());
  const cacheKeysRef = useRef<string[]>([]);

  useEffect(() => {
    if (!document) {
      setState({ status: 'idle', imageBitmap: null, hasTextContent: false, error: null });
      return;
    }

    const cacheKey = `${fileUrl ?? ''}:${pageIndex}:${rotation}:${scale}`;
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setState({
        status: 'loaded',
        imageBitmap: cached.imageBitmap,
        hasTextContent: cached.hasTextContent,
        error: null,
      });
      return;
    }

    let cancelled = false;
    setState({ status: 'loading', imageBitmap: null, hasTextContent: false, error: null });

    (async () => {
      try {
        const page = await document.getPage(pageIndex + 1);
        const viewport = page.getViewport({ scale, rotation });
        const canvas = new OffscreenCanvas(viewport.width, viewport.height);
        const canvasContext = canvas.getContext('2d')!;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (page as any).render({ canvasContext, viewport, canvas: null }).promise;
        let hasTextContent = false;
        try {
          const textContent = await page.getTextContent();
          hasTextContent = textContent.items.some((item) => {
            return 'str' in item && typeof item.str === 'string' && item.str.trim().length > 0;
          });
        } catch {
          // Text extraction is a conservative signal only; pixel detection remains
          // available for image-only or malformed text layers.
        }
        const bitmap = await createImageBitmap(canvas);

        if (cancelled) {
          bitmap.close();
          return;
        }

        if (cacheRef.current.size >= MAX_CACHE_SIZE) {
          const evictKey = cacheKeysRef.current.shift()!;
          const evicted = cacheRef.current.get(evictKey);
          if (evicted) evicted.imageBitmap.close();
          cacheRef.current.delete(evictKey);
        }

        cacheRef.current.set(cacheKey, { imageBitmap: bitmap, hasTextContent });
        cacheKeysRef.current.push(cacheKey);

        setState({ status: 'loaded', imageBitmap: bitmap, hasTextContent, error: null });
      } catch (err: unknown) {
        if (!cancelled) {
          setState({
            status: 'error',
            imageBitmap: null,
            hasTextContent: false,
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
        bitmap.imageBitmap.close();
      }
      cache.clear();
      cacheKeysRef.current = [];
    };
  }, []);

  return state;
}
