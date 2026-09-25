import React from 'react';
import type { AssignedToMeData, TileResult } from '../../shared/types/homeDashboard';
import styles from './HomeDashboardTiles.module.css';

export const AssignedToMeTile: React.FC<{
  result: TileResult<AssignedToMeData> | null;
  onRetry: () => void;
}> = ({ result, onRetry }) => {
  if (!result) return null;
  return (
    <article
      className={styles.card}
      aria-labelledby="home-dashboard-assigned-title"
      data-testid="home-dashboard-assigned-to-me-card"
    >
      <header className={styles.header}>
        <h3 id="home-dashboard-assigned-title" className={styles.title}>Assigned to me</h3>
        {result.data ? <span className={styles.count}>{result.data.total}</span> : null}
      </header>
      {result.status === 'error' || !result.data ? (
        <div className={styles.error} role="alert" data-testid="assigned-to-me-error">
          <span>{result.message ?? 'Could not load assigned work.'}</span>
          <button type="button" className={styles.retry} onClick={onRetry} data-testid="assigned-to-me-retry">Retry</button>
        </div>
      ) : result.data.total === 0 ? (
        <p className={styles['empty-line']} data-testid="assigned-to-me-empty">
          No pending Playbook gates.
        </p>
      ) : (
        <>
          <p data-testid="assigned-to-me-summary">
            Soonest deadline: <time dateTime={result.data.soonestDeadline ?? undefined}>
              {result.data.items[0]?.urgencyText}
            </time>
          </p>
          <ul className={styles.list} data-testid="assigned-to-me-list">
            {result.data.items.map((item) => (
              <li key={item.id}>
                <a className={styles['row-link']} href={item.href} data-testid="assigned-to-me-row">
                  <span className={styles['row-name']}>{item.title}</span>
                  <time className={styles['row-meta']} dateTime={item.deadline}>
                    {item.urgencyText}
                  </time>
                </a>
              </li>
            ))}
          </ul>
          <a
            className={styles['view-all']}
            href={result.data.viewAllHref}
            data-testid="assigned-to-me-view-all"
          >
            {result.data.total > result.data.items.length
              ? `Showing ${result.data.items.length} of ${result.data.total} — view all`
              : 'View all assigned work'}
          </a>
        </>
      )}
    </article>
  );
};
