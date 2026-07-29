import React, { useCallback, useMemo, useState } from 'react';
import { useDrop } from 'react-dnd';
import { useLocation, useNavigate } from 'react-router-dom';
import type {
  ApexWorkItem,
  ApexWorkItemFilters,
  ApexWorkItemStatus,
  ApexWorkItemType,
  ApexWorkItemSourceType,
} from '../../shared/types/apexWorkItem';
import { APEX_WORK_ITEM_STATUSES, STATUS_META } from '../../shared/types/apexWorkItem';
import { useApexWorkItems, useApexWorkItemOwners, useApexWorkItemFacets, useMoveApexWorkItem } from '../hooks/useApexWorkItems';
import { ApexWorkItemCard } from './ApexWorkItemCard';
import { ApexWorkItemDetailPanel } from './ApexWorkItemDetailPanel';
import styles from './ApexWorkBoardView.module.css';

const DND_TYPE = 'APEX_CARD';

const STATUS_ICON: Record<ApexWorkItemStatus, React.ReactNode> = {
  idea: (
    /* lightbulb */
    <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M12 2a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2z" />
    </svg>
  ),
  ready: (
    /* circle check */
    <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </svg>
  ),
  'in-progress': (
    /* clock */
    <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
  review: (
    /* eye */
    <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  done: (
    /* check */
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

// ── Column ────────────────────────────────────────────────────────────────────

interface ColumnProps {
  status: ApexWorkItemStatus;
  items: ApexWorkItem[];
  onCardOpen: (id: string) => void;
  onCardMove: (id: string, s: ApexWorkItemStatus) => void;
  onDrop: (cardId: string, targetStatus: ApexWorkItemStatus) => void;
}

const Column: React.FC<ColumnProps> = ({ status, items, onCardOpen, onCardMove, onDrop }) => {
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
            />
          ))
        )}
      </div>
    </div>
  );
};

// ── Skeleton ──────────────────────────────────────────────────────────────────

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
          <div className={styles.skeletonLine} style={{ width: '55%' }} />
        </div>
      ))}
    </div>
  </div>
);

// ── Main view ─────────────────────────────────────────────────────────────────

interface ApexWorkBoardViewProps {
  currentUserId: string;
}

export const ApexWorkBoardView: React.FC<ApexWorkBoardViewProps> = ({ currentUserId }) => {
  const navigate = useNavigate();
  const location = useLocation();

  // Deep-link: ?item=<uuid>
  const deepLinkItemId = useMemo(() => {
    const p = new URLSearchParams(location.search);
    return p.get('item');
  }, [location.search]);

  const [openItemId, setOpenItemId] = useState<string | null>(deepLinkItemId);
  const [ownerFilter, setOwnerFilter] = useState<string>(currentUserId);
  const [typeFilter, setTypeFilter] = useState<ApexWorkItemType[]>([]);
  const [epicFilter, setEpicFilter] = useState<string>('');
  const [featureFilter, setFeatureFilter] = useState<string>('');
  const [sourceFilter, setSourceFilter] = useState<string>('');
  const [search, setSearch] = useState('');

  const filters: ApexWorkItemFilters = useMemo(() => ({
    ownerId: ownerFilter || undefined,
    types: typeFilter.length > 0 ? typeFilter : undefined,
    epicTitle: epicFilter || undefined,
    featureTitle: featureFilter || undefined,
    sourceType: (sourceFilter as ApexWorkItemSourceType | 'all') || undefined,
    search: search || undefined,
  }), [ownerFilter, typeFilter, epicFilter, featureFilter, sourceFilter, search]);

  const { data: items = [], isLoading, isError } = useApexWorkItems(filters);
  const { data: owners = [] } = useApexWorkItemOwners();
  const { data: facets } = useApexWorkItemFacets();
  const moveMutation = useMoveApexWorkItem(filters);

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

  const grouped = useMemo(
    () =>
      APEX_WORK_ITEM_STATUSES.reduce<Record<ApexWorkItemStatus, ApexWorkItem[]>>(
        (acc, s) => ({ ...acc, [s]: items.filter((i) => i.status === s) }),
        {} as Record<ApexWorkItemStatus, ApexWorkItem[]>,
      ),
    [items],
  );

  const hasActiveFilters =
    (ownerFilter && ownerFilter !== currentUserId) ||
    typeFilter.length > 0 ||
    epicFilter ||
    featureFilter ||
    sourceFilter ||
    search;

  const clearFilters = () => {
    setOwnerFilter(currentUserId);
    setTypeFilter([]);
    setEpicFilter('');
    setFeatureFilter('');
    setSourceFilter('');
    setSearch('');
  };

  return (
    <div className={styles.board}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerTop}>
          <div className={styles.titleBlock}>
            <h1 className={styles.title}>Work Board</h1>
            <p className={styles.subtitle}>
              Execution board for Apex — created from approved PRDs or generated from feature requests
            </p>
          </div>
          <div className={styles.headerActions}>
            <button
              className={styles.btnPrimary}
              onClick={() => navigate('/feature-requests')}
              title="Go to Feature Requests to generate work items"
            >
              <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 14 14">
                <path d="M7 2v10M2 7h10" />
              </svg>
              New from Feature Request
            </button>
          </div>
        </div>

        {/* Filter bar */}
        <div className={styles.filterBar}>
          {/* Owner filter */}
          <select
            className={styles.filterSelect}
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
            aria-label="Filter by owner"
          >
            <option value={currentUserId}>My board</option>
            <option value="all">All owners</option>
            {owners
              .filter((o) => o.oid !== currentUserId)
              .map((o) => (
                <option key={o.oid} value={o.oid}>{o.displayName}</option>
              ))}
          </select>

          {/* Type filter */}
          {(['PBI', 'TBI', 'Bug'] as ApexWorkItemType[]).map((t) => {
            const typeClass =
              t === 'PBI' ? styles.filterChipPBI
                : t === 'TBI' ? styles.filterChipTBI
                : styles.filterChipBug;
            return (
              <button
                key={t}
                className={`${styles.filterChip} ${typeClass} ${typeFilter.includes(t) ? styles.filterChipActive : ''}`}
                onClick={() =>
                  setTypeFilter((prev) =>
                    prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
                  )
                }
              >
                {t}
              </button>
            );
          })}

          {/* Epic filter */}
          {facets && facets.epicTitles.length > 0 && (
            <select
              className={styles.filterSelect}
              value={epicFilter}
              onChange={(e) => { setEpicFilter(e.target.value); setFeatureFilter(''); }}
              aria-label="Filter by epic"
            >
              <option value="">All epics</option>
              {facets.epicTitles.map((e) => (
                <option key={e} value={e}>{e}</option>
              ))}
            </select>
          )}

          {/* Feature filter */}
          {facets && facets.featureTitles.length > 0 && (
            <select
              className={styles.filterSelect}
              value={featureFilter}
              onChange={(e) => setFeatureFilter(e.target.value)}
              aria-label="Filter by feature"
            >
              <option value="">All features</option>
              {facets.featureTitles.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          )}

          {/* Source filter */}
          <select
            className={styles.filterSelect}
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            aria-label="Filter by source"
          >
            <option value="">All sources</option>
            <option value="prd">From PRD</option>
            <option value="feature_request">From FR</option>
            <option value="standalone">Standalone</option>
          </select>

          <div className={styles.filterSpacer} />

          {/* Search */}
          <input
            type="search"
            className={styles.searchInput}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search APX-# or title…"
            aria-label="Search work items"
          />

          {hasActiveFilters && (
            <button className={styles.clearFiltersBtn} onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
      </div>

      <div className={styles.divider} />

      {/* Canvas */}
      {isError ? (
        <div className={styles.errorState}>Failed to load work items.</div>
      ) : isLoading ? (
        <div className={styles.canvas}>
          {APEX_WORK_ITEM_STATUSES.map((s) => <SkeletonColumn key={s} />)}
        </div>
      ) : (
        <div className={styles.canvas}>
          {APEX_WORK_ITEM_STATUSES.map((s) => (
            <Column
              key={s}
              status={s}
              items={grouped[s]}
              onCardOpen={handleCardOpen}
              onCardMove={handleCardMove}
              onDrop={handleDrop}
            />
          ))}
        </div>
      )}

      {/* Detail drawer */}
      {openItemId && (
        <ApexWorkItemDetailPanel itemId={openItemId} onClose={handleDrawerClose} />
      )}
    </div>
  );
};
