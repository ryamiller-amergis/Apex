import React from 'react';
import type {
  WorkflowEvaluationJobEvaluator,
  WorkflowEvaluationJobStatus,
  WorkflowEvaluationOutcome,
} from '../../shared/types/workflowEvaluation';
import styles from './WorkflowEvaluationBadges.module.css';

export const JOB_STATUS_LABELS: Record<WorkflowEvaluationJobStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  ready: 'Ready',
  failed: 'Failed',
};

export const EVALUATOR_LABELS: Record<WorkflowEvaluationJobEvaluator, string> = {
  promptfoo: 'Promptfoo',
  llm_judge: 'Judge',
};

function outcomeTone(outcome: WorkflowEvaluationOutcome): string {
  switch (outcome) {
    case 'accept_unchanged':
      return styles.toneSuccess;
    case 'accept_after_edits':
      return styles.toneInfo;
    case 'regenerate':
      return styles.toneWarning;
    case 'reject':
      return styles.toneError;
    default: {
      const unhandled: never = outcome;
      throw new Error(`Unhandled outcome: ${String(unhandled)}`);
    }
  }
}

function statusTone(status: WorkflowEvaluationJobStatus): string {
  switch (status) {
    case 'ready':
      return styles.toneSuccess;
    case 'failed':
      return styles.toneError;
    case 'running':
      return styles.toneInfo;
    case 'pending':
      return styles.toneNeutral;
    default: {
      const unhandled: never = status;
      throw new Error(`Unhandled job status: ${String(unhandled)}`);
    }
  }
}

export interface OutcomeBadgeProps {
  outcome: WorkflowEvaluationOutcome;
  label: string;
  'data-testid'?: string;
}

export const OutcomeBadge: React.FC<OutcomeBadgeProps> = ({ outcome, label, 'data-testid': testId }) => (
  <span className={`${styles.badge} ${outcomeTone(outcome)}`} {...(testId ? { 'data-testid': testId } : {})}>
    {label}
  </span>
);

export interface JobStatusBadgeProps {
  status: WorkflowEvaluationJobStatus;
  /** Prefix such as "Promptfoo" for compact table cells. */
  prefix?: string;
  'data-testid'?: string;
}

export const JobStatusBadge: React.FC<JobStatusBadgeProps> = ({ status, prefix, 'data-testid': testId }) => (
  <span className={`${styles.badge} ${statusTone(status)}`} {...(testId ? { 'data-testid': testId } : {})}>
    {prefix ? `${prefix}: ` : ''}{JOB_STATUS_LABELS[status]}
  </span>
);

export const PromptfooFailedBadge: React.FC<{ 'data-testid'?: string }> = ({
  'data-testid': testId = 'workflow-evaluation-promptfoo-failed-badge',
}) => (
  <span className={`${styles.badge} ${styles.toneError}`} {...{ 'data-testid': testId }}>
    Promptfoo failed
  </span>
);
