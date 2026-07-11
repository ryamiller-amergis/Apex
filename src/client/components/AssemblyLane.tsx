import React, { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { Grid, type GridImperativeAPI } from 'react-window';
import { PageThumbnail } from './PageThumbnail';
import { ManipulationToolbar } from './ManipulationToolbar';
import type { PageManifestEntry, PdfFileMetadata } from '../../shared/types/pdf';
import styles from './AssemblyLane.module.css';

const THUMBNAIL_WIDTH = 160;
const THUMBNAIL_HEIGHT = 208;
const MIN_COLUMNS = 1;
const AUTO_SCROLL_ZONE = 60;
const AUTO_SCROLL_MAX_SPEED = 12;

export interface AssemblyLaneProps {
  sessionId: string;
  localManifest: PageManifestEntry[];
  visiblePages: PageManifestEntry[];
  fileMetadata: PdfFileMetadata[];
  documentColors: Map<string, { bg: string; border: string; text: string; label: string }>;
  isSelected: (pageId: string) => boolean;
  selectedCount: number;
  onSelect: (pageId: string, shiftKey: boolean, ctrlKey: boolean) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onRotate: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSave: () => void;
  hasUnsavedChanges: boolean;
  activePageId: string | null;
  onActivePage: (pageId: string) => void;
  onPreview: (pageId: string) => void;
  justMovedPageId: string | null;
  /** Handle a page dropped from the SourceBrowser */
  onAddFromSource?: (pageId: string, insertIndex: number) => void;
}

type DropEdge = 'before' | 'after' | null;

interface ThumbnailCellProps {
  visiblePages: PageManifestEntry[];
  columnCount: number;
  fileNameMap: Map<string, string>;
  documentColors: Map<string, { bg: string; border: string; text: string; label: string }>;
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
  onExternalDragOver: (pageId: string, edge: DropEdge) => void;
  onExternalDrop: (targetPageId: string, externalPageId: string) => void;
}

function ThumbnailCell({
  columnIndex,
  rowIndex,
  style,
  visiblePages,
  columnCount,
  fileNameMap,
  documentColors,
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
  onExternalDragOver,
  onExternalDrop,
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
  const isThisDropTarget = dropTargetId === page.pageId;
  const docColor = documentColors.get(page.fileId);

  const handleCellDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/x-pdf-page')) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      const rect = e.currentTarget.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const edge: DropEdge = e.clientX < midX ? 'before' : 'after';
      onExternalDragOver(page.pageId, edge);
    }
  };

  const handleCellDrop = (e: React.DragEvent) => {
    const externalPageId = e.dataTransfer.getData('application/x-pdf-page');
    if (externalPageId) {
      e.preventDefault();
      e.stopPropagation();
      onExternalDrop(page.pageId, externalPageId);
    }
  };

  return (
    <div
      style={style}
      className={styles.gridCell}
      onDragOver={handleCellDragOver}
      onDrop={handleCellDrop}
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
        colorIndicator={docColor?.border}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDrop={onDrop}
      />
    </div>
  );
}

const AssemblyLaneInner: React.FC<AssemblyLaneProps> = ({
  sessionId,
  visiblePages,
  fileMetadata,
  documentColors,
  isSelected,
  selectedCount,
  onSelect,
  onReorder,
  onRotate,
  onDelete,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  onSave,
  hasUnsavedChanges,
  onPreview,
  justMovedPageId,
  onAddFromSource,
}) => {
  const [containerWidth, setContainerWidth] = useState(800);
  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<GridImperativeAPI>(null);
  const [dragPageId, setDragPageId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropEdge, setDropEdge] = useState<DropEdge>(null);
  const [isExternalDragOver, setIsExternalDragOver] = useState(false);
  const externalDragCounterRef = useRef(0);

  const autoScrollRafRef = useRef<number | null>(null);
  const autoScrollSpeedRef = useRef(0);

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

  const actualColumnWidth = useMemo(
    () => Math.floor(containerWidth / columnCount),
    [containerWidth, columnCount],
  );

  const rowCount = useMemo(
    () => Math.ceil(visiblePages.length / columnCount),
    [visiblePages.length, columnCount],
  );

  // react-window can retain stale cells when an upload appends multiple pages
  // without changing the current viewport. Remount the grid for a new page set
  // so every converted page receives its own thumbnail cell.
  const gridContentKey = useMemo(
    () => `${columnCount}:${visiblePages.map((page) => page.pageId).join(',')}`,
    [columnCount, visiblePages],
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
      const isExternal = e.dataTransfer.types.includes('application/x-pdf-page');
      if (isExternal) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }

      const el = containerRef.current;
      if (!el || (!dragPageId && !isExternal)) return;

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

  const handleContainerDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes('application/x-pdf-page')) {
        externalDragCounterRef.current += 1;
        setIsExternalDragOver(true);
      }
    },
    [],
  );

  const handleContainerDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes('application/x-pdf-page')) {
        externalDragCounterRef.current -= 1;
        if (externalDragCounterRef.current <= 0) {
          externalDragCounterRef.current = 0;
          setIsExternalDragOver(false);
        }
      }
      stopAutoScroll();
    },
    [stopAutoScroll],
  );

  const handleExternalDragOver = useCallback((pageId: string, edge: DropEdge) => {
    setDropTargetId(pageId);
    setDropEdge(edge);
  }, []);

  const handleExternalDrop = useCallback(
    (targetPageId: string, externalPageId: string) => {
      const targetIndex = visiblePages.findIndex((p) => p.pageId === targetPageId);
      const insertAt = dropEdge === 'after' ? targetIndex + 1 : targetIndex;
      onAddFromSource?.(externalPageId, insertAt);
      setDropTargetId(null);
      setDropEdge(null);
      setIsExternalDragOver(false);
      externalDragCounterRef.current = 0;
      stopAutoScroll();
    },
    [visiblePages, dropEdge, onAddFromSource, stopAutoScroll],
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
      if (!dragPageId || dragPageId === targetPageId) {
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
      className={styles.container}
      role="main"
      aria-label="Page assembly"
      data-testid="assembly-lane"
    >
      <ManipulationToolbar
        selectedCount={selectedCount}
        onRotate={onRotate}
        onDelete={onDelete}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        canMoveUp={canMoveUp}
        canMoveDown={canMoveDown}
        totalPages={visiblePages.length}
        onSave={onSave}
        hasUnsavedChanges={hasUnsavedChanges}
      />

      {visiblePages.length === 0 ? (
        <div
          className={`${styles.emptyStateContainer}${isExternalDragOver ? ` ${styles.containerDropTarget}` : ''}`}
          data-testid="assembly-lane-empty"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('application/x-pdf-page')) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDragEnter={(e) => {
            if (e.dataTransfer.types.includes('application/x-pdf-page')) {
              setIsExternalDragOver(true);
            }
          }}
          onDragLeave={(e) => {
            if (e.dataTransfer.types.includes('application/x-pdf-page')) {
              setIsExternalDragOver(false);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            const pageId = e.dataTransfer.getData('application/x-pdf-page');
            if (pageId && onAddFromSource) {
              onAddFromSource(pageId, 0);
            }
            setIsExternalDragOver(false);
          }}
        >
          <div className={styles.emptyStateContent}>
            <svg
              className={styles.emptyStateIcon}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="2" width="8" height="8" rx="1" />
              <rect x="14" y="2" width="8" height="8" rx="1" />
              <rect x="2" y="14" width="8" height="8" rx="1" />
              <rect x="14" y="14" width="8" height="8" rx="1" />
              <line x1="6" y1="10" x2="6" y2="14" />
              <line x1="18" y1="10" x2="18" y2="14" />
            </svg>
            <p className={styles.emptyStateText}>Your assembly is empty</p>
            <p className={styles.emptyStateSubtext}>
              Drag pages from the source panel, or upload documents to get started
            </p>
          </div>
        </div>
      ) : (
        <div
          ref={containerRef}
          className={`${styles.gridContainer}${isExternalDragOver ? ` ${styles.containerDropTarget}` : ''}`}
          onDragOver={handleContainerDragOver}
          onDragEnter={handleContainerDragEnter}
          onDragLeave={handleContainerDragLeave}
        >
          <div className={styles.gridInner}>
            <Grid<ThumbnailCellProps>
              key={gridContentKey}
              cellComponent={ThumbnailCell}
              cellProps={{
                visiblePages,
                columnCount,
                fileNameMap,
                documentColors,
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
                onExternalDragOver: handleExternalDragOver,
                onExternalDrop: handleExternalDrop,
              }}
              gridRef={gridRef}
              columnCount={columnCount}
              columnWidth={actualColumnWidth}
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
      )}
    </div>
  );
};

export const AssemblyLane: React.FC<AssemblyLaneProps> = (props) => {
  return <AssemblyLaneInner {...props} />;
};
