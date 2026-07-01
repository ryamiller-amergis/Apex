import React, { useState, useMemo, useCallback } from 'react';
import { useAppShell } from '../hooks/useAppShell';
import {
  useFeatureRequests,
  useUpdateFeatureRequest,
  useReanalyzeFeatureRequest,
} from '../hooks/useFeatureRequests';
import type {
  FeatureRequest,
  FeatureRequestStatus,
  FeatureRequestPriority,
  FeatureRequestRisk,
} from '../../shared/types/featureRequest';
import {
  FEATURE_REQUEST_STATUSES,
  FEATURE_REQUEST_PRIORITIES,
  FEATURE_REQUEST_RISKS,
} from '../../shared/types/featureRequest';
import { FeatureRequestDetailPanel } from './FeatureRequestDetailPanel';
import styles from './FeatureRequestsView.module.css';

type SortMode = 'rank' | 'newest' | 'priority';

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const STATUS_LABELS: Record<FeatureRequestStatus, string> = {
  'new': 'New',
  'under-review': 'Under Review',
  'planned': 'Planned',
  'declined': 'Declined',
  'done': 'Done',
};

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
    'new': styles['statusNew'],
    'under-review': styles['statusUnderReview'],
    'planned': styles['statusPlanned'],
    'declined': styles['statusDeclined'],
    'done': styles['statusDone'],
  };
  return `${styles['statusBadge']} ${map[s]}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export const FeatureRequestsView: React.FC = () => {
  const { can } = useAppShell();
  const { data: requests, isLoading, error } = useFeatureRequests();
  const updateMutation = useUpdateFeatureRequest();
  const reanalyzeMutation = useReanalyzeFeatureRequest();

  const [sortMode, setSortMode] = useState<SortMode>('rank');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);

  const canManage = can('feature-requests:manage');

  const sorted = useMemo(() => {
    if (!requests) return [];
    const items = [...requests];
    switch (sortMode) {
      case 'rank':
        return items.sort((a, b) => {
          const ra = a.rank ?? Number.MAX_SAFE_INTEGER;
          const rb = b.rank ?? Number.MAX_SAFE_INTEGER;
          if (ra !== rb) return ra - rb;
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        });
      case 'newest':
        return items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      case 'priority': {
        return items.sort((a, b) => {
          const pa = PRIORITY_ORDER[a.teamPriority ?? a.aiPriority ?? 'low'] ?? 3;
          const pb = PRIORITY_ORDER[b.teamPriority ?? b.aiPriority ?? 'low'] ?? 3;
          if (pa !== pb) return pa - pb;
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        });
      }
      default:
        return items;
    }
  }, [requests, sortMode]);

  const handleUpdate = useCallback(
    (id: string, patch: Partial<{ status: FeatureRequestStatus; teamPriority: FeatureRequestPriority | null; teamRisk: FeatureRequestRisk | null; rank: number | null }>) => {
      updateMutation.mutate({ id, ...patch });
    },
    [updateMutation],
  );

  const handleMoveUp = useCallback(
    (index: number) => {
      if (index <= 0) return;
      const current = sorted[index];
      const above = sorted[index - 1];
      const newRankCurrent = above.rank ?? index;
      const newRankAbove = current.rank ?? index + 1;
      handleUpdate(current.id, { rank: newRankCurrent });
      handleUpdate(above.id, { rank: newRankAbove });
    },
    [sorted, handleUpdate],
  );

  const handleMoveDown = useCallback(
    (index: number) => {
      if (index >= sorted.length - 1) return;
      const current = sorted[index];
      const below = sorted[index + 1];
      const newRankCurrent = below.rank ?? index + 2;
      const newRankBelow = current.rank ?? index + 1;
      handleUpdate(current.id, { rank: newRankCurrent });
      handleUpdate(below.id, { rank: newRankBelow });
    },
    [sorted, handleUpdate],
  );

  const handleReorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
      const reordered = [...sorted];
      const [moved] = reordered.splice(fromIndex, 1);
      reordered.splice(toIndex, 0, moved);
      reordered.forEach((item, i) => {
        const newRank = i + 1;
        if (item.rank !== newRank) {
          handleUpdate(item.id, { rank: newRank });
        }
      });
    },
    [sorted, handleUpdate],
  );

  const selectedRequest = useMemo(
    () => (selectedId ? requests?.find((r) => r.id === selectedId) ?? null : null),
    [requests, selectedId],
  );

  if (isLoading) return <div className={styles['loading']}>Loading feature requests…</div>;
  if (error) return <div className={styles['error']}>Failed to load feature requests: {(error as Error).message}</div>;
  if (!requests || requests.length === 0) return <div className={styles['empty']}>No feature requests yet.</div>;

  return (
    <div className={styles['container']}>
      <div className={styles['header']}>
        <h2>Feature Requests</h2>
        <div className={styles['headerRight']}>
          <label>
            <select
              className={styles['sortSelect']}
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
            >
              <option value="rank">Sort by Rank</option>
              <option value="newest">Newest First</option>
              <option value="priority">Priority</option>
            </select>
          </label>
        </div>
      </div>

      <div className={styles['content']}>
        <table className={styles['table']}>
          <thead>
            <tr>
              {canManage && sortMode === 'rank' && <th>#</th>}
              <th>Request</th>
              <th>Status</th>
              <th>AI Analysis</th>
              <th>Team Override</th>
              <th>Rationale</th>
              {canManage && <th>Actions</th>}
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
                showRank={canManage && sortMode === 'rank'}
                isDragging={dragIndex === idx}
                isDropTarget={dropTargetIndex === idx && dragIndex !== null && dragIndex !== idx}
                onSelect={() => setSelectedId(fr.id)}
                onUpdate={handleUpdate}
                onMoveUp={handleMoveUp}
                onMoveDown={handleMoveDown}
                onDragStart={() => setDragIndex(idx)}
                onDragEnd={() => {
                  setDragIndex(null);
                  setDropTargetIndex(null);
                }}
                onDragOver={() => setDropTargetIndex(idx)}
                onDragLeave={() => setDropTargetIndex((prev) => (prev === idx ? null : prev))}
                onDrop={() => {
                  if (dragIndex !== null) handleReorder(dragIndex, idx);
                  setDragIndex(null);
                  setDropTargetIndex(null);
                }}
                onReanalyze={(id) => reanalyzeMutation.mutate(id)}
                isReanalyzing={reanalyzeMutation.isPending}
              />
            ))}
          </tbody>
        </table>
      </div>

      {selectedRequest && (
        <FeatureRequestDetailPanel
          fr={selectedRequest}
          canManage={canManage}
          onClose={() => setSelectedId(null)}
          onUpdate={handleUpdate}
          onReanalyze={(id) => reanalyzeMutation.mutate(id)}
          isReanalyzing={reanalyzeMutation.isPending}
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
  showRank: boolean;
  isDragging: boolean;
  isDropTarget: boolean;
  onSelect: () => void;
  onUpdate: (id: string, patch: Partial<{ status: FeatureRequestStatus; teamPriority: FeatureRequestPriority | null; teamRisk: FeatureRequestRisk | null; rank: number | null }>) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: () => void;
  onDragLeave: () => void;
  onDrop: () => void;
  onReanalyze: (id: string) => void;
  isReanalyzing: boolean;
}

const FeatureRequestRow: React.FC<RowProps> = ({
  fr, index, total, canManage, showRank,
  isDragging, isDropTarget, onSelect,
  onUpdate, onMoveUp, onMoveDown,
  onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop,
  onReanalyze, isReanalyzing,
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

  const rowClass = [
    isDragging ? styles['rowDragging'] : '',
    isDropTarget ? styles['rowDropTarget'] : '',
  ].filter(Boolean).join(' ');

  return (
    <tr
      className={rowClass || undefined}
      onDragOver={showRank ? handleDragOver : undefined}
      onDragLeave={showRank ? onDragLeave : undefined}
      onDrop={showRank ? handleDrop : undefined}
    >
      {/* Rank controls */}
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
            <button
              className={styles['rankBtn']}
              disabled={index === 0}
              onClick={() => onMoveUp(index)}
              title="Move up"
              type="button"
            >
              ▲
            </button>
            <span className={styles['rankValue']}>{fr.rank ?? index + 1}</span>
            <button
              className={styles['rankBtn']}
              disabled={index === total - 1}
              onClick={() => onMoveDown(index)}
              title="Move down"
              type="button"
            >
              ▼
            </button>
          </div>
        </td>
      )}

      {/* Title / submitter / source / date */}
      <td className={styles['titleCell']}>
        <button className={styles['titleButton']} type="button" onClick={onSelect}>
          <div className={styles['titleText']}>{fr.title}</div>
          <div className={styles['submitterMeta']}>
            {fr.submitterName ?? 'Unknown'} · {fr.sourceProject} · {formatDate(fr.createdAt)}
          </div>
          <span className={styles['viewDetailsHint']}>View details</span>
        </button>
      </td>

      {/* Status */}
      <td>
        {canManage ? (
          <select
            className={styles['controlSelect']}
            value={fr.status}
            onChange={(e) => onUpdate(fr.id, { status: e.target.value as FeatureRequestStatus })}
          >
            {FEATURE_REQUEST_STATUSES.map((s) => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>
        ) : (
          <span className={statusBadgeClass(fr.status)}>{STATUS_LABELS[fr.status]}</span>
        )}
      </td>

      {/* AI Analysis */}
      <td>
        <div className={styles['aiAnalysis']}>
          <div className={styles['aiBadges']}>
            {fr.aiStatus === 'analyzing' && <span className={styles['spinner']} />}
            <span className={aiStatusBadgeClass(fr.aiStatus)}>{fr.aiStatus}</span>
            {fr.aiPriority && (
              <span className={priorityBadgeClass(fr.aiPriority)}>P: {fr.aiPriority}</span>
            )}
            {fr.aiRisk && (
              <span className={riskBadgeClass(fr.aiRisk)}>R: {fr.aiRisk}</span>
            )}
          </div>
        </div>
      </td>

      {/* Team overrides */}
      <td>
        {canManage ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <select
              className={styles['controlSelect']}
              value={fr.teamPriority ?? ''}
              onChange={(e) =>
                onUpdate(fr.id, {
                  teamPriority: (e.target.value || null) as FeatureRequestPriority | null,
                })
              }
            >
              <option value="">Priority…</option>
              {FEATURE_REQUEST_PRIORITIES.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <select
              className={styles['controlSelect']}
              value={fr.teamRisk ?? ''}
              onChange={(e) =>
                onUpdate(fr.id, {
                  teamRisk: (e.target.value || null) as FeatureRequestRisk | null,
                })
              }
            >
              <option value="">Risk…</option>
              {FEATURE_REQUEST_RISKS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
        ) : (
          <div className={styles['aiBadges']}>
            {fr.teamPriority && (
              <span className={priorityBadgeClass(fr.teamPriority)}>{fr.teamPriority}</span>
            )}
            {fr.teamRisk && (
              <span className={riskBadgeClass(fr.teamRisk)}>{fr.teamRisk}</span>
            )}
            {!fr.teamPriority && !fr.teamRisk && <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>—</span>}
          </div>
        )}
      </td>

      {/* Rationale */}
      <td className={styles['rationaleCell']}>
        {fr.aiRationale ?? <span style={{ color: 'var(--text-muted)' }}>—</span>}
      </td>

      {/* Actions */}
      {canManage && (
        <td className={styles['actionsCell']}>
          <button
            className={styles['reanalyzeBtn']}
            type="button"
            disabled={isReanalyzing || fr.aiStatus === 'analyzing'}
            onClick={() => onReanalyze(fr.id)}
          >
            {fr.aiStatus === 'analyzing' ? 'Analyzing…' : 'Re-analyze'}
          </button>
        </td>
      )}
    </tr>
  );
};

export default FeatureRequestsView;
