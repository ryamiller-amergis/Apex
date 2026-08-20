import React, { useMemo } from 'react';
import {
  APEX_WORK_ITEM_STATUSES,
  STATUS_META,
  type ApexWorkItemStatus,
} from '../../shared/types/apexWorkItem';
import { useApexWorkItems, useBoardEventStats } from '../hooks/useApexWorkItems';
import styles from './BoardPlanningStats.module.css';

export type BoardPlanningMode = 'cycle-time' | 'dev-stats' | 'qa' | 'ai-analysis';

const MODE_COPY: Record<BoardPlanningMode, { title: string; subtitle: string }> = {
  'cycle-time': {
    title: 'Board cycle view',
    subtitle: 'Status distribution and event activity for Work Board items',
  },
  'dev-stats': {
    title: 'Board planning stats',
    subtitle: 'Created, moved, and completed activity across the Work Board',
  },
  qa: {
    title: 'Board QA view',
    subtitle: 'Review and done items from the Work Board (no ADO MaxView data)',
  },
  'ai-analysis': {
    title: 'Board activity overview',
    subtitle: 'Owner and status breakdown for Work Board items',
  },
};

interface BoardPlanningStatsProps {
  project: string;
  mode?: BoardPlanningMode;
}

function countAction(
  rows: Array<{ action: string; count: number }> | undefined,
  action: string,
): number {
  return rows?.find((r) => r.action === action)?.count ?? 0;
}

export const BoardPlanningStats: React.FC<BoardPlanningStatsProps> = ({
  project,
  mode = 'dev-stats',
}) => {
  const copy = MODE_COPY[mode];
  const { data: eventStats, isLoading: statsLoading, error: statsError } =
    useBoardEventStats(project);
  const { data: items, isLoading: itemsLoading, error: itemsError } = useApexWorkItems({
    project,
  });

  const created = countAction(eventStats, 'created');
  const moved = countAction(eventStats, 'moved');
  const doneItems = useMemo(
    () => (items ?? []).filter((i) => i.status === 'done').length,
    [items],
  );

  const byOwner = useMemo(() => {
    const map = new Map<string, { name: string; count: number }>();
    for (const item of items ?? []) {
      const key = item.owner.oid;
      const prev = map.get(key);
      if (prev) prev.count += 1;
      else map.set(key, { name: item.owner.displayName, count: 1 });
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [items]);

  const byStatus = useMemo(() => {
    const counts: Record<ApexWorkItemStatus, number> = {
      idea: 0,
      ready: 0,
      'in-progress': 0,
      review: 0,
      done: 0,
    };
    for (const item of items ?? []) {
      counts[item.status] = (counts[item.status] ?? 0) + 1;
    }
    return counts;
  }, [items]);

  const maxStatus = Math.max(1, ...APEX_WORK_ITEM_STATUSES.map((s) => byStatus[s]));
  const loading = statsLoading || itemsLoading;
  const error = statsError ?? itemsError;

  return (
    <div className={styles.container} data-testid="board-planning-stats">
      <div className={styles.header}>
        <h1 className={styles.title}>{copy.title}</h1>
        <p className={styles.subtitle}>{copy.subtitle}</p>
      </div>

      {error && <div className={styles.error}>{error.message}</div>}
      {loading && <div className={styles.empty}>Loading board stats…</div>}

      {!loading && !error && (
        <>
          <div className={styles.cards}>
            <div className={styles.card}>
              <span className={styles.cardLabel}>Created (events)</span>
              <span className={styles.cardValue}>{created}</span>
            </div>
            <div className={styles.card}>
              <span className={styles.cardLabel}>Moved (events)</span>
              <span className={styles.cardValue}>{moved}</span>
            </div>
            <div className={styles.card}>
              <span className={styles.cardLabel}>Done (items)</span>
              <span className={styles.cardValue}>{doneItems}</span>
            </div>
            <div className={styles.card}>
              <span className={styles.cardLabel}>Total items</span>
              <span className={styles.cardValue}>{(items ?? []).length}</span>
            </div>
          </div>

          <div className={styles.panels}>
            <section className={styles.panel} aria-labelledby="board-status-dist">
              <h2 id="board-status-dist">Status distribution</h2>
              {(items ?? []).length === 0 ? (
                <div className={styles.empty}>No work items yet.</div>
              ) : (
                APEX_WORK_ITEM_STATUSES.map((status) => (
                  <div key={status} className={styles.barRow}>
                    <span className={styles.barLabel}>{STATUS_META[status].label}</span>
                    <div className={styles.barTrack}>
                      <div
                        className={styles.barFill}
                        style={{ width: `${(byStatus[status] / maxStatus) * 100}%` }}
                      />
                    </div>
                    <span className={styles.barCount}>{byStatus[status]}</span>
                  </div>
                ))
              )}
            </section>

            <section className={styles.panel} aria-labelledby="board-by-owner">
              <h2 id="board-by-owner">By owner</h2>
              {byOwner.length === 0 ? (
                <div className={styles.empty}>No owners yet.</div>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Owner</th>
                      <th>Items</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byOwner.map((row) => (
                      <tr key={row.name}>
                        <td>{row.name}</td>
                        <td>{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
};

export default BoardPlanningStats;
