import React from 'react';
import type { RunCheckKind } from '../../shared/types/agentRunLifecycle';
import styles from './CurrentRunChecksSummary.module.css';

/** Exact copy PBI-006 AC-2 requires for a run that finished without a PR. */
const NO_PR_MESSAGE = 'Run finished, no PR yet';

const FAILING_CHECK_LABELS: Record<RunCheckKind, string> = {
  unit: 'Unit checks failed',
  e2e: 'E2E checks failed',
  wcag: 'WCAG checks failed',
};

interface CurrentRunChecksSummaryProps {
  prUrl: string | null;
  finishedWithoutPr: boolean;
  /** Derived server-side (TBI-005); never re-derived here. */
  failingChecks: RunCheckKind[];
}

/**
 * Suite-level check outcome for the current Cloud Agent run, shown beside the PR link.
 *
 * Failures never claim a terminal state of their own (TBI-005 DoD-1) and a run
 * without a PR states only that fact — it never claims checks passed (DoD-2).
 */
export const CurrentRunChecksSummary: React.FC<CurrentRunChecksSummaryProps> = ({
  prUrl,
  finishedWithoutPr,
  failingChecks,
}) => {
  if (finishedWithoutPr) {
    return (
      <section
        className={styles.summary}
        aria-label="Run outcome"
        {...{ 'data-testid': 'current-run-checks-summary' }}
      >
        <span
          className={styles['no-pr']}
          {...{ 'data-testid': 'current-run-checks-no-pr' }}
        >
          {NO_PR_MESSAGE}
        </span>
      </section>
    );
  }

  if (!prUrl || failingChecks.length === 0) return null;

  return (
    <section
      className={styles.summary}
      aria-label="Failed run checks"
      {...{ 'data-testid': 'current-run-checks-summary' }}
    >
      <ul
        className={styles.failing}
        aria-label="Failed run checks"
        {...{ 'data-testid': 'current-run-checks-failing' }}
      >
        {failingChecks.map((kind, index) => (
          <li key={`${kind}-${index}`} className={styles['failing-item']}>
            {FAILING_CHECK_LABELS[kind] ?? `${kind} checks failed`}
          </li>
        ))}
      </ul>
    </section>
  );
};
