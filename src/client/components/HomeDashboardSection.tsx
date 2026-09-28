import React from 'react';
import type { HomeDashboardPayload } from '../../shared/types/homeDashboard';
import { ArtifactCycleTimeTile } from './ArtifactCycleTimeTile';
import { IncompletePipelineTile } from './IncompletePipelineTile';
import styles from './HomeDashboardSection.module.css';

const SKELETON_CARDS = [
  { testId: 'home-dashboard-pipeline-card', label: 'Incomplete Pipeline loading' },
  { testId: 'home-dashboard-cycle-time-card', label: 'Artifact Cycle Time loading' },
] as const;

interface HomeDashboardSectionProps {
  payload?: HomeDashboardPayload;
  isLoading?: boolean;
  onRetry: () => void;
}

const DashboardSkeleton: React.FC = () => (
  <section
    className={styles.section}
    aria-labelledby="home-dashboard-heading"
    aria-busy="true"
    {...{ 'data-testid': 'home-dashboard-root' }}
  >
    <h2
      id="home-dashboard-heading"
      className={`${styles.heading} ${styles['skeleton-heading']}`}
    >
      Project Status
    </h2>
    <div className={styles['primary-row']}>
      {SKELETON_CARDS.map((card) => (
        <article
          key={card.testId}
          className={styles['skeleton-card']}
          aria-label={card.label}
          {...{ 'data-testid': card.testId }}
        >
          <div className={`${styles['skeleton-line']} ${styles['skeleton-line-wide']}`} />
          <div className={`${styles['skeleton-line']} ${styles['skeleton-line-medium']}`} />
          <div className={`${styles['skeleton-line']} ${styles['skeleton-line-short']}`} />
        </article>
      ))}
    </div>
  </section>
);

export const HomeDashboardSection: React.FC<HomeDashboardSectionProps> = ({
  payload,
  isLoading = false,
  onRetry,
}) => {
  if (isLoading || payload === undefined) {
    return <DashboardSkeleton />;
  }

  return (
    <section
      className={styles.section}
      aria-labelledby="home-dashboard-heading"
      {...{ 'data-testid': 'home-dashboard-root' }}
    >
      <div className={styles.toolbar}>
        <h2 id="home-dashboard-heading" className={styles.heading}>Project Status</h2>
      </div>
      <div className={styles['primary-row']}>
        <IncompletePipelineTile result={payload.incompletePipeline} onRetry={onRetry} />
        <ArtifactCycleTimeTile result={payload.artifactCycleTime} onRetry={onRetry} />
      </div>
    </section>
  );
};

export default HomeDashboardSection;
