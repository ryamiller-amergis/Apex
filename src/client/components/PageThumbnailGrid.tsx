import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { Grid } from 'react-window';
import { PdfWorkerProvider } from '../contexts/PdfWorkerContext';
import { usePageSelection } from '../hooks/usePageSelection';
import { PageThumbnail } from './PageThumbnail';
import type { PageManifestEntry, PdfFileMetadata } from '../../shared/types/pdf';
import styles from './PageThumbnailGrid.module.css';

const THUMBNAIL_WIDTH = 200;
const THUMBNAIL_HEIGHT = 260;
const MIN_COLUMNS = 1;

export interface PageThumbnailGridProps {
  sessionId: string;
  pageManifest: PageManifestEntry[];
  fileMetadata: PdfFileMetadata[];
  onPreview: (pageId: string) => void;
}

interface ThumbnailCellProps {
  visiblePages: PageManifestEntry[];
  columnCount: number;
  fileNameMap: Map<string, string>;
  sessionId: string;
  isSelected: (pageId: string) => boolean;
  handleSelect: (pageId: string, shiftKey: boolean) => void;
  onPreview: (pageId: string) => void;
}

function ThumbnailCell({
  columnIndex,
  rowIndex,
  style,
  visiblePages,
  columnCount,
  fileNameMap,
  sessionId,
  isSelected,
  handleSelect,
  onPreview,
}: ThumbnailCellProps & {
  ariaAttributes: { 'aria-colindex': number; role: 'gridcell' };
  columnIndex: number;
  rowIndex: number;
  style: React.CSSProperties;
}): React.ReactElement | null {
  const index = rowIndex * columnCount + columnIndex;
  if (index >= visiblePages.length) return null;

  const page = visiblePages[index];
  const assemblyPosition = index + 1;
  const sourceFileName = fileNameMap.get(page.fileId) ?? 'Unknown';
  const originalPageNumber = page.sourcePageIndex + 1;
  const fileUrl = `/api/pdf/sessions/${sessionId}/files/${page.fileId}`;

  return (
    <div
      style={style}
      className={styles.gridCell}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPreview(page.pageId);
        }
      }}
    >
      <PageThumbnail
        pageId={page.pageId}
        fileUrl={fileUrl}
        sourcePageIndex={page.sourcePageIndex}
        rotation={page.rotation}
        assemblyPosition={assemblyPosition}
        sourceFileName={sourceFileName}
        originalPageNumber={originalPageNumber}
        isSelected={isSelected(page.pageId)}
        onSelect={handleSelect}
        onPreview={onPreview}
      />
    </div>
  );
};

const PageThumbnailGridInner: React.FC<PageThumbnailGridProps> = ({
  sessionId,
  pageManifest,
  fileMetadata,
  onPreview,
}) => {
  const [containerWidth, setContainerWidth] = useState(800);
  const containerRef = useRef<HTMLDivElement>(null);

  const { toggleSelection, rangeSelect, isSelected } = usePageSelection();

  const visiblePages = useMemo(
    () => pageManifest.filter((p) => !p.deleted),
    [pageManifest],
  );

  const fileNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of fileMetadata) {
      map.set(f.fileId, f.originalName);
    }
    return map;
  }, [fileMetadata]);

  const allPageIds = useMemo(
    () => visiblePages.map((p) => p.pageId),
    [visiblePages],
  );

  const columnCount = useMemo(
    () => Math.max(MIN_COLUMNS, Math.floor(containerWidth / THUMBNAIL_WIDTH)),
    [containerWidth],
  );

  const rowCount = useMemo(
    () => Math.ceil(visiblePages.length / columnCount),
    [visiblePages.length, columnCount],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleSelect = useCallback(
    (pageId: string, shiftKey: boolean) => {
      if (shiftKey) {
        rangeSelect(pageId, allPageIds);
      } else {
        toggleSelection(pageId);
      }
    },
    [toggleSelection, rangeSelect, allPageIds],
  );

  const containerHeight = containerRef.current?.clientHeight ?? 600;

  return (
    <div
      ref={containerRef}
      className={styles.gridContainer}
      data-testid="pdf-thumbnail-grid"
      role="region"
      aria-label={`Page thumbnail grid, ${visiblePages.length} pages`}
    >
      <div className={styles.gridInner}>
        <Grid<ThumbnailCellProps>
          cellComponent={ThumbnailCell}
          cellProps={{
            visiblePages,
            columnCount,
            fileNameMap,
            sessionId,
            isSelected,
            handleSelect,
            onPreview,
          }}
          columnCount={columnCount}
          columnWidth={THUMBNAIL_WIDTH}
          rowCount={rowCount}
          rowHeight={THUMBNAIL_HEIGHT}
          defaultHeight={containerHeight}
          defaultWidth={containerWidth}
          role="grid"
          aria-rowcount={rowCount}
          aria-colcount={columnCount}
        />
      </div>
    </div>
  );
};

export const PageThumbnailGrid: React.FC<PageThumbnailGridProps> = (props) => {
  return (
    <PdfWorkerProvider>
      <PageThumbnailGridInner {...props} />
    </PdfWorkerProvider>
  );
};
