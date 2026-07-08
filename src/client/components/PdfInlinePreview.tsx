import React, { useRef, useEffect, useState, useCallback } from 'react';
import { PdfWorkerProvider } from '../contexts/PdfWorkerContext';
import { usePdfDocument } from '../hooks/usePdfDocument';
import styles from './PdfInlinePreview.module.css';

export interface PdfInlinePreviewProps {
  sessionId: string;
  fileId: string | null;
  sourcePageIndex: number;
  rotation: 0 | 90 | 180 | 270;
  sourceFileName: string;
  originalPageNumber: number;
}

const MAX_SCALE = 3;

const PdfInlinePreviewInner: React.FC<PdfInlinePreviewProps> = ({
  fileId,
  sessionId,
  sourcePageIndex,
  rotation,
  sourceFileName,
  originalPageNumber,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  const fileUrl = fileId ? `/api/pdf/sessions/${sessionId}/files/${fileId}` : null;
  const { document, isLoading: isDocLoading } = usePdfDocument(fileUrl);

  const updateSize = useCallback(() => {
    if (containerRef.current) {
      const { clientWidth, clientHeight } = containerRef.current;
      setContainerSize({ width: clientWidth, height: clientHeight });
    }
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateSize]);

  useEffect(() => {
    if (!document || !fileId) return;

    let cancelled = false;
    setIsRendering(true);

    (async () => {
      try {
        const page = await document.getPage(sourcePageIndex + 1);
        const viewport = page.getViewport({ scale: 1, rotation });

        const availWidth = Math.max(containerSize.width - 16, 100);
        const availHeight = Math.max(containerSize.height - 32, 100);
        const scale = Math.min(
          availWidth / viewport.width,
          availHeight / viewport.height,
          MAX_SCALE,
        );

        const scaledViewport = page.getViewport({ scale, rotation });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;

        canvas.width = scaledViewport.width;
        canvas.height = scaledViewport.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          if (!cancelled) setIsRendering(false);
          return;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (page as any).render({ canvasContext: ctx, viewport: scaledViewport, canvas: null }).promise;

        if (!cancelled) setIsRendering(false);
      } catch {
        if (!cancelled) setIsRendering(false);
      }
    })();

    return () => { cancelled = true; };
  }, [document, fileId, sourcePageIndex, rotation, containerSize]);

  if (!fileId) {
    return (
      <div className={styles.emptyBanner} data-testid="pdf-inline-preview">
        <svg className={styles.emptyBannerIcon} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 10m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
          <path d="M18 10c-3.6 4-10.4 4-14 0" />
          <path d="M4 10c3.6-4 10.4-4 14 0" />
        </svg>
        <p className={styles.emptyBannerText}>Click a thumbnail to preview the page</p>
      </div>
    );
  }

  const showSpinner = isDocLoading || isRendering;

  return (
    <div className={styles.container} ref={containerRef} data-testid="pdf-inline-preview">
      {showSpinner && (
        <div className={styles.loadingWrapper}>
          <div className={styles.spinner} />
          <p className={styles.loadingText}>Loading preview…</p>
        </div>
      )}
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        style={{ display: showSpinner ? 'none' : 'block' }}
      />
      {!showSpinner && (
        <p className={styles.sourceInfo}>
          {sourceFileName} — Page {originalPageNumber}
        </p>
      )}
    </div>
  );
};

export const PdfInlinePreview: React.FC<PdfInlinePreviewProps> = (props) => {
  if (!props.fileId) {
    return <PdfInlinePreviewInner {...props} />;
  }

  return (
    <PdfWorkerProvider>
      <PdfInlinePreviewInner {...props} />
    </PdfWorkerProvider>
  );
};
