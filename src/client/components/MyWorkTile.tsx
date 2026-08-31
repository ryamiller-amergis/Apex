import React from 'react';
import type { MyWorkData, TileResult } from '../../shared/types/homeDashboard';
import styles from './HomeDashboardTiles.module.css';

interface MyWorkTileProps {
  result: TileResult<MyWorkData> | null;
  onRetry: () => void;
}

export const MyWorkTile: React.FC<MyWorkTileProps> = ({ result, onRetry }) => {
  if (!result) return null;

  const hasError = result.status === 'error' || !result.data;

  if (hasError) {
    return (
      <article
        className={styles.card}
        aria-labelledby="home-dashboard-my-work-title"
        {...{ 'data-testid': 'home-dashboard-my-work-card' }}
      >
        <header className={styles.header}>
          <h3 id="home-dashboard-my-work-title" className={styles.title}>My Work</h3>
        </header>
        <div className={styles.error} role="alert">
          <span className={styles['error-mark']} aria-hidden="true">!</span>
          <span>{result.message ?? 'Could not load your work items.'}</span>
          <button
            type="button"
            className={styles.retry}
            onClick={onRetry}
            {...{ 'data-testid': 'home-dashboard-my-work-retry' }}
          >
            Retry
          </button>
        </div>
      </article>
    );
  }

  const data = result.data;
  if (!data) return null;

  const cycleLabel = data.cycleTime.medianDays === null
    ? 'Median cycle time: unavailable; no completed items in the last 90 days'
    : `Median cycle time: ${data.cycleTime.medianDays} days in the last 90 days`;

  return (
    <a
      className={`${styles.card} ${styles['card-link']}`}
      href="/my-work"
      aria-label={`My Work status: ${data.ready} Ready, ${data.inProgress} In Progress`}
      {...{ 'data-testid': 'home-dashboard-my-work-card' }}
    >
      <header className={styles.header}>
        <h3 className={styles.title}>My Work</h3>
        <span className={styles.scope}>90-day</span>
      </header>
      <div className={styles['my-work']}>
        <div className={styles['count-grid']}>
          <div className={styles['count-block']} aria-label={`${data.ready} Ready items`}>
            <span className={styles['count-value']}>{data.ready}</span>
            <span className={styles['count-label']}>Ready</span>
          </div>
          <div className={styles['count-block']} aria-label={`${data.inProgress} In Progress items`}>
            <span className={styles['count-value']}>{data.inProgress}</span>
            <span className={styles['count-label']}>In Progress</span>
          </div>
        </div>
        <div className={styles['cycle-block']} aria-label={cycleLabel}>
          <span className={`${styles['cycle-value']} ${data.cycleTime.medianDays === null ? styles['kpi-empty'] : ''}`}>
            {data.cycleTime.medianDays ?? '—'}
          </span>
          <span className={styles['cycle-label']}>days median</span>
          <span className={styles.caption}>
            {data.cycleTime.medianDays === null
              ? 'No completed items in the last 90 days'
              : 'Cycle time · 90-day'}
          </span>
        </div>
      </div>
    </a>
  );
};

export default MyWorkTile;
