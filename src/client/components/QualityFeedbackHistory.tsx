import React, { useState } from 'react';
import {
  WORKFLOW_EVALUATION_OUTCOME_LABELS,
  WORKFLOW_EVALUATION_REASON_CODE_LABELS,
  type WorkflowEvaluationEvent,
  type WorkflowEvaluationSubjectType,
} from '../../shared/types/workflowEvaluation';
import { useWorkflowEvaluationEvents } from '../hooks/useWorkflowEvaluations';
import styles from './QualityFeedbackHistory.module.css';

export interface QualityFeedbackHistoryProps {
  project: string | undefined;
  subjectType: WorkflowEvaluationSubjectType;
  subjectId: string;
  stageKey: string;
  canView: boolean;
  /** Changes when the subject is edited, so the list refetches the live hash. */
  subjectVersion?: string;
  emptyMessage: string;
  testIdPrefix?: string;
}

const OUTCOME_LABELS = new Map<string, string>(WORKFLOW_EVALUATION_OUTCOME_LABELS.map((o) => [o.key, o.label]));
const REASON_LABELS = new Map<string, string>(WORKFLOW_EVALUATION_REASON_CODE_LABELS.map((r) => [r.key, r.label]));

function average(event: WorkflowEvaluationEvent): string {
  const scores = Object.values(event.criteria);
  const mean = scores.reduce((total, score) => total + score, 0) / Math.max(scores.length, 1);
  return mean.toFixed(1);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export const QualityFeedbackHistory: React.FC<QualityFeedbackHistoryProps> = ({
  project,
  subjectType,
  subjectId,
  stageKey,
  canView,
  subjectVersion,
  emptyMessage,
  testIdPrefix: p = 'quality-feedback',
}) => {
  const [showOlder, setShowOlder] = useState(false);
  const eventsQuery = useWorkflowEvaluationEvents({
    project,
    subjectType,
    subjectId,
    stageKey,
    includeOlderVersions: showOlder,
    subjectVersion,
    enabled: canView,
  });

  if (!canView) return null;

  const events = (eventsQuery.data?.events ?? []).filter((event) => event.stageKey === stageKey);
  const currentHash = eventsQuery.data?.currentArtifactHash ?? null;
  const latestId = events.find((event) => event.artifactContentHash === currentHash)?.id;

  return (
    <section className={styles.history} aria-labelledby={`${p}-history-title`} {...{ 'data-testid': `${p}-history` }}>
      <div className={styles.header}>
        <h3 id={`${p}-history-title`} className={styles.title}>Earlier feedback</h3>
        <button
          type="button"
          className={styles.linkButton}
          aria-pressed={showOlder}
          onClick={() => setShowOlder((value) => !value)}
          {...{ 'data-testid': `${p}-history-toggle-older` }}
        >
          {showOlder ? 'Show this version only' : 'Show older versions'}
        </button>
      </div>

      {eventsQuery.isLoading && (
        <div className={styles.skeleton} aria-busy="true" {...{ 'data-testid': `${p}-history-loading` }}>
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
        </div>
      )}

      {eventsQuery.isError && (
        <div className={styles.inlineError} role="alert" {...{ 'data-testid': `${p}-history-error` }}>
          <span>Couldn&apos;t load earlier feedback.</span>
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => void eventsQuery.refetch()}
            {...{ 'data-testid': `${p}-history-retry` }}
          >
            Retry
          </button>
        </div>
      )}

      {eventsQuery.isSuccess && events.length === 0 && (
        <p className={styles.empty} {...{ 'data-testid': `${p}-history-empty` }}>{emptyMessage}</p>
      )}

      {events.length > 0 && (
        <ul className={styles.list}>
          {events.map((event) => {
            const earlier = currentHash !== null && event.artifactContentHash !== currentHash;
            return (
              <li key={event.id} className={styles.row} {...{ 'data-testid': `${p}-history-row-${event.id}` }}>
                <div className={styles.rowHeader}>
                  <span className={styles.outcome}>{OUTCOME_LABELS.get(event.outcome) ?? event.outcome}</span>
                  <span className={styles.score}>{average(event)} / 5</span>
                  {event.id === latestId && (
                    <span className={styles.latest} {...{ 'data-testid': `${p}-history-latest-badge` }}>Latest</span>
                  )}
                  {earlier && <span className={styles.earlier}>Earlier version</span>}
                </div>
                <p className={styles.meta}>
                  {event.reviewerName ?? 'Unknown reviewer'} · {event.reviewerRoleLabel} · {formatDate(event.createdAt)}
                </p>
                {event.reasonCodes.length > 0 && (
                  <p className={styles.reasons}>
                    {event.reasonCodes.map((code) => REASON_LABELS.get(code) ?? code).join(', ')}
                  </p>
                )}
                {event.comment && <p className={styles.comment}>{event.comment}</p>}
                {event.hasCorrectedArtifact && <p className={styles.meta}>Corrected version supplied</p>}
              </li>
            );
          })}
        </ul>
      )}
      {eventsQuery.data?.truncated && (
        <p className={styles.meta}>Showing the 50 most recent entries.</p>
      )}
    </section>
  );
};
