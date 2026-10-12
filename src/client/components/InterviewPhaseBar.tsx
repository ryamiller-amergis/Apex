import React from 'react';
import type { InterviewPhaseProgress, InterviewPhaseState } from '../utils/interviewPhaseProgress';
import styles from './InterviewPhaseBar.module.css';

interface InterviewPhaseBarProps {
  progress: InterviewPhaseProgress;
  layout?: 'banner' | 'compose';
}

const STATE_CLASS: Record<InterviewPhaseState, string> = {
  current: styles.stepCurrent,
  complete: styles.stepComplete,
  upcoming: styles.stepUpcoming,
  optional: styles.stepOptional,
  skipped: styles.stepSkipped,
};

export const InterviewPhaseBar: React.FC<InterviewPhaseBarProps> = ({ progress, layout = 'banner' }) => {
  return (
    <nav
      className={`${styles.bar} ${layout === 'compose' ? styles.compose : ''}`}
      aria-label="Interview phases"
      {...{ 'data-testid': 'interview-phase-bar' }}
    >
      <ol className={styles.steps}>
        {progress.steps.map((phase) => (
          <li
            key={phase.id}
            className={`${styles.step} ${STATE_CLASS[phase.state]}`}
            aria-current={phase.state === 'current' ? 'step' : undefined}
            {...{ 'data-testid': `interview-phase-${phase.id}` }}
          >
            <span className={styles.track} aria-hidden="true" />
            <span className={styles.label}>{phase.label}</span>
            <span className={styles.detail}>{phase.detail}</span>
          </li>
        ))}
      </ol>
      <p className={styles.summary}>{progress.summary}</p>
    </nav>
  );
};
