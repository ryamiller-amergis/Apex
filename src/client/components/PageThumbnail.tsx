import React, { useRef, useCallback, useEffect } from 'react';
import { usePdfDocument } from '../hooks/usePdfDocument';
import { useThumbnailRenderer } from '../hooks/useThumbnailRenderer';
import { useBlankDetection } from '../hooks/useBlankDetection';
import { BlankPageBadge } from './BlankPageBadge';
import { OverlayTextBox } from './OverlayTextBox';
import { OverlayThumbnailBadge } from './OverlayThumbnailBadge';
import type { OverlayTextBox as OverlayTextBoxModel } from '../../shared/types/pdf';
import styles from './PageThumbnail.module.css';

const THUMBNAIL_WIDTH = 200;
const THUMBNAIL_HEIGHT = Math.round(THUMBNAIL_WIDTH * (22 / 17));

type DropEdge = 'before' | 'after' | null;
const ASSEMBLY_PAGE_DRAG_TYPE = 'application/x-pdf-assembly-page';
const SOURCE_PAGE_DRAG_TYPE = 'application/x-pdf-page';
const NOOP = () => {};

export interface PageThumbnailProps {
  pageId: string;
  fileUrl: string;
  sourcePageIndex: number;
  rotation: 0 | 90 | 180 | 270;
  assemblyPosition: number;
  sourceFileName: string;
  originalPageNumber: number;
  isSelected: boolean;
  onSelect: (pageId: string, shiftKey: boolean, ctrlKey: boolean) => void;
  onPreview: (pageId: string) => void;
  isDragging?: boolean;
  isDropTarget?: boolean;
  dropEdge?: DropEdge;
  isJustMoved?: boolean;
  /** Optional document color for left border stripe */
  colorIndicator?: string;
  onDragStart?: (pageId: string) => void;
  onDragOver?: (pageId: string, edge: DropEdge) => void;
  onDragEnd?: () => void;
  onDrop?: (pageId: string) => void;
  overlays?: OverlayTextBoxModel[];
}

export const PageThumbnail: React.FC<PageThumbnailProps> = ({
  pageId,
  fileUrl,
  sourcePageIndex,
  rotation,
  assemblyPosition,
  sourceFileName,
  originalPageNumber,
  isSelected,
  onSelect,
  onPreview,
  isDragging = false,
  isDropTarget = false,
  dropEdge = null,
  isJustMoved = false,
  colorIndicator,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
  overlays = [],
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const {
    document,
    isLoading: isDocLoading,
    error: docError,
    retry: retryDoc,
  } = usePdfDocument(fileUrl);
  const { status, imageBitmap, hasTextContent } = useThumbnailRenderer(
    document ?? null,
    sourcePageIndex,
    rotation,
    1,
    fileUrl
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageBitmap) return;

    canvas.width = THUMBNAIL_WIDTH;
    canvas.height = THUMBNAIL_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(imageBitmap, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
    }
  }, [imageBitmap]);

  const { isBlank } = useBlankDetection(
    canvasRef.current,
    imageBitmap,
    hasTextContent
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      onSelect(pageId, e.shiftKey, e.ctrlKey || e.metaKey);
    },
    [onSelect, pageId]
  );

  const handleDoubleClick = useCallback(() => {
    onPreview(pageId);
  }, [onPreview, pageId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        onPreview(pageId);
      }
    },
    [onPreview, pageId]
  );

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(ASSEMBLY_PAGE_DRAG_TYPE, pageId);
      e.dataTransfer.setData('text/plain', pageId);
      onDragStart?.(pageId);
    },
    [pageId, onDragStart]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      // Source-browser drags are handled by the assembly grid cell.
      if (
        Array.from(e.dataTransfer.types ?? []).includes(SOURCE_PAGE_DRAG_TYPE)
      )
        return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = cardRef.current?.getBoundingClientRect();
      if (rect) {
        const midX = rect.left + rect.width / 2;
        const edge: DropEdge = e.clientX < midX ? 'before' : 'after';
        onDragOver?.(pageId, edge);
      } else {
        onDragOver?.(pageId, 'after');
      }
    },
    [pageId, onDragOver]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      // Let source-browser drops bubble to the assembly grid cell.
      if (
        Array.from(e.dataTransfer.types ?? []).includes(SOURCE_PAGE_DRAG_TYPE)
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      onDrop?.(pageId);
    },
    [pageId, onDrop]
  );

  const handleDragEnd = useCallback(() => {
    onDragEnd?.();
  }, [onDragEnd]);

  const isLoading =
    isDocLoading || status === 'loading' || (status === 'idle' && !docError);
  const isError = status === 'error' || !!docError;

  const cardClassName = [
    styles.thumbnailCard,
    isSelected ? styles.thumbnailCardSelected : '',
    isDragging ? styles.thumbnailCardDragging : '',
    isDropTarget && dropEdge === 'before' ? styles.thumbnailCardDropBefore : '',
    isDropTarget && dropEdge === 'after' ? styles.thumbnailCardDropAfter : '',
    isJustMoved ? styles.thumbnailCardJustMoved : '',
  ]
    .filter(Boolean)
    .join(' ');

  const ariaLabel = `${assemblyPosition} — ${sourceFileName} page ${originalPageNumber}.${isBlank ? ' Likely blank page.' : ''} Click to select, double-click to preview.`;

  return (
    <div
      ref={cardRef}
      className={cardClassName}
      style={colorIndicator ? { borderLeftWidth: '5px', borderLeftColor: colorIndicator } : undefined}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      draggable
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragEnd={handleDragEnd}
      tabIndex={0}
      role="gridcell"
      aria-label={ariaLabel}
      aria-selected={isSelected}
      data-testid={`pdf-thumbnail-${assemblyPosition}`}
      data-page-id={pageId}
    >
      {colorIndicator && (
        <div
          className={styles.fileColorStrip}
          style={{ background: colorIndicator }}
          aria-hidden="true"
        />
      )}
      <div className={styles.canvasWrapper}>
        {isLoading && (
          <div className={styles.skeleton} data-testid="thumbnail-skeleton" />
        )}
        {isError && (
          <div className={styles.errorState} data-testid="thumbnail-error">
            <span className={styles.errorIcon}>⚠</span>
            <span className={styles.errorText}>Failed</span>
            {docError && (
              <button
                className={styles.retryButton}
                onClick={(e) => {
                  e.stopPropagation();
                  retryDoc();
                }}
                title="Retry loading"
              >
                Retry
              </button>
            )}
          </div>
        )}
        <canvas ref={canvasRef} className={styles.canvas} />
        {overlays.length > 0 && (
          <div className={styles.overlayPreview} aria-hidden="true">
            {overlays.map((overlay) => (
              <OverlayTextBox
                key={overlay.id}
                overlay={overlay}
                selected={false}
                displayOnly
                onSelect={NOOP}
              />
            ))}
          </div>
        )}
        <BlankPageBadge isBlank={isBlank} pageIndex={assemblyPosition - 1} />
        {overlays.length > 0 && <OverlayThumbnailBadge pageId={pageId} />}
        <div className={styles.previewOverlay}>
          <span className={styles.previewIcon}>🔍</span>
        </div>
      </div>

      <span
        className={styles.positionBadge}
        data-testid={`pdf-thumbnail-position-${assemblyPosition}`}
      >
        {assemblyPosition}
      </span>

      <div
        className={styles.sourceLabel}
        data-testid={`pdf-thumbnail-source-${assemblyPosition}`}
        title={`${sourceFileName} p.${originalPageNumber}`}
        style={colorIndicator ? { color: colorIndicator, fontWeight: 600 } : undefined}
      >
        {sourceFileName} p.{originalPageNumber}
      </div>
    </div>
  );
};
