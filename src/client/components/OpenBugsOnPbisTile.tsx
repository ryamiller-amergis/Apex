import React from 'react';
import type { OpenBugsOnPbisData, TileResult } from '../../shared/types/homeDashboard';
import styles from './HomeDashboardTiles.module.css';

const MAX_ROWS = 20;

interface OpenBugsOnPbisTileProps {
  result: TileResult<OpenBugsOnPbisData> | null;
  onRetry: () => void;
}

export const OpenBugsOnPbisTile: React.FC<OpenBugsOnPbisTileProps> = ({ result, onRetry }) => {
  if (!result) return null;

  const hasError = result.status === 'error' || !result.data;

  return (
    <article
      className={styles.card}
      aria-labelledby="home-dashboard-bugs-title"
      {...{ 'data-testid': 'home-dashboard-bugs-card' }}
    >
      <header className={styles.header}>
        <h3 id="home-dashboard-bugs-title" className={styles.title}>Open Bugs on PBIs</h3>
        {!hasError && result.data ? (
          <span className={styles['bug-total']}>{result.data.totalOpenBugs} bugs total</span>
        ) : null}
      </header>

      {hasError ? (
        <div className={styles.error} role="alert">
          <span className={styles['error-mark']} aria-hidden="true">!</span>
          <span>{result.message ?? 'Unable to fetch bug data.'}</span>
          <button
            type="button"
            className={styles.retry}
            onClick={onRetry}
            {...{ 'data-testid': 'home-dashboard-bugs-retry' }}
          >
            Retry
          </button>
        </div>
      ) : result.data?.rows.length === 0 ? (
        <div className={styles.empty}>
          <p>No open bugs on any PBIs.</p>
          <a
            className={styles['view-all']}
            href="/calendar"
            aria-label="View all open bugs on PBIs"
            {...{ 'data-testid': 'home-dashboard-bugs-view-all' }}
          >
            View Calendar
          </a>
        </div>
      ) : (
        <>
          <ul className={`${styles.list} ${styles['bugs-list']}`}>
            {result.data?.rows.slice(0, MAX_ROWS).map((row) => (
              <li key={row.pbiId} className={styles['bug-row']}>
                <a
                  className={styles['row-link']}
                  href="/calendar"
                  aria-label={`${row.title}, ${row.openBugCount} open bugs`}
                  {...{ 'data-testid': `home-dashboard-bugs-row-${row.pbiId}` }}
                >
                  <span className={styles['bug-id']}>#{row.pbiId}</span>
                  <span className={styles['row-name']}>{row.title}</span>
                  <span className={styles['bug-count']}>{row.openBugCount}</span>
                </a>
              </li>
            ))}
          </ul>
          <a
            className={styles['view-all']}
            href="/calendar"
            aria-label="View all open bugs on PBIs"
            {...{ 'data-testid': 'home-dashboard-bugs-view-all' }}
          >
            View all
          </a>
        </>
      )}
    </article>
  );
};

export default OpenBugsOnPbisTile;
