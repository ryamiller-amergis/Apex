import React from 'react';
import type { IncompletePipelineData, PipelineGroup, TileResult } from '../../shared/types/homeDashboard';
import styles from './HomeDashboardTiles.module.css';

const MAX_ROWS = 20;

const EMPTY_COPY: Record<PipelineGroup['key'], string> = {
  interview: 'No incomplete interviews in this project.',
  prd: 'No incomplete PRDs in this project.',
  testCase: 'No incomplete test cases.',
  prototype: 'No incomplete prototypes.',
  designDoc: 'No incomplete design docs.',
};

interface IncompletePipelineTileProps {
  result: TileResult<IncompletePipelineData> | null;
  onRetry: () => void;
}

export const IncompletePipelineTile: React.FC<IncompletePipelineTileProps> = ({ result, onRetry }) => {
  if (!result) return null;

  const hasError = result.status === 'error' || !result.data;

  return (
    <article
      className={styles.card}
      aria-labelledby="home-dashboard-pipeline-title"
      {...{ 'data-testid': 'home-dashboard-pipeline-card' }}
    >
      <header className={styles.header}>
        <h3 id="home-dashboard-pipeline-title" className={styles.title}>Incomplete Pipeline</h3>
        {!hasError ? <span className={styles.scope}>Updated recently</span> : null}
      </header>

      {hasError ? (
        <div className={styles.error} role="alert">
          <span className={styles['error-mark']} aria-hidden="true">!</span>
          <span>{result.message ?? 'Failed to load pipeline data.'}</span>
          <button
            type="button"
            className={styles.retry}
            onClick={onRetry}
            {...{ 'data-testid': 'home-dashboard-pipeline-retry' }}
          >
            Retry
          </button>
        </div>
      ) : (
        result.data?.groups.map((group) => (
          <section
            key={group.key}
            className={styles['pipeline-group']}
            aria-label={`${group.label}, ${group.count} incomplete`}
            {...{ 'data-testid': `home-dashboard-pipeline-group-${group.key}` }}
          >
            <div className={styles['group-header']}>
              <div className={styles['group-label']}>
                <span>{group.label}</span>
                <span className={styles.count} aria-hidden="true">{group.count}</span>
              </div>
              <a
                className={styles['view-all']}
                href={group.viewAllHref}
                aria-label={`View all ${group.label}`}
                {...{ 'data-testid': `home-dashboard-pipeline-view-all-${group.key}` }}
              >
                View all
              </a>
            </div>
            {group.rows.length === 0 ? (
              <p className={styles['empty-line']}>{EMPTY_COPY[group.key]}</p>
            ) : (
              <ul className={styles.list}>
                {group.rows.slice(0, MAX_ROWS).map((row) => (
                  <li key={row.id}>
                    <a
                      className={styles['row-link']}
                      href={row.route}
                      aria-label={row.name}
                      {...{ 'data-testid': `home-dashboard-pipeline-row-${group.key}-${row.id}` }}
                    >
                      <span className={styles.dot} aria-hidden="true" />
                      <span className={styles['row-name']}>{row.name}</span>
                      <span className={styles['row-meta']}>{row.ageDays}d ago</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))
      )}
    </article>
  );
};

export default IncompletePipelineTile;
