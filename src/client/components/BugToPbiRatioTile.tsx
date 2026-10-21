import React from 'react';
import type {
  BugToPbiRatioData,
  HomeDashboardScope,
  TileResult,
} from '../../shared/types/homeDashboard';
import { HomeTileInfo } from './HomeTileInfo';
import styles from './HomeDashboardTiles.module.css';

interface BugToPbiRatioTileProps {
  result: TileResult<BugToPbiRatioData> | null;
  onRetry: () => void;
  scope?: HomeDashboardScope;
}

export const BugToPbiRatioTile: React.FC<BugToPbiRatioTileProps> = ({
  result,
  onRetry,
  scope = 'team',
}) => {
  if (!result) return null;

  const data = result.data ?? result.lastKnownData ?? null;
  const isStale = result.status === 'error' && Boolean(result.lastKnownData);
  const hasError = !data;

  if (hasError) {
    return (
      <article
        className={styles.card}
        aria-labelledby="home-dashboard-bug-ratio-title"
        {...{ 'data-testid': 'home-dashboard-bug-ratio-card' }}
      >
        <header className={styles.header}>
          <h3 id="home-dashboard-bug-ratio-title" className={styles.title}>Bug Ratio to PBI</h3>
        </header>
        <div className={styles.error} role="alert">
          <span className={styles['error-mark']} aria-hidden="true">!</span>
          <span>{result.message ?? 'Could not load bug and PBI counts from Azure DevOps.'}</span>
          <button
            type="button"
            className={styles.retry}
            onClick={onRetry}
            {...{ 'data-testid': 'home-dashboard-bug-ratio-retry' }}
          >
            Retry
          </button>
        </div>
      </article>
    );
  }

  const accessibleLabel = data.ratio === null
    ? 'Bug ratio to PBI: unavailable; no PBIs created in the last 90 days'
    : `Bug ratio to PBI: ${data.ratio} bugs per PBI from ${data.bugCount} bugs and ${data.pbiCount} PBIs in the last 90 days`;

  const cardContent = (
    <>
      <header className={styles.header}>
        <div className={styles['title-group']}>
          <h3 className={styles.title}>Bug Ratio to PBI</h3>
          <HomeTileInfo title="Bug Ratio to PBI" data-testid="home-dashboard-bug-ratio-info">
            <p>
              Child <strong>bugs created in the last 90 days</strong> divided by
              <strong> PBIs created in the same window</strong>. Closed bugs still
              count — this is created defects, not open bugs.
            </p>
            <p>
              <strong>Mine</strong> limits both sides to PBIs you have owned at any
              point. <strong>Team</strong> is the whole project.
            </p>
            <p>
              A PBI with no bugs still sits in the denominator. A bug on an older PBI
              still sits in the numerator.
            </p>
          </HomeTileInfo>
        </div>
        <span className={styles.scope}>{scope === 'mine' ? 'Mine' : 'Team'} · Last 90 days</span>
      </header>
      <div className={styles.devprod}>
        <span className={`${styles['devprod-value']} ${data.ratio === null ? styles['kpi-empty'] : ''}`}>
          {data.ratio ?? '—'}
        </span>
        <span className={styles['devprod-unit']}>
          {data.ratio === null ? 'No data' : 'bugs / PBI'}
        </span>
        <span className={styles.caption}>
          {data.pbiCount === 0
            ? 'Create a PBI in the last 90 days to see a ratio.'
            : `${data.bugCount} bugs · ${data.pbiCount} PBIs`}
        </span>
      </div>
    </>
  );

  if (isStale) {
    return (
      <article
        className={styles.card}
        aria-label={accessibleLabel}
        {...{ 'data-testid': 'home-dashboard-bug-ratio-card' }}
      >
        {cardContent}
        <div className={styles.stale} role="status">
          <span>Last known data · refresh unavailable</span>
          <button
            type="button"
            className={styles.retry}
            onClick={onRetry}
            {...{ 'data-testid': 'home-dashboard-bug-ratio-retry' }}
          >
            Retry
          </button>
        </div>
      </article>
    );
  }

  return (
    <article
      className={styles.card}
      aria-label={accessibleLabel}
      {...{ 'data-testid': 'home-dashboard-bug-ratio-card' }}
    >
      {cardContent}
    </article>
  );
};

export default BugToPbiRatioTile;
