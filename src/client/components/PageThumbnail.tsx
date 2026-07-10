import React, { useRef, useCallback, useEffect } from 'react';
import { usePdfDocument } from '../hooks/usePdfDocument';
import { useThumbnailRenderer } from '../hooks/useThumbnailRenderer';
import { useBlankDetection } from '../hooks/useBlankDetection';
import { BlankPageBadge } from './BlankPageBadge';
import styles from './PageThumbnail.module.css';

const THUMBNAIL_WIDTH = 180;
const THUMBNAIL_HEIGHT = Math.round(THUMBNAIL_WIDTH * (22 / 17));

export interface PageThumbnailProps {
  pageId: string;
  fileUrl: string;
  sourcePageIndex: number;
  rotation: 0 | 90 | 180 | 270;
  assemblyPosition: number;
  sourceFileName: string;
  originalPageNumber: number;
  isSelected: boolean;
  onSelect: (pageId: string, shiftKey: boolean) => void;
  onPreview: (pageId: string) => void;
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

  const { isBlank } = useBlankDetection(canvasRef.current, imageBitmap);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        onSelect(pageId, e.shiftKey);
      } else {
        onPreview(pageId);
      }
    },
    [onSelect, onPreview, pageId],
  );

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
  ]
    .filter(Boolean)
    .join(' ');

  const ariaLabel = `${assemblyPosition} — ${sourceFileName} page ${originalPageNumber}.${isBlank ? ' Likely blank page.' : ''} Click or press Enter to preview.`;

  return (
    <div
      ref={cardRef}
      className={cardClassName}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="gridcell"
      aria-label={ariaLabel}
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
        <BlankPageBadge isBlank={isBlank} pageIndex={assemblyPosition - 1} />
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
