import React, {
  useState,
  useRef,
  useMemo,
  useEffect,
  useLayoutEffect,
  useCallback,
} from 'react';
import { Grid, type GridImperativeAPI } from 'react-window';
import { PageThumbnail } from './PageThumbnail';
import { ManipulationToolbar } from './ManipulationToolbar';
import type { PageManifestEntry, PdfFileMetadata } from '../../shared/types/pdf';
import { pdfFileUrl } from '../utils/pdfUrls';
import styles from './AssemblyLane.module.css';

// PageThumbnail is 200px wide. Grid cells include 8px of padding on each side,
// and the row height also accommodates the portrait canvas and source label.
const THUMBNAIL_WIDTH = 216;
const THUMBNAIL_HEIGHT = 304;
const MIN_COLUMNS = 1;
const AUTO_SCROLL_ZONE = 140;
const AUTO_SCROLL_MIN_SPEED = 60;
const AUTO_SCROLL_MAX_SPEED = 700;
const ASSEMBLY_PAGE_DRAG_TYPE = 'application/x-pdf-assembly-page';
const SOURCE_PAGE_DRAG_TYPE = 'application/x-pdf-page';

export interface AssemblyLaneProps {
  sessionId: string;
  localManifest: PageManifestEntry[];
  visiblePages: PageManifestEntry[];
  fileMetadata: PdfFileMetadata[];
  documentColors: Map<string, { bg: string; border: string; text: string; label: string }>;
  isSelected: (pageId: string) => boolean;
  selectedCount: number;
  onSelectAll: () => void;
  onDeselectAll: () => void;
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
type VerticalScrollEdge = 'up' | 'down' | null;
type HorizontalScrollEdge = 'left' | 'right' | null;

function getAutoScrollSpeed(pointer: number, start: number, end: number): number {
  let direction = 0;
  let proximity = 0;

  if (pointer < start + AUTO_SCROLL_ZONE) {
    direction = -1;
    proximity = 1 - (pointer - start) / AUTO_SCROLL_ZONE;
  } else if (pointer > end - AUTO_SCROLL_ZONE) {
    direction = 1;
    proximity = 1 - (end - pointer) / AUTO_SCROLL_ZONE;
  }

  if (direction === 0) return 0;

  const clampedProximity = Math.min(1, Math.max(0, proximity));
  if (clampedProximity === 0) return 0;

  const speed =
    AUTO_SCROLL_MIN_SPEED +
    (AUTO_SCROLL_MAX_SPEED - AUTO_SCROLL_MIN_SPEED) *
      clampedProximity *
      clampedProximity;
  return direction * speed;
}

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
  const fileUrl = pdfFileUrl(sessionId, page.fileId);
  const isThisDropTarget = dropTargetId === page.pageId;
  const docColor = documentColors.get(page.fileId);

  const handleCellDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(SOURCE_PAGE_DRAG_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const rect = e.currentTarget.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const edge: DropEdge = e.clientX < midX ? 'before' : 'after';
      onExternalDragOver(page.pageId, edge);
      return;
    }

    if (
      e.dataTransfer.types.includes(ASSEMBLY_PAGE_DRAG_TYPE) ||
      e.dataTransfer.types.includes('text/plain')
    ) {
      // Thumbnail cards calculate their own before/after edge. Let their
      // drag-over bubble only for lane-level auto-scroll handling.
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = e.currentTarget.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const edge: DropEdge = e.clientX < midX ? 'before' : 'after';
      onDragOver(page.pageId, edge);
    }
  };

  const handleCellDrop = (e: React.DragEvent) => {
    const externalPageId = e.dataTransfer.getData(SOURCE_PAGE_DRAG_TYPE);
    if (externalPageId) {
      e.preventDefault();
      e.stopPropagation();
      onExternalDrop(page.pageId, externalPageId);
      return;
    }

    const internalPageId =
      e.dataTransfer.getData(ASSEMBLY_PAGE_DRAG_TYPE) ||
      e.dataTransfer.getData('text/plain');
    if (internalPageId) {
      e.preventDefault();
      e.stopPropagation();
      onDrop(page.pageId);
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
  onSelectAll,
  onDeselectAll,
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
  const [activeScrollEdges, setActiveScrollEdges] = useState<{
    vertical: VerticalScrollEdge;
    horizontal: HorizontalScrollEdge;
  }>({ vertical: null, horizontal: null });
  const dragPageIdRef = useRef<string | null>(null);
  const dropEdgeRef = useRef<DropEdge>(null);

  const autoScrollRafRef = useRef<number | null>(null);
  const autoScrollSpeedRef = useRef({ x: 0, y: 0 });
  const lastAutoScrollFrameRef = useRef<number | null>(null);
  const restoreScrollPositionRef = useRef<{ top: number; left: number } | null>(null);

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

  // Remount only when pages are added or removed. Keeping this key independent
  // of page order prevents react-window from resetting scroll position after a
  // reorder while still refreshing stale cells after multi-page uploads.
  const gridContentKey = useMemo(
    () => visiblePages.map((page) => page.pageId).sort().join(','),
    [visiblePages],
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

  useLayoutEffect(() => {
    const position = restoreScrollPositionRef.current;
    const scrollEl = gridRef.current?.element;
    if (!position || !scrollEl) return;

    scrollEl.scrollTop = position.top;
    scrollEl.scrollLeft = position.left;
    restoreScrollPositionRef.current = null;
  }, [visiblePages]);

  const stopAutoScroll = useCallback(() => {
    autoScrollSpeedRef.current = { x: 0, y: 0 };
    lastAutoScrollFrameRef.current = null;
    if (autoScrollRafRef.current !== null) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
  }, []);

  const runAutoScroll = useCallback((timestamp: number) => {
    const scrollEl = gridRef.current?.element;
    const { x, y } = autoScrollSpeedRef.current;
    if (!scrollEl || (x === 0 && y === 0)) {
      autoScrollRafRef.current = null;
      lastAutoScrollFrameRef.current = null;
      return;
    }

    const previousTimestamp = lastAutoScrollFrameRef.current;
    const elapsedMs = previousTimestamp === null
      ? 16
      : Math.min(32, Math.max(0, timestamp - previousTimestamp));
    lastAutoScrollFrameRef.current = timestamp;

    scrollEl.scrollTop += y * (elapsedMs / 1000);
    scrollEl.scrollLeft += x * (elapsedMs / 1000);
    autoScrollRafRef.current = requestAnimationFrame(runAutoScroll);
  }, []);

  const handleContainerDragOver = useCallback(
    (e: React.DragEvent) => {
      const isExternal = e.dataTransfer.types.includes(SOURCE_PAGE_DRAG_TYPE);
      const isInternal =
        e.dataTransfer.types.includes(ASSEMBLY_PAGE_DRAG_TYPE) ||
        dragPageIdRef.current !== null;
      if (isExternal) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      } else if (isInternal) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }

      const el = gridRef.current?.element ?? containerRef.current;
      if (!el || (!isInternal && !isExternal)) return;

      const rect = el.getBoundingClientRect();
      const speedY = getAutoScrollSpeed(e.clientY, rect.top, rect.bottom);
      const speedX = getAutoScrollSpeed(e.clientX, rect.left, rect.right);
      setActiveScrollEdges({
        vertical: speedY < 0 ? 'up' : speedY > 0 ? 'down' : null,
        horizontal: speedX < 0 ? 'left' : speedX > 0 ? 'right' : null,
      });

      autoScrollSpeedRef.current = { x: speedX, y: speedY };
      if ((speedX !== 0 || speedY !== 0) && autoScrollRafRef.current === null) {
        lastAutoScrollFrameRef.current = null;
        autoScrollRafRef.current = requestAnimationFrame(runAutoScroll);
      } else if (speedX === 0 && speedY === 0) {
        stopAutoScroll();
      }
    },
    [runAutoScroll, stopAutoScroll],
  );

  const handleContainerDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes('application/x-pdf-page')) {
        setIsExternalDragOver(true);
      }
    },
    [],
  );

  const handleContainerDragLeave = useCallback(
    (e: React.DragEvent) => {
      const nextTarget = e.relatedTarget as Node | null;
      if (nextTarget && e.currentTarget.contains(nextTarget)) return;

      if (e.dataTransfer.types.includes('application/x-pdf-page')) {
        setIsExternalDragOver(false);
      }
      setActiveScrollEdges({ vertical: null, horizontal: null });
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
      stopAutoScroll();
    },
    [visiblePages, dropEdge, onAddFromSource, stopAutoScroll],
  );

  const handleDragStart = useCallback((pageId: string) => {
    dragPageIdRef.current = pageId;
    setDragPageId(pageId);
  }, []);

  const handleDragOver = useCallback((pageId: string, edge: DropEdge) => {
    dropEdgeRef.current = edge;
    setDropTargetId(pageId);
    setDropEdge(edge);
  }, []);

  const handleDragEnd = useCallback(() => {
    dragPageIdRef.current = null;
    dropEdgeRef.current = null;
    setActiveScrollEdges({ vertical: null, horizontal: null });
    setDragPageId(null);
    setDropTargetId(null);
    setDropEdge(null);
    stopAutoScroll();
  }, [stopAutoScroll]);

  const handleDrop = useCallback(
    (targetPageId: string) => {
      const currentDragPageId = dragPageIdRef.current;
      const currentDropEdge = dropEdgeRef.current;
      if (!currentDragPageId || currentDragPageId === targetPageId) {
        dragPageIdRef.current = null;
        dropEdgeRef.current = null;
        setActiveScrollEdges({ vertical: null, horizontal: null });
        setDragPageId(null);
        setDropTargetId(null);
        setDropEdge(null);
        stopAutoScroll();
        return;
      }
      const fromIndex = visiblePages.findIndex((p) => p.pageId === currentDragPageId);
      const targetIndex = visiblePages.findIndex((p) => p.pageId === targetPageId);
      if (fromIndex >= 0 && targetIndex >= 0) {
        let toIndex = targetIndex + (currentDropEdge === 'after' ? 1 : 0);
        if (fromIndex < toIndex) toIndex -= 1;
        toIndex = Math.max(0, Math.min(toIndex, visiblePages.length - 1));
        if (fromIndex !== toIndex) {
          const scrollEl = gridRef.current?.element;
          if (scrollEl) {
            restoreScrollPositionRef.current = {
              top: scrollEl.scrollTop,
              left: scrollEl.scrollLeft,
            };
          }
          onReorder(fromIndex, toIndex);
        }
      }
      dragPageIdRef.current = null;
      dropEdgeRef.current = null;
      setActiveScrollEdges({ vertical: null, horizontal: null });
      setDragPageId(null);
      setDropTargetId(null);
      setDropEdge(null);
      stopAutoScroll();
    },
    [visiblePages, onReorder, stopAutoScroll],
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
      onDragOver={visiblePages.length > 0 ? handleContainerDragOver : undefined}
      onDragEnter={visiblePages.length > 0 ? handleContainerDragEnter : undefined}
      onDragLeave={visiblePages.length > 0 ? handleContainerDragLeave : undefined}
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
        onSelectAll={onSelectAll}
        onDeselectAll={onDeselectAll}
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
              overscanCount={dragPageId ? rowCount : 3}
              defaultHeight={containerHeight}
              defaultWidth={containerWidth}
              role="grid"
              aria-rowcount={rowCount}
              aria-colcount={columnCount}
            />
          </div>
          {dragPageId && (
            <div
              className={styles.autoScrollOverlay}
              data-testid="assembly-auto-scroll-overlay"
              aria-hidden="true"
            >
              <div
                className={`${styles.autoScrollZone} ${styles.autoScrollZoneTop}${
                  activeScrollEdges.vertical === 'up' ? ` ${styles.autoScrollZoneActive}` : ''
                }`}
                data-testid="assembly-auto-scroll-up"
              >
                <span>↑</span>
                <small>Hold here to scroll up</small>
              </div>
              <div
                className={`${styles.autoScrollZone} ${styles.autoScrollZoneBottom}${
                  activeScrollEdges.vertical === 'down' ? ` ${styles.autoScrollZoneActive}` : ''
                }`}
                data-testid="assembly-auto-scroll-down"
              >
                <small>Hold here to scroll down</small>
                <span>↓</span>
              </div>
              <div
                className={`${styles.autoScrollZone} ${styles.autoScrollZoneLeft}${
                  activeScrollEdges.horizontal === 'left' ? ` ${styles.autoScrollZoneActive}` : ''
                }`}
              >
                <span>←</span>
              </div>
              <div
                className={`${styles.autoScrollZone} ${styles.autoScrollZoneRight}${
                  activeScrollEdges.horizontal === 'right' ? ` ${styles.autoScrollZoneActive}` : ''
                }`}
              >
                <span>→</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const AssemblyLane: React.FC<AssemblyLaneProps> = (props) => {
  return <AssemblyLaneInner {...props} />;
};
