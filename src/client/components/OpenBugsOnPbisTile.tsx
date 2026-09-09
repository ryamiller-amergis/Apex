import React from 'react';
import type { OpenBugsOnPbisData, TileResult } from '../../shared/types/homeDashboard';
import { HomeTileInfo } from './HomeTileInfo';
import styles from './HomeDashboardTiles.module.css';

const MAX_ROWS = 20;

interface OpenBugsOnPbisTileProps {
  result: TileResult<OpenBugsOnPbisData> | null;
  onRetry: () => void;
  onSelectPbi?: (pbiId: string) => void;
}

export const OpenBugsOnPbisTile: React.FC<OpenBugsOnPbisTileProps> = ({
  result,
  onRetry,
  onSelectPbi,
}) => {
  if (!result) return null;

  const data = result.data ?? result.lastKnownData ?? null;
  const isStale = result.status === 'error' && Boolean(result.lastKnownData);
  const hasError = !data;

  return (
    <article
      className={styles.card}
      aria-labelledby="home-dashboard-bugs-title"
      {...{ 'data-testid': 'home-dashboard-bugs-card' }}
    >
      <header className={styles.header}>
        <div className={styles['title-group']}>
          <h3 id="home-dashboard-bugs-title" className={styles.title}>Open Bugs on PBIs</h3>
          <HomeTileInfo title="Open Bugs on PBIs" data-testid="home-dashboard-bugs-info">
            <p>
              PBIs that currently have at least one <strong>open bug linked as a
              child</strong>. A PBI drops off as soon as its last bug closes.
            </p>
            <p>
              <strong>Mine</strong> limits this to PBIs you have owned at any point.
            </p>
            <p>Select a row to open that PBI in the details panel.</p>
          </HomeTileInfo>
        </div>
        {!hasError && data ? (
          <span className={styles['bug-total']}>{data.totalOpenBugs} bugs total</span>
        ) : null}
      </header>

      {isStale && (
        <div className={styles.stale} role="status">
          <span>Last known data · refresh unavailable</span>
          <button
            type="button"
            className={styles.retry}
            onClick={onRetry}
            {...{ 'data-testid': 'home-dashboard-bugs-retry' }}
          >
            Retry
          </button>
        </div>
      )}

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
      ) : data?.rows.length === 0 ? (
        <div className={styles.empty}>
          <p>No open bugs on any PBIs. A PBI appears here once a bug is linked to it as a child and left open.</p>
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
            {data?.rows.slice(0, MAX_ROWS).map((row) => (
              <li key={row.pbiId} className={styles['bug-row']}>
                {onSelectPbi ? (
                  <button
                    type="button"
                    className={`${styles['row-link']} ${styles['row-button']}`}
                    onClick={() => onSelectPbi(row.pbiId)}
                    aria-label={`Open ${row.title} details, ${row.openBugCount} open bugs`}
                    {...{ 'data-testid': `home-dashboard-bugs-row-${row.pbiId}` }}
                  >
                    <span className={styles['bug-id']}>#{row.pbiId}</span>
                    <span className={styles['row-name']}>{row.title}</span>
                    <span className={styles['bug-count']}>{row.openBugCount}</span>
                  </button>
                ) : (
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
                )}
              </li>
            ))}
          </ul>
          <a
            className={`${styles['view-all']} ${styles['view-all-footer']}`}
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
