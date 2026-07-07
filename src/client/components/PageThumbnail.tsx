import React, { useRef, useCallback, useEffect } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import { usePdfDocument } from '../hooks/usePdfDocument';
import { useThumbnailRenderer } from '../hooks/useThumbnailRenderer';
import styles from './PageThumbnail.module.css';

const THUMBNAIL_WIDTH = 180;
const THUMBNAIL_HEIGHT = Math.round(THUMBNAIL_WIDTH * (22 / 17));

const DND_TYPE = 'PAGE_THUMBNAIL';

interface DragItem {
  type: string;
  visibleIndex: number;
  pageId: string;
}

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
  onDrop?: (fromIndex: number, toIndex: number) => void;
  visibleIndex?: number;
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
  onDrop,
  visibleIndex,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const { document, isLoading: isDocLoading } = usePdfDocument(fileUrl);
  const { status, imageBitmap } = useThumbnailRenderer(
    document ?? null,
    sourcePageIndex,
    rotation,
    1,
    fileUrl,
  );

  const [{ isDragging }, dragRef] = useDrag<DragItem, void, { isDragging: boolean }>({
    type: DND_TYPE,
    item: { type: DND_TYPE, visibleIndex: visibleIndex ?? 0, pageId },
    canDrag: () => visibleIndex !== undefined && !!onDrop,
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  });

  const [{ isOver }, dropRef] = useDrop<DragItem, void, { isOver: boolean }>({
    accept: DND_TYPE,
    drop: (item) => {
      if (onDrop && visibleIndex !== undefined && item.visibleIndex !== visibleIndex) {
        onDrop(item.visibleIndex, visibleIndex);
      }
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
    }),
  });

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

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.shiftKey) {
        onSelect(pageId, true, false);
      } else if (e.ctrlKey || e.metaKey) {
        onSelect(pageId, false, true);
      } else {
        onSelect(pageId, false, false);
      }
    },
    [onSelect, pageId],
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
    [onPreview, pageId],
  );

  const isLoading = isDocLoading || status === 'loading' || status === 'idle';
  const isError = status === 'error';

  const cardClassName = [
    styles.thumbnailCard,
    isSelected ? styles.thumbnailCardSelected : '',
    isDragging ? styles.thumbnailCardDragging : '',
    isOver ? styles.thumbnailCardDropTarget : '',
  ]
    .filter(Boolean)
    .join(' ');

  const combinedRef = useCallback(
    (node: HTMLDivElement | null) => {
      (cardRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      dragRef(node);
      dropRef(node);
    },
    [dragRef, dropRef],
  );

  return (
    <div
      ref={combinedRef}
      className={cardClassName}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="gridcell"
      aria-label={`${assemblyPosition} — ${sourceFileName} page ${originalPageNumber}. Click to select, double-click to preview.`}
      aria-selected={isSelected}
      data-testid={`pdf-thumbnail-${assemblyPosition}`}
      data-page-id={pageId}
    >
      <div className={styles.canvasWrapper}>
        {isLoading && <div className={styles.skeleton} data-testid="thumbnail-skeleton" />}
        {isError && (
          <div className={styles.errorState} data-testid="thumbnail-error">
            <span className={styles.errorIcon}>⚠</span>
            <span className={styles.errorText}>Failed</span>
          </div>
        )}
        <canvas ref={canvasRef} className={styles.canvas} />
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
      >
        {sourceFileName} p.{originalPageNumber}
      </div>
    </div>
  );
};
