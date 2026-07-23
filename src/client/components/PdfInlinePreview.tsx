import React, { useRef, useEffect, useState, useCallback } from 'react';
import { usePdfDocument } from '../hooks/usePdfDocument';
import { usePageTextItems } from '../hooks/usePageTextItems';
import { usePdfFormFields } from '../hooks/usePdfFormFields';
import { pdfFileUrl } from '../utils/pdfUrls';
import type {
  OverlayTextBox as OverlayTextBoxModel,
  PdfTextFormFieldDefinition,
  PdfTextFormValue,
  PdfSignatureOverlay,
} from '../../shared/types/pdf';
import type { OverlayBoxGeometry } from '../hooks/overlayGeometry';
import type { OverlaySaveStatus } from '../hooks/useOverlayAutosave';
import type { NativePdfTextItem } from '../utils/pdfNativeTextItems';
import {
  samplePagePerimeterColor,
  samplePageTextColors,
} from '../utils/samplePageBackgroundColor';
import { OverlayTextLayer } from './OverlayTextLayer';
import { PdfFormFieldLayer } from './PdfFormFieldLayer';
import { SignatureOverlayLayer } from './SignatureOverlayLayer';
import styles from './PdfInlinePreview.module.css';

export interface PdfInlinePreviewFormProps {
  /** Field catalog from the session metadata for this page's source file. */
  catalog: PdfTextFormFieldDefinition[];
  /** Currently persisted form values for this session. */
  values: PdfTextFormValue[];
  /** Whether the fill-form tool is currently active. */
  active: boolean;
  /** Whether the session is expired / read-only. */
  readOnly?: boolean;
  /** Render saved values as non-interactive document content. */
  displayOnly?: boolean;
  /** Fired on every field change — drives debounced autosave. */
  onValuesChange: (updated: PdfTextFormValue[]) => void;
}

export interface PdfInlinePreviewOverlayProps {
  pageId: string | null;
  overlays: OverlayTextBoxModel[];
  selectedOverlayId: string | null;
  textToolActive: boolean;
  editorMode?: 'add' | 'replace';
  createLimitMessage: string | null;
  announcement: string;
  canUndo: boolean;
  canRedo: boolean;
  saveStatus: OverlaySaveStatus;
  saveErrorMessage?: string | null;
  readOnly?: boolean;
  replacementDraftGeometry?: {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
  } | null;
  onCreateAt: (xPct: number, yPct: number) => OverlayTextBoxModel | null;
  onSetReplacementDraft?: (item: NativePdfTextItem) => void;
  onExitReplacementMode?: () => void;
  onSelectOverlay: (overlayId: string | null) => void;
  onDeleteSelectedOverlay: () => void;
  onRemoveSelectedNativeText?: () => void;
  onUndoOverlay: () => void;
  onRedoOverlay: () => void;
  onFlushOverlays?: () => Promise<void>;
  onRetryOverlaySave?: () => Promise<void>;
  onBeginOverlayTextEdit?: (overlayId: string) => boolean;
  onUpdateOverlayText?: (text: string, geometry?: OverlayBoxGeometry) => void;
  onCommitOverlayTextEdit?: () => boolean;
  onBeginGeometryEdit: (overlayId: string) => boolean;
  onUpdateOverlayGeometry: (geometry: OverlayBoxGeometry) => void;
  onCommitGeometryEdit: (
    kind: 'move' | 'resize',
    backgroundColor?: string
  ) => void;
  onPageMetricsChange?: (metrics: {
    pageWidthPx: number;
    pageHeightPx: number;
    displayScale: number;
  }) => void;
  onNudgeSelectedOverlay: (deltaXPct: number, deltaYPct: number) => void;
  onBringOverlayForward: () => void;
  onSendOverlayBackward: () => void;
}

export interface PdfInlinePreviewSignatureProps {
  pageId: string;
  overlays: PdfSignatureOverlay[];
  selectedOverlayId: string | null;
  readOnly?: boolean;
  onSelect: (id: string | null) => void;
  onUpdate: (id: string, patch: Partial<PdfSignatureOverlay>) => void;
  onDelete: (id: string) => void;
}

export interface PdfInlinePreviewProps {
  sessionId: string;
  fileId: string | null;
  sourcePageIndex: number;
  rotation: 0 | 90 | 180 | 270;
  sourceFileName: string;
  originalPageNumber: number;
  overlay?: PdfInlinePreviewOverlayProps | null;
  form?: PdfInlinePreviewFormProps | null;
  signature?: PdfInlinePreviewSignatureProps | null;
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
  overlay = null,
  form = null,
  signature = null,
}) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderGenerationRef = useRef(0);
  const hasRenderedRef = useRef(false);
  const [isRendering, setIsRendering] = useState(false);
  const [hasRendered, setHasRendered] = useState(false);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [canvasDisplaySize, setCanvasDisplaySize] = useState({
    width: 0,
    height: 0,
  });
  const [displayScale, setDisplayScale] = useState(1);

  const fileUrl = fileId ? pdfFileUrl(sessionId, fileId) : null;
  const { document, isLoading: isDocLoading } = usePdfDocument(fileUrl);
  const replacementMode = overlay?.editorMode === 'replace';
  const textItemsState = usePageTextItems(
    document,
    fileUrl,
    sourcePageIndex,
    rotation,
    replacementMode
  );

  const { fields: formFields } = usePdfFormFields(
    document,
    fileUrl,
    sourcePageIndex,
    rotation,
    form?.catalog ?? [],
    form?.active ?? false
  );

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
    setCanvasDisplaySize({ width: 0, height: 0 });
  }, [fileId]);

  useEffect(() => {
    if (!document || !fileId) return;
    if (containerSize.width === 0 || containerSize.height === 0) return;

    const generation = ++renderGenerationRef.current;
    let cancelled = false;
    let renderTask: { promise: Promise<unknown>; cancel?: () => void } | null =
      null;
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
          MAX_FIT_SCALE
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
        setDisplayScale(scale);
        setCanvasDisplaySize({
          width: scaledViewport.width,
          height: scaledViewport.height,
        });
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

  useEffect(() => {
    if (canvasDisplaySize.width > 0 && overlay?.onPageMetricsChange) {
      overlay.onPageMetricsChange({
        pageWidthPx: canvasDisplaySize.width,
        pageHeightPx: canvasDisplaySize.height,
        displayScale,
      });
    }
  }, [canvasDisplaySize, displayScale, overlay]);

  const handleSetReplacementDraft = useCallback(
    (item: NativePdfTextItem) => {
      if (!overlay?.onSetReplacementDraft) return;
      const sampled = samplePageTextColors(
        canvasRef.current,
        item.geometry,
        item.rotation
      );
      overlay.onSetReplacementDraft({
        ...item,
        color: sampled.color,
        backgroundColor: sampled.backgroundColor,
      });
    },
    [overlay]
  );

  const handleCommitGeometryEdit = useCallback(
    (kind: 'move' | 'resize', finalGeometry: OverlayBoxGeometry) => {
      if (!overlay) return;
      const selected = overlay.overlays.find(
        (candidate) => candidate.id === overlay.selectedOverlayId
      );
      const backgroundColor =
        kind === 'resize' && selected?.kind === 'replace'
          ? (samplePagePerimeterColor(
              canvasRef.current,
              finalGeometry,
              selected.rotation
            ) ?? undefined)
          : undefined;
      overlay.onCommitGeometryEdit(kind, backgroundColor);
    },
    [overlay]
  );

  if (!fileId) {
    return (
      <div
        className={styles.emptyState}
        data-testid="pdf-inline-preview"
        role="complementary"
        aria-label="Page preview"
      >
        <svg
          className={styles.emptyStateIcon}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <p className={styles.emptyStateText}>Select a page to preview</p>
        <p className={styles.emptyStateSubtext}>
          Click any thumbnail in the assembly
        </p>
      </div>
    );
  }

  const showSpinner = (isDocLoading || isRendering) && !hasRendered;
  const zoomPercent = Math.round(zoom * 100);
  const zoomOut = () =>
    setZoom((current) => Math.max(MIN_ZOOM, current - ZOOM_STEP));
  const zoomIn = () =>
    setZoom((current) => Math.min(MAX_ZOOM, current + ZOOM_STEP));
  const showOverlayLayer =
    Boolean(overlay) && hasRendered && canvasDisplaySize.width > 0;

  return (
    <div className={styles.container} data-testid="pdf-inline-preview">
      <div
        className={styles.zoomToolbar}
        role="toolbar"
        aria-label="Preview zoom controls"
      >
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
        <div
          className={styles.pageStage}
          style={
            canvasDisplaySize.width > 0
              ? {
                  width: canvasDisplaySize.width,
                  height: canvasDisplaySize.height,
                }
              : undefined
          }
        >
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            style={{ visibility: hasRendered ? 'visible' : 'hidden' }}
          />
          {showOverlayLayer && overlay && (
            <OverlayTextLayer
              pageId={overlay.pageId}
              overlays={overlay.overlays}
              selectedOverlayId={overlay.selectedOverlayId}
              textToolActive={overlay.textToolActive}
              replacementMode={replacementMode}
              nativeTextItems={textItemsState.items}
              displayScale={displayScale}
              createLimitMessage={overlay.createLimitMessage}
              announcement={overlay.announcement}
              canUndo={overlay.canUndo}
              canRedo={overlay.canRedo}
              saveStatus={overlay.saveStatus}
              saveErrorMessage={overlay.saveErrorMessage}
              readOnly={overlay.readOnly}
              replacementDraftGeometry={overlay.replacementDraftGeometry}
              onCreateAt={overlay.onCreateAt}
              onSetReplacementDraft={handleSetReplacementDraft}
              onExitReplacementMode={overlay.onExitReplacementMode}
              onSelect={overlay.onSelectOverlay}
              onDeleteSelected={overlay.onDeleteSelectedOverlay}
              onRemoveSelectedNativeText={overlay.onRemoveSelectedNativeText}
              onUndo={overlay.onUndoOverlay}
              onRedo={overlay.onRedoOverlay}
              onFlush={overlay.onFlushOverlays}
              onRetrySave={overlay.onRetryOverlaySave}
              onBeginTextEdit={overlay.onBeginOverlayTextEdit}
              onUpdateText={overlay.onUpdateOverlayText}
              onCommitTextEdit={overlay.onCommitOverlayTextEdit}
              onBeginGeometryEdit={overlay.onBeginGeometryEdit}
              onUpdateGeometry={overlay.onUpdateOverlayGeometry}
              onCommitGeometryEdit={handleCommitGeometryEdit}
              onNudgeSelected={overlay.onNudgeSelectedOverlay}
              onBringForward={overlay.onBringOverlayForward}
              onSendBackward={overlay.onSendOverlayBackward}
            />
          )}
          {showOverlayLayer &&
            replacementMode &&
            textItemsState.status === 'unavailable' && (
              <div className={styles.textUnavailable} role="status">
                This page appears to be image-only and has no searchable text.
                OCR is not available. You can still use Add text. To replace
                existing text, upload a searchable or OCR-processed PDF.
              </div>
            )}
          {showOverlayLayer &&
            replacementMode &&
            textItemsState.status === 'error' && (
              <div className={styles.textUnavailable} role="alert">
                Existing text could not be loaded. Try again or use Add text.
              </div>
            )}
          {form?.active && hasRendered && canvasDisplaySize.width > 0 && fileId && (
            <PdfFormFieldLayer
              fileId={fileId}
              fields={formFields}
              catalog={form.catalog}
              values={form.values}
              readOnly={form.readOnly}
              displayOnly={form.displayOnly}
              onValuesChange={form.onValuesChange}
            />
          )}
          {signature && hasRendered && canvasDisplaySize.width > 0 && (
            <SignatureOverlayLayer
              pageId={signature.pageId}
              sessionId={sessionId}
              overlays={signature.overlays}
              selectedOverlayId={signature.selectedOverlayId}
              readOnly={signature.readOnly}
              onSelect={signature.onSelect}
              onUpdate={signature.onUpdate}
              onDelete={signature.onDelete}
            />
          )}
        </div>
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
