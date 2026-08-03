import React from 'react';
import type { RunStatus } from '../../shared/types/loadTest';
import styles from './LoadTestLastRunBadge.module.css';

interface LoadTestLastRunBadgeProps {
  status?: RunStatus | string | null;
  overallResult?: string | null;
}

export const LoadTestLastRunBadge: React.FC<LoadTestLastRunBadgeProps> = ({
  status,
  overallResult,
}) => {
  if (!status) {
    return (
      <span className={styles.never} data-testid="load-test-last-run-badge">
        Never run
      </span>
    );
  }

  const label =
    overallResult === 'passed' || overallResult === 'failed'
      ? `${status} (${overallResult})`
      : String(status);

  return (
    <span
      className={`${styles.badge} ${styles[String(status)] ?? ''}`}
      data-testid="load-test-last-run-badge"
    >
      {label}
    </span>
  );
};

export default LoadTestLastRunBadge;
