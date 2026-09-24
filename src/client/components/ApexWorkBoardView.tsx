import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useDrop } from 'react-dnd';
import { useLocation, useNavigate } from 'react-router-dom';
import type {
  ApexBoardLens,
  ApexWorkItem,
  ApexWorkItemFilters,
  ApexWorkItemStatus,
  ApexWorkItemType,
  ApexWorkItemSourceType,
} from '../../shared/types/apexWorkItem';
import {
  APEX_BOARD_CARD_TYPES,
  APEX_WORK_ITEM_STATUSES,
  APEX_WORK_ITEM_TYPES,
  STATUS_META,
} from '../../shared/types/apexWorkItem';
import { anchorTestIdProps } from '../../shared/walkthroughAnchors';
import {
  useApexWorkItems,
  useApexWorkItemOwners,
  useApexWorkItemFacets,
  useMoveApexWorkItem,
  useCreateApexRelease,
  useBulkUpdateApexWorkItems,
  useRankApexWorkItems,
  useUpdateApexWorkItem,
  useApexWorkBoardStream,
  useImportApexWorkItemsFromAdo,
  type AdoImportResult,
} from '../hooks/useApexWorkItems';
import { useAppShell } from '../hooks/useAppShell';
import { ApexWorkItemCard } from './ApexWorkItemCard';
import { ApexWorkItemDetailPanel } from './ApexWorkItemDetailPanel';
import { WorkBoardHelpCallout } from './WorkBoardHelpCallout';
import { DataGridFilterSelect, DataGridToolbar } from './DataGridToolbar';
import gridStyles from './DataGrid.module.css';
import styles from './ApexWorkBoardView.module.css';

const DND_TYPE = 'APEX_CARD';

interface SavedBoardFilters {
  ownerFilter?: string;
  typeFilter?: ApexWorkItemType[];
  releaseFilter?: string;
  search?: string;
  lens?: ApexBoardLens;
  viewMode?: 'board' | 'backlog';
}

function filtersStorageKey(project: string): string {
  return `apex-work-board-filters:${project}`;
}

function loadSavedFilters(project: string): SavedBoardFilters | null {
  try {
    const raw = localStorage.getItem(filtersStorageKey(project));
    if (!raw) return null;
    return JSON.parse(raw) as SavedBoardFilters;
  } catch {
    return null;
  }
}

const STATUS_ICON: Record<ApexWorkItemStatus, React.ReactNode> = {
  idea: (
    <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18h6" /><path d="M10 22h4" /><path d="M12 2a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2z" />
    </svg>
  ),
  ready: (
    <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </svg>
  ),
  'in-progress': (
    <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
    </svg>
  ),
  review: (
    <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
    </svg>
  ),
  done: (
    <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
};

function statusCssVars(status: ApexWorkItemStatus): React.CSSProperties {
  const accent = STATUS_META[status].tokenVar;
  return {
    ['--status-color' as string]: `var(${accent})`,
    ['--status-bg' as string]: `var(${accent}-bg)`,
    ['--status-border' as string]: `var(${accent}-border)`,
    ['--status-glow' as string]: `var(${accent}-glow)`,
  };
}

interface ColumnProps {
  status: ApexWorkItemStatus;
  items: ApexWorkItem[];
  onCardOpen: (id: string) => void;
  onCardMove: (id: string, s: ApexWorkItemStatus) => void;
  onDrop: (cardId: string, targetStatus: ApexWorkItemStatus) => void;
  selectMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
}

const Column: React.FC<ColumnProps> = ({
  status,
  items,
  onCardOpen,
  onCardMove,
  onDrop,
  selectMode,
  selectedIds,
  onToggleSelect,
}) => {
  const [{ isOver }, dropRef] = useDrop({
    accept: DND_TYPE,
    drop: (item: { id: string }) => onDrop(item.id, status),
    collect: (monitor) => ({ isOver: monitor.isOver() }),
  });

  const meta = STATUS_META[status];
  const cssVars = statusCssVars(status);

  return (
    <div
      ref={(el) => { dropRef(el); }}
      className={`${styles.column} ${isOver ? styles.columnDragOver : ''}`}
      style={cssVars}
    >
      <div className={styles.columnHeader}>
        <span className={styles.columnIcon}>{STATUS_ICON[status]}</span>
        <span className={styles.columnLabel}>{meta.label}</span>
        <span className={styles.columnCount}>{items.length}</span>
      </div>
      <div className={styles.columnCards}>
        {items.length === 0 ? (
          <div className={styles.columnEmpty}>
            <span className={styles.columnEmptyText}>No items yet</span>
          </div>
        ) : (
          items.map((item) => (
            <ApexWorkItemCard
              key={item.id}
              item={item}
              onOpen={onCardOpen}
              onMove={onCardMove}
              selectMode={selectMode}
              selected={selectedIds.has(item.id)}
              onToggleSelect={onToggleSelect}
             {...{ 'data-testid': `work-board-apex-work-item-card-${item.id}` }} />
          ))
        )}
      </div>
    </div>
  );
};

const SkeletonColumn: React.FC = () => (
  <div className={styles.column}>
    <div className={styles.columnHeader}>
      <span className={styles.columnLabel} style={{ width: 80, background: 'var(--border-color)', borderRadius: 4, height: 10 }} />
    </div>
    <div className={styles.columnCards}>
      {[1, 2, 3].map((n) => (
        <div key={n} className={styles.skeletonCard}>
          <div className={styles.skeletonLine} style={{ width: '45%' }} />
          <div className={styles.skeletonLine} style={{ width: '90%' }} />
          <div className={styles.skeletonLine} style={{ width: '75%' }} />
        </div>
      ))}
    </div>
  </div>
);

interface ApexWorkBoardViewProps {
  currentUserId: string;
  project: string;
}

export const ApexWorkBoardView: React.FC<ApexWorkBoardViewProps> = ({ currentUserId, project }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { can } = useAppShell();

  const deepLinkItemId = useMemo(() => {
    const p = new URLSearchParams(location.search);
    return p.get('item');
  }, [location.search]);

  const saved = useMemo(() => loadSavedFilters(project), [project]);

  const [openItemId, setOpenItemId] = useState<string | null>(deepLinkItemId);
  const [ownerFilter, setOwnerFilter] = useState<string>(saved?.ownerFilter ?? currentUserId);
  const [typeFilter, setTypeFilter] = useState<ApexWorkItemType[]>(
    saved?.typeFilter?.length ? saved.typeFilter : [...APEX_BOARD_CARD_TYPES],
  );
  const [epicFilter, setEpicFilter] = useState<string>('');
  const [featureFilter, setFeatureFilter] = useState<string>('');
  const [sourceFilter, setSourceFilter] = useState<string>('');
  const [releaseFilter, setReleaseFilter] = useState<string>(saved?.releaseFilter ?? '');
  const [search, setSearch] = useState(saved?.search ?? '');
  const [lens, setLens] = useState<ApexBoardLens>(saved?.lens ?? 'status');
  const [viewMode, setViewMode] = useState<'board' | 'backlog'>(saved?.viewMode ?? 'board');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [newReleaseName, setNewReleaseName] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importDryRun, setImportDryRun] = useState(true);
  const [importResult, setImportResult] = useState<AdoImportResult | null>(null);
  const [backlogPage, setBacklogPage] = useState(1);
  const [backlogPageSize, setBacklogPageSize] = useState(25);

  useEffect(() => {
    const next = loadSavedFilters(project);
    setOwnerFilter(next?.ownerFilter ?? currentUserId);
    setTypeFilter(next?.typeFilter?.length ? next.typeFilter : [...APEX_BOARD_CARD_TYPES]);
    setReleaseFilter(next?.releaseFilter ?? '');
    setSearch(next?.search ?? '');
    setLens(next?.lens ?? 'status');
    setViewMode(next?.viewMode ?? 'board');
    setSelectedIds(new Set());
    setSelectMode(false);
  }, [project, currentUserId]);

  useEffect(() => {
    const payload: SavedBoardFilters = {
      ownerFilter,
      typeFilter,
      releaseFilter,
      search,
      lens,
      viewMode,
    };
    try {
      localStorage.setItem(filtersStorageKey(project), JSON.stringify(payload));
    } catch {
      // ignore quota / private mode
    }
  }, [project, ownerFilter, typeFilter, releaseFilter, search, lens, viewMode]);

  const filters: ApexWorkItemFilters = useMemo(() => ({
    project,
    ownerId: ownerFilter || undefined,
    // Delivery-first default: empty selection falls back to PBI/TBI/Bug (not Epics/Features).
    types: typeFilter.length > 0 ? typeFilter : [...APEX_BOARD_CARD_TYPES],
    epicTitle: epicFilter || undefined,
    featureTitle: featureFilter || undefined,
    sourceType: (sourceFilter as ApexWorkItemSourceType | 'all') || undefined,
    releaseId: releaseFilter || undefined,
    search: search || undefined,
  }), [project, ownerFilter, typeFilter, epicFilter, featureFilter, sourceFilter, releaseFilter, search]);

  const { data: items = [], isLoading, isError } = useApexWorkItems(filters);
  const { data: owners = [] } = useApexWorkItemOwners(project);
  const { data: facets } = useApexWorkItemFacets(project);
  const moveMutation = useMoveApexWorkItem(filters);
  const createRelease = useCreateApexRelease(project);
  const bulkUpdate = useBulkUpdateApexWorkItems(project);
  const rankItems = useRankApexWorkItems(project);
  const updateItem = useUpdateApexWorkItem(project);
  const adoImport = useImportApexWorkItemsFromAdo(project);
  useApexWorkBoardStream(project);

  const handleDrop = useCallback(
    (cardId: string, targetStatus: ApexWorkItemStatus) => {
      const card = items.find((i) => i.id === cardId);
      if (!card || card.status === targetStatus) return;
      moveMutation.mutate({ id: cardId, targetStatus });
    },
    [items, moveMutation],
  );

  const handleCardMove = useCallback(
    (id: string, targetStatus: ApexWorkItemStatus) => {
      moveMutation.mutate({ id, targetStatus });
    },
    [moveMutation],
  );

  const handleCardOpen = useCallback(
    (id: string) => {
      setOpenItemId(id);
      navigate(`/work-board?item=${id}`, { replace: true });
    },
    [navigate],
  );

  const handleDrawerClose = useCallback(() => {
    setOpenItemId(null);
    navigate('/work-board', { replace: true });
  }, [navigate]);

  const groupedByStatus = useMemo(
    () =>
      APEX_WORK_ITEM_STATUSES.reduce<Record<ApexWorkItemStatus, ApexWorkItem[]>>(
        (acc, s) => ({ ...acc, [s]: items.filter((i) => i.status === s) }),
        {} as Record<ApexWorkItemStatus, ApexWorkItem[]>,
      ),
    [items],
  );

  const releaseLanes = useMemo(() => {
    const releases = facets?.releases ?? [];
    const lanes: { key: string; label: string; items: ApexWorkItem[] }[] = [
      ...releases.map((r) => ({
        key: r.id,
        label: r.name + (r.targetDate ? ` · ${r.targetDate}` : ''),
        items: items.filter((i) => i.releaseId === r.id),
      })),
      {
        key: 'none',
        label: 'No target release',
        items: items.filter((i) => !i.releaseId),
      },
    ];
    return lanes.filter((l) => l.items.length > 0 || l.key === 'none');
  }, [facets?.releases, items]);

  const backlogItems = useMemo(
    () => [...items].sort(
      (a, b) => (a.priorityRank ?? Number.MAX_SAFE_INTEGER) - (b.priorityRank ?? Number.MAX_SAFE_INTEGER)
        || a.position - b.position
        || a.itemNumber - b.itemNumber,
    ),
    [items],
  );
  const backlogPageCount = Math.max(1, Math.ceil(backlogItems.length / backlogPageSize));
  const visibleBacklogItems = useMemo(
    () => backlogItems.slice((backlogPage - 1) * backlogPageSize, backlogPage * backlogPageSize),
    [backlogItems, backlogPage, backlogPageSize],
  );
  const canManage = can('work-board:manage');

  useEffect(() => {
    setBacklogPage(1);
  }, [
    project,
    ownerFilter,
    typeFilter,
    epicFilter,
    featureFilter,
    sourceFilter,
    releaseFilter,
    search,
    backlogPageSize,
  ]);

  useEffect(() => {
    setBacklogPage((page) => Math.min(page, backlogPageCount));
  }, [backlogPageCount]);

  const deliveryTypesSelected =
    typeFilter.length === APEX_BOARD_CARD_TYPES.length
    && APEX_BOARD_CARD_TYPES.every((t) => typeFilter.includes(t));
  const allTypesSelected =
    typeFilter.length === APEX_WORK_ITEM_TYPES.length
    && APEX_WORK_ITEM_TYPES.every((t) => typeFilter.includes(t));
  const backlogTypeValue = deliveryTypesSelected ? 'delivery' : allTypesSelected ? 'all' : 'custom';

  const hasActiveFilters =
    (ownerFilter && ownerFilter !== currentUserId) ||
    !deliveryTypesSelected ||
    epicFilter ||
    featureFilter ||
    sourceFilter ||
    releaseFilter ||
    search;

  const clearFilters = () => {
    setOwnerFilter(currentUserId);
    setTypeFilter([...APEX_BOARD_CARD_TYPES]);
    setEpicFilter('');
    setFeatureFilter('');
    setSourceFilter('');
    setReleaseFilter('');
    setSearch('');
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkRelease = (releaseId: string) => {
    if (!selectedIds.size) return;
    bulkUpdate.mutate({
      ids: [...selectedIds],
      releaseId: releaseId === 'none' ? null : releaseId,
    });
    setSelectedIds(new Set());
  };

  const handleBulkMove = (targetStatus: ApexWorkItemStatus) => {
    if (!selectedIds.size) return;
    bulkUpdate.mutate({
      ids: [...selectedIds],
      targetStatus,
    });
    setSelectedIds(new Set());
  };

  const handleBulkAssign = (ownerId: string) => {
    if (!selectedIds.size || !ownerId) return;
    bulkUpdate.mutate({
      ids: [...selectedIds],
      ownerId,
    });
    setSelectedIds(new Set());
  };

  const handleCreateRelease = () => {
    if (!newReleaseName.trim()) return;
    createRelease.mutate({ name: newReleaseName.trim(), status: 'planned' });
    setNewReleaseName('');
  };

  const handleAdoImport = () => {
    setImportResult(null);
    adoImport.mutate(
      { dryRun: importDryRun },
      {
        onSuccess: (data) => setImportResult(data),
      },
    );
  };

  const boardEmpty = !isLoading && !isError && items.length === 0;

  return (
    <div className={styles.board} {...anchorTestIdProps('work-board-view')}>
      <div className={styles.header}>
        <WorkBoardHelpCallout />
        <div className={styles.headerTop}>
          <div className={styles.titleBlock}>
            <h1 className={styles.title}>Work Board</h1>
            <p className={styles.subtitle}>
              Continuous delivery board for {project} — organize by status or target release
            </p>
          </div>
          <div className={styles.headerActions}>
            <div style={{ display: 'inline-flex', gap: 6 }} {...anchorTestIdProps('work-board-backlog-toggle')}>
              <button
                type="button"
                className={`${styles.filterChip} ${viewMode === 'board' ? styles.filterChipActive : ''}`}
                onClick={() => setViewMode('board')}
                {...{ 'data-testid': 'work-board-view-board' }}
              >
                Board
              </button>
              <button
                type="button"
                className={`${styles.filterChip} ${viewMode === 'backlog' ? styles.filterChipActive : ''}`}
                onClick={() => setViewMode('backlog')}
                {...{ 'data-testid': 'work-board-view-backlog' }}
              >
                Backlog
              </button>
            </div>
            {viewMode === 'board' && (
              <div style={{ display: 'inline-flex', gap: 6 }} {...anchorTestIdProps('work-board-lens-toggle')}>
                <button
                  type="button"
                  className={`${styles.filterChip} ${lens === 'status' ? styles.filterChipActive : ''}`}
                  onClick={() => setLens('status')}
                  {...{ 'data-testid': 'work-board-lens-status' }}
                >
                  Status lens
                </button>
                <button
                  type="button"
                  className={`${styles.filterChip} ${lens === 'release' ? styles.filterChipActive : ''}`}
                  onClick={() => setLens('release')}
                  {...{ 'data-testid': 'work-board-lens-release' }}
                >
                  Release lens
                </button>
              </div>
            )}
            {can('work-board:manage') && <button
              type="button"
              className={`${styles.filterChip} ${selectMode ? styles.filterChipActive : ''}`}
              onClick={() => {
                setSelectMode((prev) => {
                  if (prev) setSelectedIds(new Set());
                  return !prev;
                });
              }}
              {...{ 'data-testid': 'work-board-select-mode' }}
            >
              {selectMode ? 'Done selecting' : 'Select'}
            </button>}
            {can('work-board:admin') && (
              <button
                type="button"
                className={styles.filterChip}
                onClick={() => {
                  setImportOpen(true);
                  setImportResult(null);
                  setImportDryRun(true);
                }}
                {...{ 'data-testid': 'work-board-ado-import' }}
              >
                Import from Azure DevOps
              </button>
            )}
            <button
              className={styles.btnPrimary}
              onClick={() => navigate('/feature-requests')}
              title="Go to Feature Requests to generate work items"
              {...{ 'data-testid': 'work-board-new-from-fr' }}
            >
              New from Feature Request
            </button>
          </div>
        </div>

        {viewMode === 'board' && (
        <div className={styles.filterBar}>
          <select
            className={styles.filterSelect}
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
            aria-label="Filter by owner"
           {...{ 'data-testid': 'work-board-filter-by-owner-select' }}>
            <option value={currentUserId}>My board</option>
            <option value="all">All owners</option>
            {owners
              .filter((o) => o.oid !== currentUserId)
              .map((o) => (
                <option key={o.oid} value={o.oid}>{o.displayName}</option>
              ))}
          </select>

          <button
            type="button"
            className={`${styles.filterChip} ${deliveryTypesSelected ? styles.filterChipActive : ''}`}
            onClick={() => setTypeFilter([...APEX_BOARD_CARD_TYPES])}
            title="Show delivery work only (PBI, TBI, Bug)"
            {...{ 'data-testid': 'work-board-type-delivery' }}
          >
            Delivery
          </button>
          <button
            type="button"
            className={`${styles.filterChip} ${typeFilter.length === APEX_WORK_ITEM_TYPES.length ? styles.filterChipActive : ''}`}
            onClick={() => setTypeFilter([...APEX_WORK_ITEM_TYPES])}
            title="Show all types including Epic and Feature"
            {...{ 'data-testid': 'work-board-type-all' }}
          >
            All types
          </button>
          {APEX_WORK_ITEM_TYPES.map((t) => {
            const typeClass =
              t === 'PBI' ? styles.filterChipPBI
                : t === 'TBI' ? styles.filterChipTBI
                  : t === 'Bug' ? styles.filterChipBug
                    : '';
            return (
              <button
                key={t}
                type="button"
                className={`${styles.filterChip} ${typeClass} ${typeFilter.includes(t) ? styles.filterChipActive : ''}`}
                onClick={() =>
                  setTypeFilter((prev) =>
                    prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
                  )
                }
               {...{ 'data-testid': `work-board-filter-chip-${t}` }}>
                {t}
              </button>
            );
          })}

          {facets && facets.epicTitles.length > 0 && (
            <select
              className={styles.filterSelect}
              value={epicFilter}
              onChange={(e) => { setEpicFilter(e.target.value); setFeatureFilter(''); }}
              aria-label="Filter by epic"
             {...{ 'data-testid': 'work-board-filter-by-epic-select' }}>
              <option value="">All epics</option>
              {facets.epicTitles.map((e) => (
                <option key={e} value={e}>{e}</option>
              ))}
            </select>
          )}

          {facets && facets.featureTitles.length > 0 && (
            <select
              className={styles.filterSelect}
              value={featureFilter}
              onChange={(e) => setFeatureFilter(e.target.value)}
              aria-label="Filter by feature"
             {...{ 'data-testid': 'work-board-filter-by-feature-select' }}>
              <option value="">All features</option>
              {facets.featureTitles.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          )}

          <select
            className={styles.filterSelect}
            value={releaseFilter}
            onChange={(e) => setReleaseFilter(e.target.value)}
            aria-label="Filter by release"
            {...{ 'data-testid': 'work-board-release-filter' }}
          >
            <option value="">All releases</option>
            <option value="none">No release</option>
            {(facets?.releases ?? []).map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>

          <select
            className={styles.filterSelect}
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            aria-label="Filter by source"
           {...{ 'data-testid': 'work-board-filter-by-source-select' }}>
            <option value="">All sources</option>
            <option value="prd">From PRD</option>
            <option value="feature_request">From FR</option>
            <option value="standalone">Standalone</option>
          </select>

          <div className={styles.filterSpacer} />

          <input
            type="search"
            className={styles.searchInput}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search APX-# or title…"
            aria-label="Search work items"
           {...{ 'data-testid': 'work-board-search-work-items-input' }} />

          {hasActiveFilters && (
            <button className={styles.clearFiltersBtn} onClick={clearFilters} {...{ 'data-testid': 'work-board-clear-filters-btn' }}>
              Clear filters
            </button>
          )}
        </div>
        )}

        {/* Quick create release */}
        <div className={styles.filterBar} style={{ paddingTop: 0 }}>
          <input
            className={styles.searchInput}
            value={newReleaseName}
            onChange={(e) => setNewReleaseName(e.target.value)}
            placeholder="New release name (e.g. R5)"
            aria-label="New release name"
            {...{ 'data-testid': 'work-board-new-release-name' }}
          />
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={handleCreateRelease}
            disabled={!newReleaseName.trim() || createRelease.isPending}
            {...{ 'data-testid': 'work-board-create-release' }}
          >
            Add release
          </button>
          {selectedIds.size > 0 && (
            <>
              <span className={styles.subtitle}>{selectedIds.size} selected</span>
              <select
                className={styles.filterSelect}
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) handleBulkRelease(e.target.value);
                  e.target.value = '';
                }}
                aria-label="Bulk set release"
                {...{ 'data-testid': 'work-board-bulk-release' }}
              >
                <option value="" disabled>Set release…</option>
                <option value="none">Clear release</option>
                {(facets?.releases ?? []).map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
              <select
                className={styles.filterSelect}
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) handleBulkMove(e.target.value as ApexWorkItemStatus);
                  e.target.value = '';
                }}
                aria-label="Bulk move status"
                {...{ 'data-testid': 'work-board-bulk-move' }}
              >
                <option value="" disabled>Move to…</option>
                {APEX_WORK_ITEM_STATUSES.map((s) => (
                  <option key={s} value={s}>{STATUS_META[s].label}</option>
                ))}
              </select>
              <select
                className={styles.filterSelect}
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) handleBulkAssign(e.target.value);
                  e.target.value = '';
                }}
                aria-label="Bulk assign owner"
                {...{ 'data-testid': 'work-board-bulk-assign' }}
              >
                <option value="" disabled>Assign to…</option>
                {owners.map((o) => (
                  <option key={o.oid} value={o.oid}>{o.displayName}</option>
                ))}
              </select>
            </>
          )}
        </div>
      </div>

      <div className={styles.divider} />

      {isError ? (
        <div className={styles.errorState} role="alert">Failed to load work items.</div>
      ) : isLoading ? (
        <div className={styles.canvas}>
          {APEX_WORK_ITEM_STATUSES.map((s) => <SkeletonColumn key={s} />)}
        </div>
      ) : boardEmpty ? (
        <div className={styles.emptyState} role="status" {...{ 'data-testid': 'work-board-empty' }}>
          <p className={styles.emptyStateText}>
            No work items yet. Materialize from a PRD, generate from a feature request, or import from Azure DevOps.
          </p>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={() => navigate('/feature-requests')}
            {...{ 'data-testid': 'work-board-empty-cta' }}
          >
            New from Feature Request
          </button>
        </div>
      ) : viewMode === 'backlog' ? (
        <section className={`${gridStyles.section} ${styles.backlogSection}`} {...{ 'data-testid': 'work-board-backlog' }}>
          <div className={gridStyles.header}>
            <div>
              <h2 className={gridStyles.title}>Backlog</h2>
              <p className={gridStyles.hint}>Ranked delivery work for the current project and filters.</p>
            </div>
            {canManage && (
              <div className={gridStyles.headerActions}>
                <button
                  type="button"
                  className={gridStyles.buttonPrimary}
                  disabled={rankItems.isPending || backlogItems.length === 0}
                  onClick={() => rankItems.mutate({ ids: backlogItems.map((item) => item.id) })}
                  data-testid="work-board-rank-filtered"
                >
                  {rankItems.isPending ? 'Ranking…' : `AI rank filtered backlog (${backlogItems.length})`}
                </button>
              </div>
            )}
          </div>
          <DataGridToolbar
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search APX-# or title…"
            searchTestId="work-board-search-work-items-input"
          >
            <DataGridFilterSelect
              label="Assignee"
              value={ownerFilter}
              onChange={setOwnerFilter}
              testId="work-board-filter-by-owner-select"
              options={[
                { label: 'All assignees', value: 'all' },
                ...owners.map((owner) => ({ label: owner.displayName, value: owner.oid })),
              ]}
              {...{ 'data-testid': 'work-board-filter-by-owner-select' }}
            />
            <DataGridFilterSelect
              label="Type"
              value={backlogTypeValue}
              onChange={(value) => {
                if (value === 'delivery') setTypeFilter([...APEX_BOARD_CARD_TYPES]);
                else if (value === 'all') setTypeFilter([...APEX_WORK_ITEM_TYPES]);
              }}
              testId="work-board-backlog-type-filter"
              options={[
                { label: 'Delivery', value: 'delivery' },
                { label: 'All types', value: 'all' },
                ...(backlogTypeValue === 'custom' ? [{ label: 'Custom types', value: 'custom' }] : []),
              ]}
              {...{ 'data-testid': 'work-board-backlog-type-filter' }}
            />
            {facets && facets.epicTitles.length > 0 && (
              <DataGridFilterSelect
                label="Epic"
                value={epicFilter}
                onChange={(value) => { setEpicFilter(value); setFeatureFilter(''); }}
                includeEmptyOption
                emptyOptionLabel="All epics"
                testId="work-board-filter-by-epic-select"
                options={facets.epicTitles.map((epic) => ({ label: epic, value: epic }))}
                {...{ 'data-testid': 'work-board-filter-by-epic-select' }}
              />
            )}
            {facets && facets.featureTitles.length > 0 && (
              <DataGridFilterSelect
                label="Feature"
                value={featureFilter}
                onChange={setFeatureFilter}
                includeEmptyOption
                emptyOptionLabel="All features"
                testId="work-board-filter-by-feature-select"
                options={facets.featureTitles.map((feature) => ({ label: feature, value: feature }))}
                {...{ 'data-testid': 'work-board-filter-by-feature-select' }}
              />
            )}
            <DataGridFilterSelect
              label="Release"
              value={releaseFilter}
              onChange={setReleaseFilter}
              includeEmptyOption
              emptyOptionLabel="All releases"
              testId="work-board-release-filter"
              options={[
                { label: 'No release', value: 'none' },
                ...(facets?.releases ?? []).map((release) => ({ label: release.name, value: release.id })),
              ]}
              {...{ 'data-testid': 'work-board-release-filter' }}
            />
            <DataGridFilterSelect
              label="Source"
              value={sourceFilter}
              onChange={setSourceFilter}
              includeEmptyOption
              emptyOptionLabel="All sources"
              testId="work-board-filter-by-source-select"
              options={[
                { label: 'From PRD', value: 'prd' },
                { label: 'From FR', value: 'feature_request' },
                { label: 'Standalone', value: 'standalone' },
              ]}
              {...{ 'data-testid': 'work-board-filter-by-source-select' }}
            />
          </DataGridToolbar>
          {rankItems.isError && <div className={gridStyles.error} role="alert">{rankItems.error.message}</div>}
          {backlogItems.length === 0 ? (
            <div className={gridStyles.empty} role="status">
              No work items match the current filters.
            </div>
          ) : (
            <div className={gridStyles.tableWrap}>
            <table className={gridStyles.table} data-testid="work-board-backlog-table">
              <thead>
                <tr>
                  <th aria-label="Select" />
                  <th>Rank</th>
                  <th>ID</th>
                  <th>Title</th>
                  <th>Type</th>
                  <th>Priority</th>
                  <th>Status</th>
                  <th>Release</th>
                  <th>Assignee</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleBacklogItems.map((item) => (
                  <tr key={item.id} data-testid={`work-board-tr-${item.id}`}>
                    <td>
                      {canManage && <input
                        type="checkbox"
                        checked={selectedIds.has(item.id)}
                        onChange={() => toggleSelected(item.id)}
                        aria-label={`Select APX-${item.itemNumber}`}
                        data-testid={`work-board-select-${item.id}`}
                      />}
                    </td>
                    <td>{item.priorityRank ?? '—'}</td>
                    <td>APX-{item.itemNumber}</td>
                    <td className={styles.backlogTitle}>{item.title}</td>
                    <td>{item.type}</td>
                    <td>
                      {item.priority ? (
                        <span
                          className={`${styles.priorityBadge} ${styles[`priority${item.priority[0].toUpperCase()}${item.priority.slice(1)}`]}`}
                          title={item.aiPriorityRationale ?? undefined}
                        >
                          {item.priority}
                        </span>
                      ) : '—'}
                    </td>
                    <td>{STATUS_META[item.status].label}</td>
                    <td>{item.release?.name ?? '—'}</td>
                    <td>
                      {canManage ? (
                        <select
                          className={styles.backlogAssignee}
                          value={item.owner.oid}
                          onChange={(event) => updateItem.mutate({ id: item.id, ownerId: event.target.value })}
                          aria-label={`Assign APX-${item.itemNumber}`}
                          data-testid={`work-board-assignee-${item.id}`}
                        >
                          {owners.map((owner) => (
                            <option key={owner.oid} value={owner.oid}>{owner.displayName}</option>
                          ))}
                        </select>
                      ) : item.owner.displayName}
                    </td>
                    <td>
                      <div className={gridStyles.rowActions}>
                        <button
                          type="button"
                          className={gridStyles.buttonGhost}
                          onClick={() => handleCardOpen(item.id)}
                          data-testid={`work-board-edit-${item.id}`}
                        >
                          Edit
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
          <div className={styles.pagination} data-testid="work-board-pagination">
            <span>
              {backlogItems.length === 0 ? '0' : (backlogPage - 1) * backlogPageSize + 1}
              –{Math.min(backlogPage * backlogPageSize, backlogItems.length)} of {backlogItems.length}
            </span>
            <label>
              Rows
              <select
                value={backlogPageSize}
                onChange={(event) => setBacklogPageSize(Number(event.target.value))}
                data-testid="work-board-page-size"
              >
                {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </label>
            <button
              type="button"
              className={gridStyles.buttonGhost}
              disabled={backlogPage === 1}
              onClick={() => setBacklogPage((page) => page - 1)}
              data-testid="work-board-page-previous"
            >
              Previous
            </button>
            <button
              type="button"
              className={gridStyles.buttonGhost}
              disabled={backlogPage >= backlogPageCount}
              onClick={() => setBacklogPage((page) => page + 1)}
              data-testid="work-board-page-next"
            >
              Next
            </button>
          </div>
        </section>
      ) : lens === 'release' ? (
        <div className={styles.canvas} {...{ 'data-testid': 'work-board-release-lanes' }}>
          {releaseLanes.map((lane) => (
            <div key={lane.key} className={styles.column}>
              <div className={styles.columnHeader}>
                <span className={styles.columnLabel}>{lane.label}</span>
                <span className={styles.columnCount}>{lane.items.length}</span>
              </div>
              <div className={styles.columnCards}>
                {lane.items.map((item) => (
                  <ApexWorkItemCard
                    key={item.id}
                    item={item}
                    onOpen={handleCardOpen}
                    onMove={handleCardMove}
                    selectMode={selectMode}
                    selected={selectedIds.has(item.id)}
                    onToggleSelect={toggleSelected}
                   {...{ 'data-testid': `work-board-apex-work-item-card-${item.id}` }} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.canvas} {...{ 'data-testid': 'work-board-status-columns' }}>
          {APEX_WORK_ITEM_STATUSES.map((s) => (
            <Column
              key={s}
              status={s}
              items={groupedByStatus[s]}
              onCardOpen={handleCardOpen}
              onCardMove={handleCardMove}
              onDrop={handleDrop}
              selectMode={selectMode}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelected}
            />
          ))}
        </div>
      )}

      {openItemId && (
        <ApexWorkItemDetailPanel
          itemId={openItemId}
          project={project}
          onClose={handleDrawerClose}
          onOpenItem={(id) => setOpenItemId(id)}
         {...{ 'data-testid': 'work-board-apex-work-item-detail-panel' }} />
      )}

      {importOpen && (
        <div
          className={styles.importOverlay}
          role="dialog"
          aria-modal="true"
          aria-labelledby="work-board-import-title"
          {...{ 'data-testid': 'work-board-ado-import-modal' }}
        >
          <div className={styles.importModal}>
            <h2 id="work-board-import-title" className={styles.importTitle}>Import from Azure DevOps</h2>
            <p className={styles.importHelp}>
              Imports Epics, Features, PBIs, TBIs, and Bugs for <strong>{project}</strong>. Matching
              rows (same ADO id) are updated; others are created. Releases are inferred from
              Release:* tags and epics titled with “Release”.
            </p>
            <label className={styles.importCheck}>
              <input
                type="checkbox"
                checked={importDryRun}
                onChange={(e) => setImportDryRun(e.target.checked)}
               {...{ 'data-testid': 'work-board-checkbox-input-2' }} />
              Dry run (preview only — no writes)
            </label>
            {importResult && (
              <div className={styles.importResult} role="status">
                <p>
                  Created {importResult.created}, updated {importResult.updated}, skipped{' '}
                  {importResult.skipped}, releases {importResult.releasesCreated}
                </p>
                {importResult.errors.length > 0 && (
                  <ul>
                    {importResult.errors.slice(0, 5).map((err) => (
                      <li key={err}>{err}</li>
                    ))}
                  </ul>
                )}
                {importResult.preview && importResult.preview.length > 0 && (
                  <ul className={styles.importPreview}>
                    {importResult.preview.slice(0, 8).map((row) => (
                      <li key={row.adoId}>
                        [{row.action}] #{row.adoId} {row.title}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className={styles.importActions}>
              <button
                type="button"
                className={styles.filterChip}
                onClick={() => setImportOpen(false)}
                disabled={adoImport.isPending}
               {...{ 'data-testid': 'work-board-filter-chip-btn' }}>
                Close
              </button>
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={handleAdoImport}
                disabled={adoImport.isPending}
               {...{ 'data-testid': 'work-board-btn-primary-2' }}>
                {adoImport.isPending ? 'Working…' : importDryRun ? 'Preview import' : 'Run import'}
              </button>
            </div>
            {adoImport.isError && (
              <p className={styles.importError} role="alert">
                {adoImport.error.message}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
