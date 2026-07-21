import React, { useRef, useEffect, useState, useCallback } from 'react';
import { usePdfDocument } from '../hooks/usePdfDocument';
import { pdfFileUrl } from '../utils/pdfUrls';
import styles from './PdfInlinePreview.module.css';

export interface PdfInlinePreviewProps {
  sessionId: string;
  fileId: string | null;
  sourcePageIndex: number;
  rotation: 0 | 90 | 180 | 270;
  sourceFileName: string;
  originalPageNumber: number;
}

const MAX_FIT_SCALE = 3;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;
const MAX_RENDER_SCALE = 6;
const RESIZE_RENDER_DELAY_MS = 80;

const PdfInlinePreviewInner: React.FC<PdfInlinePreviewProps> = ({
  fileId,
  sessionId,
  sourcePageIndex,
  rotation,
  sourceFileName,
  originalPageNumber,
}) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderGenerationRef = useRef(0);
  const hasRenderedRef = useRef(false);
  const [isRendering, setIsRendering] = useState(false);
  const [hasRendered, setHasRendered] = useState(false);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);

  const fileUrl = fileId ? pdfFileUrl(sessionId, fileId) : null;
  const { document, isLoading: isDocLoading } = usePdfDocument(fileUrl);

  const updateSize = useCallback(() => {
    if (viewportRef.current) {
      const { clientWidth, clientHeight } = viewportRef.current;
      setContainerSize({ width: clientWidth, height: clientHeight });
    }
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateSize, fileId]);

  useEffect(() => {
    if (fileId) return;
    renderGenerationRef.current += 1;
    hasRenderedRef.current = false;
    setHasRendered(false);
    setIsRendering(false);
  }, [fileId]);

  useEffect(() => {
    if (!document || !fileId) return;
    if (containerSize.width === 0 || containerSize.height === 0) return;

    const generation = ++renderGenerationRef.current;
    let cancelled = false;
    let renderTask: { promise: Promise<unknown>; cancel?: () => void } | null = null;
    setIsRendering(!hasRenderedRef.current);

    const renderTimer = window.setTimeout(async () => {
      try {
        const page = await document.getPage(sourcePageIndex + 1);
        if (cancelled || generation !== renderGenerationRef.current) return;
        const viewport = page.getViewport({ scale: 1, rotation });

        const availWidth = Math.max(containerSize.width - 16, 100);
        const availHeight = Math.max(containerSize.height - 32, 100);
        const fitScale = Math.min(
          availWidth / viewport.width,
          availHeight / viewport.height,
          MAX_FIT_SCALE,
        );
        const scale = Math.min(fitScale * zoom, MAX_RENDER_SCALE);

        const scaledViewport = page.getViewport({ scale, rotation });
        const stagingCanvas = window.document.createElement('canvas');
        stagingCanvas.width = scaledViewport.width;
        stagingCanvas.height = scaledViewport.height;
        const stagingContext = stagingCanvas.getContext('2d');
        if (!stagingContext) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderTask = (page as any).render({
          canvasContext: stagingContext,
          viewport: scaledViewport,
          canvas: stagingCanvas,
        });
        await renderTask!.promise;

        if (cancelled || generation !== renderGenerationRef.current) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = stagingCanvas.width;
        canvas.height = stagingCanvas.height;
        const visibleContext = canvas.getContext('2d');
        if (!visibleContext) return;
        visibleContext.drawImage(stagingCanvas, 0, 0);

        hasRenderedRef.current = true;
        setHasRendered(true);
        setIsRendering(false);
      } catch {
        if (!cancelled && generation === renderGenerationRef.current) {
          setIsRendering(false);
        }
      }
    }, RESIZE_RENDER_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(renderTimer);
      renderTask?.cancel?.();
    };
  }, [document, fileId, sourcePageIndex, rotation, containerSize, zoom]);

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

  const showSpinner = (isDocLoading || isRendering) && !hasRendered;
  const zoomPercent = Math.round(zoom * 100);
  const zoomOut = () => setZoom((current) => Math.max(MIN_ZOOM, current - ZOOM_STEP));
  const zoomIn = () => setZoom((current) => Math.min(MAX_ZOOM, current + ZOOM_STEP));

  return (
    <div className={styles.container} data-testid="pdf-inline-preview">
      <div className={styles.zoomToolbar} role="toolbar" aria-label="Preview zoom controls">
        <button
          type="button"
          className={styles.zoomButton}
          onClick={zoomOut}
          disabled={zoom <= MIN_ZOOM}
          aria-label="Zoom out"
          title="Zoom out"
        >
          −
        </button>
        <span className={styles.zoomValue} data-testid="pdf-preview-zoom">
          {zoomPercent}%
        </span>
        <button
          type="button"
          className={styles.zoomButton}
          onClick={zoomIn}
          disabled={zoom >= MAX_ZOOM}
          aria-label="Zoom in"
          title="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className={styles.fitButton}
          onClick={() => setZoom(1)}
          disabled={zoom === 1}
        >
          Fit
        </button>
      </div>
      <div className={styles.previewViewport} ref={viewportRef}>
        {showSpinner && (
          <div className={styles.loadingWrapper}>
            <div className={styles.spinner} />
            <p className={styles.loadingText}>Loading preview…</p>
          </div>
        )}
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          style={{ visibility: hasRendered ? 'visible' : 'hidden' }}
        />
      </div>
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
