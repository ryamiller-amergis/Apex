import React from 'react';
import type { RunStatus } from '../../shared/types/loadTest';
import styles from './LoadTestRunStatusBadge.module.css';

interface LoadTestRunStatusBadgeProps {
  status: RunStatus | string | null | undefined;
  overallResult?: 'passed' | 'failed' | null;
}

const LABELS: Record<string, string> = {
  queued: 'Queued',
  dispatched: 'Dispatched',
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  errored: 'Errored',
  cancelled: 'Cancelled',
};

/** In-progress lifecycle states — never styled as hard failures (PBI-011 AC-2). */
const IN_PROGRESS = new Set(['queued', 'dispatched', 'running']);

export const LoadTestRunStatusBadge: React.FC<LoadTestRunStatusBadgeProps> = ({
  status,
  overallResult,
}) => {
  if (!status) {
    return (
      <span className={styles.unknown} data-testid="load-test-run-status">
        Unknown
      </span>
    );
  }

  const key = String(status);
  const label = LABELS[key] ?? key;
  const tone = IN_PROGRESS.has(key)
    ? 'inProgress'
    : key === 'passed' || overallResult === 'passed'
      ? 'passed'
      : key === 'failed' || key === 'errored' || overallResult === 'failed'
        ? 'failed'
        : 'neutral';

  return (
    <span
      className={`${styles.badge} ${styles[tone]}`}
      data-testid="load-test-run-status"
      data-status={key}
      data-tone={tone}
    >
      {label}
      {overallResult && (key === 'passed' || key === 'failed')
        ? ` · ${overallResult}`
        : null}
    </span>
  );
};

export default LoadTestRunStatusBadge;
