import React from 'react';
import type { HomeDashboardPayload } from '../../shared/types/homeDashboard';
import { ArtifactCycleTimeTile } from './ArtifactCycleTimeTile';
import { DevToProductionTile } from './DevToProductionTile';
import { IncompletePipelineTile } from './IncompletePipelineTile';
import { MyWorkTile } from './MyWorkTile';
import { OpenBugsOnPbisTile } from './OpenBugsOnPbisTile';
import styles from './HomeDashboardSection.module.css';

const SKELETON_CARDS = [
  { testId: 'home-dashboard-pipeline-card', label: 'Incomplete Pipeline loading' },
  { testId: 'home-dashboard-cycle-time-card', label: 'Artifact Cycle Time loading' },
  { testId: 'home-dashboard-my-work-card', label: 'My Work loading' },
  { testId: 'home-dashboard-bugs-card', label: 'Open Bugs on PBIs loading' },
  { testId: 'home-dashboard-devprod-card', label: 'Dev to Production loading' },
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
    <h2 id="home-dashboard-heading" className={styles.heading}>Project Status</h2>
    <div className={styles['primary-row']}>
      {SKELETON_CARDS.slice(0, 2).map((card) => (
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
    <div className={styles['secondary-row']}>
      {SKELETON_CARDS.slice(2).map((card) => (
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
      <h2 id="home-dashboard-heading" className={styles.heading}>Project Status</h2>
      <div className={styles['primary-row']}>
        <IncompletePipelineTile result={payload.incompletePipeline} onRetry={onRetry} />
        <ArtifactCycleTimeTile result={payload.artifactCycleTime} onRetry={onRetry} />
      </div>
      <div className={styles['secondary-row']}>
        <MyWorkTile result={payload.myWork} onRetry={onRetry} />
        <OpenBugsOnPbisTile result={payload.openBugsOnPbis} onRetry={onRetry} />
        <DevToProductionTile result={payload.devToProduction} onRetry={onRetry} />
      </div>
    </section>
  );
};

export default HomeDashboardSection;
