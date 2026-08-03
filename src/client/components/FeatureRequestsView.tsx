import React, {
  useState,
  useMemo,
  useCallback,
  useRef,
  useEffect,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppShell } from '../hooks/useAppShell';
import {
  useFeatureRequests,
  useUpdateFeatureRequest,
  useReorderFeatureRequests,
  useReanalyzeFeatureRequest,
} from '../hooks/useFeatureRequests';
import type {
  FeatureRequest,
  FeatureRequestStatus,
  FeatureRequestPriority,
  FeatureRequestRisk,
  WorkItemType,
} from '../../shared/types/featureRequest';
import {
  FEATURE_REQUEST_STATUSES,
  WORK_ITEM_TYPES,
} from '../../shared/types/featureRequest';
import {
  isInterviewableWorkItemType,
  toFeatureRequestInterviewPrefill,
} from '../utils/featureRequestInterview';
import { FeatureRequestDetailPanel } from './FeatureRequestDetailPanel';
import { FeatureRequestModal } from './FeatureRequestModal';
import {
  DataGridFilterDivider,
  DataGridFilterPills,
  DataGridFilterSelect,
  DataGridToolbar,
  type DataGridFilterOption,
} from './DataGridToolbar';
import {
  reorderWithSequentialRanks,
  sortFeatureRequestsByRank,
} from '../utils/featureRequestRank';
import gridStyles from './DataGrid.module.css';
import styles from './FeatureRequestsView.module.css';

type SortMode = 'rank' | 'newest' | 'priority';
type StatusFilter = FeatureRequestStatus | '';

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
const STATUS_LABELS: Record<FeatureRequestStatus, string> = {
  new: 'New',
  'under-review': 'Under Review',
  'in-interview': 'In Interview',
  planned: 'Planned',
  declined: 'Declined',
  done: 'Done',
};
const TYPE_LABELS: Record<WorkItemType, string> = {
  feature: 'Feature',
  technical: 'Technical',
  issue: 'Issue',
};
const TYPE_ITEM_LABELS: Record<WorkItemType, string> = {
  feature: 'feature request',
  technical: 'technical item',
  issue: 'issue',
};

const SORT_OPTIONS: readonly DataGridFilterOption<SortMode>[] = [
  { label: 'Rank', value: 'rank' },
  { label: 'Newest first', value: 'newest' },
  { label: 'Priority', value: 'priority' },
];

const STATUS_FILTER_OPTIONS: readonly DataGridFilterOption<StatusFilter>[] =
  FEATURE_REQUEST_STATUSES.map((status) => ({
    label: STATUS_LABELS[status],
    value: status,
  }));

function priorityBadgeClass(p: FeatureRequestPriority): string {
  const map: Record<FeatureRequestPriority, string> = {
    critical: styles['priorityCritical'],
    high: styles['priorityHigh'],
    medium: styles['priorityMedium'],
    low: styles['priorityLow'],
  };
  return `${styles['badge']} ${map[p]}`;
}

function riskBadgeClass(r: FeatureRequestRisk): string {
  const map: Record<FeatureRequestRisk, string> = {
    high: styles['riskHigh'],
    medium: styles['riskMedium'],
    low: styles['riskLow'],
  };
  return `${styles['badge']} ${map[r]}`;
}

function aiStatusBadgeClass(s: string): string {
  const map: Record<string, string> = {
    pending: styles['aiStatusPending'],
    analyzing: styles['aiStatusAnalyzing'],
    complete: styles['aiStatusComplete'],
    failed: styles['aiStatusFailed'],
  };
  return `${styles['badge']} ${map[s] ?? styles['aiStatusPending']}`;
}

function statusBadgeClass(s: FeatureRequestStatus): string {
  const map: Record<FeatureRequestStatus, string> = {
    new: styles['statusNew'],
    'under-review': styles['statusUnderReview'],
    'in-interview': styles['statusInInterview'],
    planned: styles['statusPlanned'],
    declined: styles['statusDeclined'],
    done: styles['statusDone'],
  };
  return `${styles['statusBadge']} ${map[s]}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export const FeatureRequestsView: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { can, isInAnyGroup, permissionsLoaded, selectedProject } =
    useAppShell();
  const { data: requests, isLoading, error } = useFeatureRequests();
  const updateMutation = useUpdateFeatureRequest();
  const reorderMutation = useReorderFeatureRequests();
  const reanalyzeMutation = useReanalyzeFeatureRequest();

  const [sortMode, setSortMode] = useState<SortMode>('rank');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const tabParam = searchParams.get('tab');
  const activeType: WorkItemType = WORK_ITEM_TYPES.includes(
    tabParam as WorkItemType,
  )
    ? (tabParam as WorkItemType)
    : 'feature';

  const canManage = can('feature-requests:manage');
  const canKickOff =
    permissionsLoaded &&
    can('interviews:manage') &&
    isInAnyGroup(['BA', 'Manager', 'Product-Owner']);

  // Reordering only makes sense on an unfiltered, rank-sorted list — otherwise
  // sequential ranks computed from a subset would corrupt the global order.
  const searchQuery = search.trim().toLowerCase();
  const showRank =
    canManage && sortMode === 'rank' && statusFilter === '' && searchQuery === '';

  useEffect(() => {
    setSelectedId(null);
  }, [activeType]);

  const counts = useMemo(
    () =>
      WORK_ITEM_TYPES.reduce<Record<WorkItemType, number>>(
        (result, type) => {
          result[type] =
            requests?.filter((request) => request.type === type).length ?? 0;
          return result;
        },
        { feature: 0, technical: 0, issue: 0 },
      ),
    [requests],
  );

  const typeOptions: readonly DataGridFilterOption<WorkItemType>[] = useMemo(
    () =>
      WORK_ITEM_TYPES.map((type) => ({
        label: `${TYPE_LABELS[type]} ${counts[type]}`,
        value: type,
      })),
    [counts],
  );

  const sorted = useMemo(() => {
    if (!requests) return [];
    let filtered = requests.filter((request) => request.type === activeType);
    if (statusFilter) {
      filtered = filtered.filter((request) => request.status === statusFilter);
    }
    if (searchQuery) {
      filtered = filtered.filter((request) =>
        [
          request.title,
          request.submitterName,
          request.sourceProject,
          request.aiRationale,
          request.request,
        ]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLowerCase().includes(searchQuery)),
      );
    }
    switch (sortMode) {
      case 'rank':
        return sortFeatureRequestsByRank(filtered);
      case 'newest':
        return [...filtered].sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
      case 'priority': {
        return [...filtered].sort((a, b) => {
          const pa =
            PRIORITY_ORDER[a.teamPriority ?? a.aiPriority ?? 'low'] ?? 3;
          const pb =
            PRIORITY_ORDER[b.teamPriority ?? b.aiPriority ?? 'low'] ?? 3;
          if (pa !== pb) return pa - pb;
          return (
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
        });
      }
      default:
        return filtered;
    }
  }, [requests, sortMode, activeType, statusFilter, searchQuery]);

  const handleTypeChange = useCallback(
    (type: WorkItemType) => {
      setSearchParams(type === 'feature' ? {} : { tab: type });
    },
    [setSearchParams],
  );

  const handleUpdate = useCallback(
    (
      id: string,
      patch: Partial<{
        status: FeatureRequestStatus;
        teamPriority: FeatureRequestPriority | null;
        teamRisk: FeatureRequestRisk | null;
        rank: number | null;
      }>,
    ) => {
      updateMutation.mutate({ id, ...patch });
    },
    [updateMutation],
  );

  const handleReorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      const result = reorderWithSequentialRanks(sorted, fromIndex, toIndex);
      if (!result) return;

      const updates = result.order
        .map((item, i) => ({ id: item.id, rank: i + 1 }))
        .filter(
          ({ id, rank }) => sorted.find((item) => item.id === id)?.rank !== rank,
        );

      if (updates.length > 0) {
        reorderMutation.mutate(updates);
      }
    },
    [sorted, reorderMutation],
  );

  const handleMoveUp = useCallback(
    (index: number) => {
      if (index <= 0) return;
      handleReorder(index, index - 1);
    },
    [handleReorder],
  );

  const handleMoveDown = useCallback(
    (index: number) => {
      if (index >= sorted.length - 1) return;
      handleReorder(index, index + 1);
    },
    [sorted.length, handleReorder],
  );

  const handleKickOff = useCallback(
    (request: FeatureRequest) => {
      navigate('/backlog/interview/new', {
        state: {
          featureRequest: toFeatureRequestInterviewPrefill(request),
        },
      });
    },
    [navigate],
  );

  const selectedRequest = useMemo(
    () =>
      selectedId ? (requests?.find((r) => r.id === selectedId) ?? null) : null,
    [requests, selectedId],
  );

  const filtersActive = statusFilter !== '' || searchQuery !== '';

  if (isLoading) {
    return <div className={styles['loading']}>Loading Apex Backlog…</div>;
  }
  if (error) {
    return (
      <div className={styles['error']}>
        Failed to load Apex Backlog: {(error as Error).message}
      </div>
    );
  }

  const itemNoun = TYPE_ITEM_LABELS[activeType];

  return (
    <div className={styles['container']}>
      <div className={styles['content']}>
        <section
          className={gridStyles.section}
          {...{ 'data-testid': 'feature-requests-view' }}
        >
          <div className={gridStyles.header}>
            <div>
              <h2 className={gridStyles.title}>Apex Backlog</h2>
              <p className={gridStyles.hint}>
                {sorted.length}{' '}
                {sorted.length === 1 ? itemNoun : `${itemNoun}s`}
                {filtersActive ? ' (filtered)' : ''}
              </p>
            </div>
            {can('feature-requests:submit') && selectedProject && (
              <button
                type="button"
                className={gridStyles.buttonPrimary}
                onClick={() => setIsCreateModalOpen(true)}
                {...{ 'data-testid': 'feature-request-create' }}
              >
                <span aria-hidden="true">+ </span>
                New {itemNoun}
              </button>
            )}
          </div>

          <DataGridToolbar
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder={`Search ${itemNoun}s…`}
            searchTestId="feature-requests-search"
          >
            <DataGridFilterPills
              options={typeOptions}
              value={activeType}
              onChange={handleTypeChange}
              testIdPrefix="feature-requests-type"
              aria-label="Work item type"
              {...{ 'data-testid': 'feature-requests-type-filters' }}
            />
            <DataGridFilterDivider />
            <DataGridFilterSelect
              label="Status"
              value={statusFilter}
              onChange={setStatusFilter}
              options={STATUS_FILTER_OPTIONS}
              includeEmptyOption
              emptyOptionLabel="All statuses"
              {...{ 'data-testid': 'feature-requests-status-filter' }}
            />
            <DataGridFilterSelect
              label="Sort"
              value={sortMode}
              onChange={setSortMode}
              options={SORT_OPTIONS}
              {...{ 'data-testid': 'feature-requests-sort' }}
            />
          </DataGridToolbar>

          {sorted.length === 0 ? (
            <p className={gridStyles.empty} {...{ 'data-testid': 'feature-requests-empty' }}>
              {filtersActive
                ? `No ${itemNoun}s match your filters.`
                : `No ${itemNoun}s yet. Create one to get started.`}
            </p>
          ) : (
            <div className={gridStyles.tableWrap}>
              <table
                className={gridStyles.table}
                {...{ 'data-testid': 'feature-requests-table' }}
              >
                <thead>
                  <tr>
                    {showRank && <th scope="col">#</th>}
                    <th scope="col">Request</th>
                    <th scope="col">Status</th>
                    <th scope="col">AI Analysis</th>
                    <th scope="col">Team Override</th>
                    <th scope="col">Rationale</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((fr, idx) => (
                    <FeatureRequestRow
                      key={fr.id}
                      fr={fr}
                      index={idx}
                      total={sorted.length}
                      canManage={canManage}
                      canKickOff={
                        isInterviewableWorkItemType(activeType) && canKickOff
                      }
                      showRank={showRank}
                      isDragging={dragIndex === idx}
                      isDropTarget={
                        dropTargetIndex === idx &&
                        dragIndex !== null &&
                        dragIndex !== idx
                      }
                      onEdit={() => setSelectedId(fr.id)}
                      onMoveUp={handleMoveUp}
                      onMoveDown={handleMoveDown}
                      onDragStart={() => {
                        dragIndexRef.current = idx;
                        setDragIndex(idx);
                      }}
                      onDragEnd={() => {
                        dragIndexRef.current = null;
                        setDragIndex(null);
                        setDropTargetIndex(null);
                      }}
                      onDragOver={() => setDropTargetIndex(idx)}
                      onDragLeave={() =>
                        setDropTargetIndex((prev) =>
                          prev === idx ? null : prev,
                        )
                      }
                      onDrop={() => {
                        const fromIndex = dragIndexRef.current;
                        if (fromIndex !== null) handleReorder(fromIndex, idx);
                        dragIndexRef.current = null;
                        setDragIndex(null);
                        setDropTargetIndex(null);
                      }}
                      onKickOffInterview={handleKickOff}
                      onViewInterview={(interviewId) =>
                        navigate(`/backlog/interview/${interviewId}`)
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {selectedRequest && (
        <FeatureRequestDetailPanel
          fr={selectedRequest}
          canManage={canManage}
          onClose={() => setSelectedId(null)}
          onUpdate={handleUpdate}
          onReanalyze={(id) => reanalyzeMutation.mutate(id)}
          isReanalyzing={reanalyzeMutation.isPending}
          {...{ 'data-testid': 'feature-request-detail-panel' }}
        />
      )}

      {isCreateModalOpen && selectedProject && (
        <FeatureRequestModal
          selectedProject={selectedProject}
          type={activeType}
          onClose={() => setIsCreateModalOpen(false)}
          {...{ 'data-testid': 'feature-request-create-modal' }}
        />
      )}
    </div>
  );
};

/* ── Row component ─────────────────────────────── */

interface RowProps {
  fr: FeatureRequest;
  index: number;
  total: number;
  canManage: boolean;
  canKickOff: boolean;
  showRank: boolean;
  isDragging: boolean;
  isDropTarget: boolean;
  onEdit: () => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: () => void;
  onDragLeave: () => void;
  onDrop: () => void;
  onKickOffInterview: (fr: FeatureRequest) => void;
  onViewInterview: (interviewId: string) => void;
}

const FeatureRequestRow: React.FC<RowProps> = ({
  fr,
  index,
  total,
  canManage,
  canKickOff,
  showRank,
  isDragging,
  isDropTarget,
  onEdit,
  onMoveUp,
  onMoveDown,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  onKickOffInterview,
  onViewInterview,
}) => {
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', fr.id);
    onDragStart();
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    onDragOver();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    onDrop();
  };

  const rowClass =
    [
      isDragging ? styles['rowDragging'] : '',
      isDropTarget ? styles['rowDropTarget'] : '',
    ]
      .filter(Boolean)
      .join(' ') || undefined;

  const showKickOff =
    canKickOff && isInterviewableWorkItemType(fr.type) && !fr.interviewId;
  const showViewInterview =
    isInterviewableWorkItemType(fr.type) && Boolean(fr.interviewId);

  return (
    <tr
      className={rowClass}
      onDragOver={showRank ? handleDragOver : undefined}
      onDragLeave={showRank ? onDragLeave : undefined}
      onDrop={showRank ? handleDrop : undefined}
      {...{ 'data-testid': `feature-request-row-${fr.id}` }}
    >
      {showRank && (
        <td className={styles['rankCell']}>
          <div className={styles['rankControls']}>
            <span
              className={styles['dragHandle']}
              draggable
              onDragStart={handleDragStart}
              onDragEnd={onDragEnd}
              title="Drag to reorder"
              aria-label="Drag to reorder"
            >
              ⠿
            </span>
            <span className={styles['rankValue']}>{index + 1}</span>
            <span className={styles['rankArrows']}>
              <button
                className={styles['rankBtn']}
                disabled={index === 0}
                onClick={() => onMoveUp(index)}
                title="Move up"
                type="button"
                {...{ 'data-testid': `feature-request-rank-up-${fr.id}` }}
              >
                ▲
              </button>
              <button
                className={styles['rankBtn']}
                disabled={index === total - 1}
                onClick={() => onMoveDown(index)}
                title="Move down"
                type="button"
                {...{ 'data-testid': `feature-request-rank-down-${fr.id}` }}
              >
                ▼
              </button>
            </span>
          </div>
        </td>
      )}

      <td>
        <div className={styles['titleText']}>{fr.title}</div>
        <div className={styles['submitterMeta']}>
          {fr.submitterName ?? 'Unknown'} · {fr.sourceProject} ·{' '}
          {formatDate(fr.createdAt)}
        </div>
      </td>

      <td>
        <span className={statusBadgeClass(fr.status)}>
          {STATUS_LABELS[fr.status]}
        </span>
      </td>

      <td>
        <div className={styles['aiBadges']}>
          {fr.aiStatus === 'analyzing' && (
            <span className={styles['spinner']} />
          )}
          <span className={aiStatusBadgeClass(fr.aiStatus)}>{fr.aiStatus}</span>
          {fr.aiPriority && (
            <span className={priorityBadgeClass(fr.aiPriority)}>
              P: {fr.aiPriority}
            </span>
          )}
          {fr.aiRisk && (
            <span className={riskBadgeClass(fr.aiRisk)}>R: {fr.aiRisk}</span>
          )}
        </div>
      </td>

      <td>
        <div className={styles['aiBadges']}>
          {fr.teamPriority && (
            <span className={priorityBadgeClass(fr.teamPriority)}>
              {fr.teamPriority}
            </span>
          )}
          {fr.teamRisk && (
            <span className={riskBadgeClass(fr.teamRisk)}>{fr.teamRisk}</span>
          )}
          {!fr.teamPriority && !fr.teamRisk && (
            <span className={styles['muted']}>—</span>
          )}
        </div>
      </td>

      <td className={styles['rationaleCell']}>
        {fr.aiRationale ?? <span className={styles['muted']}>—</span>}
      </td>

      <td>
        <div className={gridStyles.rowActions}>
          <button
            type="button"
            className={gridStyles.buttonGhost}
            onClick={onEdit}
            {...{ 'data-testid': `feature-request-edit-${fr.id}` }}
          >
            {canManage ? 'Edit' : 'View'}
          </button>
          {showKickOff && (
            <button
              type="button"
              className={gridStyles.buttonGhost}
              onClick={() => onKickOffInterview(fr)}
              {...{ 'data-testid': `feature-request-kickoff-${fr.id}` }}
            >
              Kick off interview
            </button>
          )}
          {showViewInterview && fr.interviewId && (
            <button
              type="button"
              className={gridStyles.buttonGhost}
              onClick={() => onViewInterview(fr.interviewId!)}
              {...{ 'data-testid': `feature-request-view-interview-${fr.id}` }}
            >
              View interview
            </button>
          )}
        </div>
      </td>
    </tr>
  );
};

export default FeatureRequestsView;
