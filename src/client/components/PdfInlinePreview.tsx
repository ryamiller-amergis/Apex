import React, { useRef, useEffect, useState, useCallback } from 'react';
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
      <div className={styles.emptyState} data-testid="pdf-inline-preview" role="complementary" aria-label="Page preview">
        <svg className={styles.emptyStateIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <p className={styles.emptyStateText}>Select a page to preview</p>
        <p className={styles.emptyStateSubtext}>Click any thumbnail in the assembly</p>
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
  return <PdfInlinePreviewInner {...props} />;
};
