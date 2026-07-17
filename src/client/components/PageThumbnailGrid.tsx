import React, { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { Grid, type GridImperativeAPI } from 'react-window';
import { PdfWorkerProvider } from '../contexts/PdfWorkerContext';
import { PageThumbnail } from './PageThumbnail';
import type { PageManifestEntry, PdfFileMetadata } from '../../shared/types/pdf';
import { pdfFileUrl } from '../utils/pdfUrls';
import styles from './PageThumbnailGrid.module.css';

const THUMBNAIL_WIDTH = 200;
const THUMBNAIL_HEIGHT = 260;
const MIN_COLUMNS = 1;

export interface PageThumbnailGridProps {
  sessionId: string;
  pageManifest: PageManifestEntry[];
  fileMetadata: PdfFileMetadata[];
  onPreview: (pageId: string) => void;
  isSelected: (pageId: string) => boolean;
  onSelect: (pageId: string, shiftKey: boolean, ctrlKey: boolean) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
  justMovedPageId?: string | null;
}

type DropEdge = 'before' | 'after' | null;

interface ThumbnailCellProps {
  visiblePages: PageManifestEntry[];
  columnCount: number;
  fileNameMap: Map<string, string>;
  sessionId: string;
  isSelected: (pageId: string) => boolean;
  handleSelect: (pageId: string, shiftKey: boolean, ctrlKey: boolean) => void;
  onPreview: (pageId: string) => void;
  dragPageId: string | null;
  dropTargetId: string | null;
  dropEdge: DropEdge;
  justMovedPageId: string | null;
  onDragStart: (pageId: string) => void;
  onDragOver: (pageId: string, edge: DropEdge) => void;
  onDragEnd: () => void;
  onDrop: (pageId: string) => void;
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
  dragPageId,
  dropTargetId,
  dropEdge,
  justMovedPageId,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
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
  const fileUrl = pdfFileUrl(sessionId, page.fileId);
  const isThisDropTarget = dropTargetId === page.pageId;

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
        isDragging={dragPageId === page.pageId}
        isDropTarget={isThisDropTarget}
        dropEdge={isThisDropTarget ? dropEdge : null}
        isJustMoved={justMovedPageId === page.pageId}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDrop={onDrop}
      />
    </div>
  );
};

const AUTO_SCROLL_ZONE = 60;
const AUTO_SCROLL_MAX_SPEED = 12;

const PageThumbnailGridInner: React.FC<PageThumbnailGridProps> = ({
  sessionId,
  pageManifest,
  fileMetadata,
  onPreview,
  isSelected,
  onSelect,
  onReorder,
  justMovedPageId = null,
}) => {
  const [containerWidth, setContainerWidth] = useState(800);
  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<GridImperativeAPI>(null);
  const [dragPageId, setDragPageId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropEdge, setDropEdge] = useState<DropEdge>(null);

  const autoScrollRafRef = useRef<number | null>(null);
  const autoScrollSpeedRef = useRef(0);

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

  useEffect(() => {
    if (!justMovedPageId) return;
    const idx = visiblePages.findIndex((p) => p.pageId === justMovedPageId);
    if (idx < 0) return;
    const row = Math.floor(idx / columnCount);
    try {
      gridRef.current?.scrollToRow({ index: row, align: 'smart', behavior: 'smooth' });
    } catch { /* ignore out-of-range */ }
  }, [justMovedPageId, visiblePages, columnCount]);

  const stopAutoScroll = useCallback(() => {
    autoScrollSpeedRef.current = 0;
    if (autoScrollRafRef.current !== null) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
  }, []);

  const runAutoScroll = useCallback(() => {
    const scrollEl = gridRef.current?.element;
    if (!scrollEl || autoScrollSpeedRef.current === 0) {
      autoScrollRafRef.current = null;
      return;
    }
    scrollEl.scrollTop += autoScrollSpeedRef.current;
    autoScrollRafRef.current = requestAnimationFrame(runAutoScroll);
  }, []);

  const handleContainerDragOver = useCallback(
    (e: React.DragEvent) => {
      const el = containerRef.current;
      if (!el || !dragPageId) return;

      const rect = el.getBoundingClientRect();
      const y = e.clientY;
      const distFromTop = y - rect.top;
      const distFromBottom = rect.bottom - y;

      let speed = 0;
      if (distFromTop < AUTO_SCROLL_ZONE) {
        speed = -AUTO_SCROLL_MAX_SPEED * (1 - distFromTop / AUTO_SCROLL_ZONE);
      } else if (distFromBottom < AUTO_SCROLL_ZONE) {
        speed = AUTO_SCROLL_MAX_SPEED * (1 - distFromBottom / AUTO_SCROLL_ZONE);
      }

      autoScrollSpeedRef.current = speed;
      if (speed !== 0 && autoScrollRafRef.current === null) {
        autoScrollRafRef.current = requestAnimationFrame(runAutoScroll);
      } else if (speed === 0) {
        stopAutoScroll();
      }
    },
    [dragPageId, runAutoScroll, stopAutoScroll],
  );

  const handleDragStart = useCallback((pageId: string) => {
    setDragPageId(pageId);
  }, []);

  const handleDragOver = useCallback((pageId: string, edge: DropEdge) => {
    setDropTargetId(pageId);
    setDropEdge(edge);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDragPageId(null);
    setDropTargetId(null);
    setDropEdge(null);
    stopAutoScroll();
  }, [stopAutoScroll]);

  const handleDrop = useCallback(
    (targetPageId: string) => {
      if (!dragPageId || dragPageId === targetPageId || !onReorder) {
        setDragPageId(null);
        setDropTargetId(null);
        setDropEdge(null);
        stopAutoScroll();
        return;
      }
      const fromIndex = visiblePages.findIndex((p) => p.pageId === dragPageId);
      const toIndex = visiblePages.findIndex((p) => p.pageId === targetPageId);
      if (fromIndex >= 0 && toIndex >= 0) {
        onReorder(fromIndex, toIndex);
      }
      setDragPageId(null);
      setDropTargetId(null);
      setDropEdge(null);
      stopAutoScroll();
    },
    [dragPageId, visiblePages, onReorder, stopAutoScroll],
  );

  useEffect(() => {
    return () => stopAutoScroll();
  }, [stopAutoScroll]);

  const containerHeight = containerRef.current?.clientHeight ?? 600;

  return (
    <div
      ref={containerRef}
      className={styles.gridContainer}
      data-testid="pdf-thumbnail-grid"
      role="region"
      aria-label={`Page thumbnail grid, ${visiblePages.length} pages`}
      onDragOver={handleContainerDragOver}
      onDragLeave={stopAutoScroll}
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
            handleSelect: onSelect,
            onPreview,
            dragPageId,
            dropTargetId,
            dropEdge,
            justMovedPageId,
            onDragStart: handleDragStart,
            onDragOver: handleDragOver,
            onDragEnd: handleDragEnd,
            onDrop: handleDrop,
          }}
          gridRef={gridRef}
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
