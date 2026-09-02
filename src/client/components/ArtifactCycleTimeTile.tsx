import React from 'react';
import type { ArtifactCycleTimeData, CycleTimeKpi, TileResult } from '../../shared/types/homeDashboard';
import { HomeTileInfo } from './HomeTileInfo';
import styles from './HomeDashboardTiles.module.css';

interface KpiDefinition {
  key: keyof ArtifactCycleTimeData;
  label: string;
}

const KPI_DEFINITIONS: KpiDefinition[] = [
  { key: 'interview', label: 'Interview' },
  { key: 'prd', label: 'PRD' },
  { key: 'testCase', label: 'Test Case' },
  { key: 'prototype', label: 'Prototype' },
  { key: 'designDoc', label: 'Design Doc' },
];

const getKpiLabel = (label: string, kpi: CycleTimeKpi): string => {
  if (kpi.unavailable) return `${label} median cycle time: failed to load`;
  if (kpi.medianDays === null) {
    return `${label} median cycle time: unavailable; no completed items in the last 90 days`;
  }
  return `${label} median cycle time: ${kpi.medianDays} days in the last 90 days`;
};

interface ArtifactCycleTimeTileProps {
  result: TileResult<ArtifactCycleTimeData> | null;
  onRetry: () => void;
}

export const ArtifactCycleTimeTile: React.FC<ArtifactCycleTimeTileProps> = ({ result, onRetry }) => {
  if (!result) return null;

  const kpis = KPI_DEFINITIONS
    .map(({ key, label }) => ({ key, label, kpi: result.data?.[key] }))
    .filter((entry): entry is { key: keyof ArtifactCycleTimeData; label: string; kpi: CycleTimeKpi } =>
      Boolean(entry.kpi));

  const failedCount = kpis.filter(({ kpi }) => kpi.unavailable).length;
  // Every source failed, so there is no median left to show. One explained error
  // with a Retry reads better than repeating the same dead value in each slot.
  const allFailed = kpis.length > 0 && failedCount === kpis.length;

  const hasError = result.status === 'error' || !result.data || allFailed;

  return (
    <article
      className={styles.card}
      aria-labelledby="home-dashboard-cycle-time-title"
      {...{ 'data-testid': 'home-dashboard-cycle-time-card' }}
    >
      <header className={styles.header}>
        <div className={styles['title-group']}>
          <h3 id="home-dashboard-cycle-time-title" className={styles.title}>Artifact Cycle Time</h3>
          <HomeTileInfo title="Artifact Cycle Time" data-testid="home-dashboard-cycle-time-info">
            <p>
              Per artifact type, the <strong>median days from creation to done</strong>,
              counting only items that finished in the last 90 days.
            </p>
            <p>
              Done is recorded once, when the artifact is approved (or an Interview is
              marked complete), so a later edit or re-approval cannot move a past number.
            </p>
            <p>
              A dash means nothing of that type finished inside the window — not that
              anything failed.
            </p>
          </HomeTileInfo>
        </div>
        <span className={styles.scope}>Last 90 days</span>
      </header>

      {hasError ? (
        <div className={styles.error} role="alert">
          <span className={styles['error-mark']} aria-hidden="true">!</span>
          <span>{result.message ?? 'Failed to load artifact cycle times.'}</span>
          <button
            type="button"
            className={styles.retry}
            onClick={onRetry}
            {...{ 'data-testid': 'home-dashboard-cycle-time-retry' }}
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          <dl className={styles['kpi-grid']}>
            {kpis.map(({ key, label, kpi }) => (
              <div
                key={key}
                className={styles.kpi}
                aria-label={getKpiLabel(label, kpi)}
                {...{ 'data-testid': `home-dashboard-cycle-time-kpi-${key}` }}
              >
                <dt className={styles['kpi-label']}>{label}</dt>
                <dd className={`${styles['kpi-value']} ${kpi.medianDays === null ? styles['kpi-empty'] : ''}`}>
                  {kpi.medianDays ?? '—'}
                </dd>
                {kpi.unavailable ? (
                  <dd className={styles['kpi-error']}>Failed to load</dd>
                ) : (
                  <dd className={styles.caption}>
                    {kpi.medianDays === null ? 'No completed items in the last 90 days' : 'median days'}
                  </dd>
                )}
              </div>
            ))}
          </dl>

          {failedCount > 0 && (
            <div
              className={styles['partial-error']}
              role="alert"
              {...{ 'data-testid': 'home-dashboard-cycle-time-partial-error' }}
            >
              <span>Some cycle times failed to load.</span>
              <button
                type="button"
                className={styles['retry-inline']}
                onClick={onRetry}
                {...{ 'data-testid': 'home-dashboard-cycle-time-partial-retry' }}
              >
                Retry
              </button>
            </div>
          )}
        </>
      )}
    </article>
  );
};

export default ArtifactCycleTimeTile;
