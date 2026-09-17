import React, { useEffect, useState } from 'react';
import type { InterviewSummary, PrdStatus } from '../../shared/types/interview';
import { useRetryPrdFromPhase } from '../hooks/useInterviews';
import {
  derivePrdTriggerDisplayState,
  finalPhaseApprovedAt,
  PRD_TRIGGER_FAILURE_MS,
} from '../utils/prdTriggerDisplayState';
import styles from './PrdTriggerStatus.module.css';

interface PrdTriggerStatusProps {
  interview: InterviewSummary;
  existingPrdStatus?: PrdStatus;
  canManage: boolean;
  onOpenPrd: () => void;
  'data-testid'?: string;
}

const LABELS = {
  pending: 'PRD pending final phase approval',
  generating: 'PRD generating',
  ready: 'PRD ready',
  failed: 'PRD generation failed',
} as const;

export const PrdTriggerStatus: React.FC<PrdTriggerStatusProps> = ({
  interview,
  existingPrdStatus,
  canManage,
  onOpenPrd,
  'data-testid': testId = 'prd-trigger-status',
}) => {
  const [now, setNow] = useState(Date.now);
  const [retryStartedAt, setRetryStartedAt] = useState<number | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const retry = useRetryPrdFromPhase();

  const derived = derivePrdTriggerDisplayState(interview, now, existingPrdStatus);
  // A retry restarts the wait window client-side: `approvedAt` stays old, so without
  // this the status would snap straight back to failed.
  const retryInFlight =
    retryStartedAt !== null && now - retryStartedAt < PRD_TRIGGER_FAILURE_MS;
  const state = derived === 'failed' && retryInFlight ? 'generating' : derived;

  const approvedAt = finalPhaseApprovedAt(interview);
  const hasPrd = interview.prdCount > 0 || !!existingPrdStatus;

  useEffect(() => {
    if (hasPrd) return;
    const deadlines = [
      approvedAt ? Date.parse(approvedAt) + PRD_TRIGGER_FAILURE_MS : null,
      retryStartedAt !== null ? retryStartedAt + PRD_TRIGGER_FAILURE_MS : null,
    ].filter((deadline): deadline is number => deadline !== null && deadline > Date.now());
    if (deadlines.length === 0) return;

    const timeouts = deadlines.map((deadline) =>
      window.setTimeout(() => setNow(Date.now()), deadline - Date.now()),
    );
    return () => timeouts.forEach((timeout) => window.clearTimeout(timeout));
  }, [approvedAt, hasPrd, retryStartedAt]);

  if (!state) return null;

  return (
    <div
      className={`${styles.status} ${styles[state]}`}
      role="status"
      aria-live="polite"
      {...{ 'data-testid': testId }}
    >
      <span>{LABELS[state]}</span>
      {state === 'generating' && <span className={styles.spinner} aria-hidden="true" />}
      {state === 'failed' && retryError && (
        <span className={styles.error} {...{ 'data-testid': `retry-prd-error-${interview.id}` }}>
          {retryError}
        </span>
      )}
      {state === 'failed' && canManage && (
        <button
          type="button"
          className={styles.action}
          aria-label="Retry automatic PRD generation"
          disabled={retry.isPending}
          onClick={(event) => {
            event.stopPropagation();
            const retryAt = Date.now();
            setRetryError(null);
            setNow(retryAt);
            setRetryStartedAt(retryAt);
            retry.mutate(interview.id, {
              onError: (error: Error) => {
                setRetryStartedAt(null);
                setRetryError(error.message || 'Retry failed. Try again.');
              },
            });
          }}
          {...{ 'data-testid': `retry-prd-from-phase-${interview.id}` }}
        >
          {retry.isPending ? 'Retrying…' : 'Retry'}
        </button>
      )}
      {state === 'ready' && (
        <button
          type="button"
          className={styles.action}
          aria-label="Open generated PRD"
          onClick={(event) => {
            event.stopPropagation();
            onOpenPrd();
          }}
          {...{ 'data-testid': `open-prd-from-phase-${interview.id}` }}
        >
          View PRD
        </button>
      )}
    </div>
  );
};
