import React from 'react';
import type {
  HomeDashboardScope,
  MyWorkData,
  TileResult,
} from '../../shared/types/homeDashboard';
import { HomeTileInfo } from './HomeTileInfo';
import styles from './HomeDashboardTiles.module.css';

interface MyWorkTileProps {
  result: TileResult<MyWorkData> | null;
  onRetry: () => void;
  scope?: HomeDashboardScope;
}

export const MyWorkTile: React.FC<MyWorkTileProps> = ({
  result,
  onRetry,
  scope = 'mine',
}) => {
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

  const isEmpty = result.status === 'empty';
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
        <div className={styles['title-group']}>
          <h3 className={styles.title}>My Work</h3>
          <HomeTileInfo title="My Work" data-testid="home-dashboard-my-work-info">
            <p>
              Work items in Ready or In Progress, plus the design docs feeding them,
              over the last 90 days.
            </p>
            <p>
              <strong>Mine</strong> shows items assigned to you in Azure DevOps and
              design docs you own. <strong>Team</strong> shows the whole project.
            </p>
            <p>
              An item appears once it is assigned and moved to Ready or In Progress.
            </p>
          </HomeTileInfo>
        </div>
        <span className={styles.scope}>
          {scope === 'mine' ? 'Mine' : 'Team'} · 90-day
        </span>
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
      {isEmpty && (
        <p className={styles['empty-hint']}>
          {scope === 'mine'
            ? 'For Apex work, you must be the Design Doc owner. For ADO work, the item must be assigned to you.'
            : 'Team work appears when an approved feature is ready or development starts.'}
        </p>
      )}
    </a>
  );
};

export default MyWorkTile;
