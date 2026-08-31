import React from 'react';
import type { ArtifactCycleTimeData, CycleTimeKpi, TileResult } from '../../shared/types/homeDashboard';
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
  if (kpi.unavailable) return `${label} median cycle time: Unavailable`;
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

  const hasError = result.status === 'error' || !result.data;

  return (
    <article
      className={styles.card}
      aria-labelledby="home-dashboard-cycle-time-title"
      {...{ 'data-testid': 'home-dashboard-cycle-time-card' }}
    >
      <header className={styles.header}>
        <h3 id="home-dashboard-cycle-time-title" className={styles.title}>Artifact Cycle Time</h3>
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
        <dl className={styles['kpi-grid']}>
          {KPI_DEFINITIONS.map(({ key, label }) => {
            const kpi = result.data?.[key];
            if (!kpi) return null;

            return (
              <div
                key={key}
                className={styles.kpi}
                aria-label={getKpiLabel(label, kpi)}
                {...{ 'data-testid': `home-dashboard-cycle-time-kpi-${key}` }}
              >
                <dt className={styles['kpi-label']}>{label}</dt>
                {kpi.unavailable ? (
                  <dd className={styles['kpi-error']}>Unavailable</dd>
                ) : (
                  <>
                    <dd className={`${styles['kpi-value']} ${kpi.medianDays === null ? styles['kpi-empty'] : ''}`}>
                      {kpi.medianDays ?? '—'}
                    </dd>
                    <dd className={styles.caption}>
                      {kpi.medianDays === null ? 'No completed items in the last 90 days' : 'median days'}
                    </dd>
                  </>
                )}
              </div>
            );
          })}
        </dl>
      )}
    </article>
  );
};

export default ArtifactCycleTimeTile;
