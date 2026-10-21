import React from 'react';
import type { DevToProductionData, TileResult } from '../../shared/types/homeDashboard';
import { HomeTileInfo } from './HomeTileInfo';
import styles from './HomeDashboardTiles.module.css';

interface DevToProductionTileProps {
  result: TileResult<DevToProductionData> | null;
  onRetry: () => void;
}

export const DevToProductionTile: React.FC<DevToProductionTileProps> = ({ result, onRetry }) => {
  if (!result) return null;

  const data = result.data ?? result.lastKnownData ?? null;
  const isStale = result.status === 'error' && Boolean(result.lastKnownData);
  const hasError = !data;

  if (hasError) {
    return (
      <article
        className={styles.card}
        aria-labelledby="home-dashboard-devprod-title"
        {...{ 'data-testid': 'home-dashboard-devprod-card' }}
      >
        <header className={styles.header}>
          <h3 id="home-dashboard-devprod-title" className={styles.title}>Dev → Production</h3>
        </header>
        <div className={styles.error} role="alert">
          <span className={styles['error-mark']} aria-hidden="true">!</span>
          <span>{result.message ?? 'Failed to load Releases data.'}</span>
          <button
            type="button"
            className={styles.retry}
            onClick={onRetry}
            {...{ 'data-testid': 'home-dashboard-devprod-retry' }}
          >
            Retry
          </button>
        </div>
      </article>
    );
  }

  if (!data) return null;

  const accessibleLabel = data.medianDays === null
    ? 'Developer to production: unavailable; no completed release work items in the last 90 days. View Releases'
    : `Developer to production: ${data.medianDays} days median for completed release work items in the last 90 days. View Releases`;

  const cardContent = (
    <>
      <header className={styles.header}>
        <div className={styles['title-group']}>
          <h3 className={styles.title}>Dev → Production</h3>
          <HomeTileInfo title="Dev → Production" data-testid="home-dashboard-devprod-info">
            <p>
              The <strong>median cycle time for completed work items</strong> across
              releases completed in the last 90 days.
            </p>
            <p>
              For ReleaseVersion epics, each related PBI, TBI, or bug is one sample:
              its last entry into In Progress through its last entry into Done or
              Closed. Incomplete items are excluded.
            </p>
            <p>
              Projects with deployment tracking use release-tagged work from development
              start through its production deployment.
            </p>
            <p>Always project-wide — there is no Mine view for this card.</p>
          </HomeTileInfo>
        </div>
        <span className={styles.scope}>Team · Last 90 days</span>
      </header>
      <div className={styles.devprod}>
        <span className={`${styles['devprod-value']} ${data.medianDays === null ? styles['kpi-empty'] : ''}`}>
          {data.medianDays ?? '—'}
        </span>
        <span className={styles['devprod-unit']}>
          {data.medianDays === null ? 'No data' : 'days (median)'}
        </span>
        <span className={styles.caption}>
          {data.medianDays === null
            ? 'Link completed work items to a release to see a median.'
            : 'Completed work-item cycle time across releases'}
        </span>
        <span className={styles['nav-hint']}>View Releases ›</span>
      </div>
    </>
  );

  if (isStale) {
    return (
      <article
        className={styles.card}
        aria-label={accessibleLabel}
        {...{ 'data-testid': 'home-dashboard-devprod-card' }}
      >
      <a
        className={styles['stale-card-link']}
        href="/planning/releases"
        {...{ 'data-testid': 'home-dashboard-devprod-link' }}
      >
          {cardContent}
        </a>
        <div className={styles.stale} role="status">
          <span>Last known data · refresh unavailable</span>
          <button
            type="button"
            className={styles.retry}
            onClick={onRetry}
            {...{ 'data-testid': 'home-dashboard-devprod-retry' }}
          >
            Retry
          </button>
        </div>
      </article>
    );
  }

  return (
    <a
      className={`${styles.card} ${styles['card-link']}`}
      href="/planning/releases"
      aria-label={accessibleLabel}
      {...{ 'data-testid': 'home-dashboard-devprod-card' }}
    >
      {cardContent}
    </a>
  );
};

export default DevToProductionTile;
