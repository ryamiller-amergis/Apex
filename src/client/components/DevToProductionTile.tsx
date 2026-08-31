import React from 'react';
import type { DevToProductionData, TileResult } from '../../shared/types/homeDashboard';
import styles from './HomeDashboardTiles.module.css';

interface DevToProductionTileProps {
  result: TileResult<DevToProductionData> | null;
  onRetry: () => void;
}

export const DevToProductionTile: React.FC<DevToProductionTileProps> = ({ result, onRetry }) => {
  if (!result) return null;

  const hasError = result.status === 'error' || !result.data;

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

  const data = result.data;
  if (!data) return null;

  const accessibleLabel = data.medianDays === null
    ? 'Developer to production: unavailable; no completed items in the last 90 days. View Releases'
    : `Developer to production: ${data.medianDays} days median in the last 90 days. View Releases`;

  return (
    <a
      className={`${styles.card} ${styles['card-link']}`}
      href="/planning/releases"
      aria-label={accessibleLabel}
      {...{ 'data-testid': 'home-dashboard-devprod-card' }}
    >
      <header className={styles.header}>
        <h3 className={styles.title}>Dev → Production</h3>
        <span className={styles.scope}>Last 90 days</span>
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
            ? 'No completed items in the last 90 days'
            : 'Developer start → production deployment'}
        </span>
        <span className={styles['nav-hint']}>View Releases ›</span>
      </div>
    </a>
  );
};

export default DevToProductionTile;
