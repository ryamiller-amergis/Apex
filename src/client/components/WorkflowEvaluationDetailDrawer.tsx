import React, { useId, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { WorkflowEvaluationJobEvaluator } from '../../shared/types/workflowEvaluation';
import type { AdminEvaluationEventDetail, AdminEvaluationJob } from '../../shared/types/workflowEvaluationAdmin';
import { useDialogFocus } from '../hooks/useDialogFocus';
import {
  useAdminJudgeAppendix,
  useAdminWorkflowEvaluationEvent,
  useRetryWorkflowEvaluationJob,
} from '../hooks/useWorkflowEvaluationsAdmin';
import { JobStatusBadge, OutcomeBadge, PromptfooFailedBadge } from './WorkflowEvaluationBadges';
import styles from './WorkflowEvaluationDetailDrawer.module.css';

export interface WorkflowEvaluationDetailDrawerProps {
  projectId: string;
  eventId: string;
  onClose: () => void;
  'data-testid'?: string;
}

const JOB_NAMES: Record<WorkflowEvaluationJobEvaluator, string> = {
  promptfoo: 'Promptfoo run',
  llm_judge: 'LLM judge run',
};

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export const WorkflowEvaluationDetailDrawer: React.FC<WorkflowEvaluationDetailDrawerProps> = ({
  projectId,
  eventId,
  onClose,
  'data-testid': testId = 'workflow-evaluation-drawer',
}) => {
  const drawerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const eventQuery = useAdminWorkflowEvaluationEvent(projectId, eventId);
  useDialogFocus(drawerRef, { open: true, onClose });
  const event = eventQuery.data;

  return (
    <>
      <div className={styles.backdrop} onMouseDown={onClose} aria-hidden="true" />
      <div
        ref={drawerRef}
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...{ 'data-testid': testId }}
      >
        <div className={styles.header}>
          <div className={styles.headerText}>
            <h3 id={titleId} className={styles.title}>{event ? event.stageLabel : 'Evaluation event'}</h3>
            {event && (
              <>
                <div className={styles.badges}>
                  <OutcomeBadge
                    outcome={event.outcome}
                    label={event.outcomeLabel}
                    data-testid="workflow-evaluation-drawer-outcome"
                  />
                  {event.promptfooFailed && (
                    <PromptfooFailedBadge data-testid="workflow-evaluation-promptfoo-failed-badge" />
                  )}
                </div>
                <p className={styles.meta}>
                  {formatDateTime(event.createdAt)} · {event.reviewerDisplayName} ({event.reviewerRoleLabel})
                </p>
              </>
            )}
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close event details"
            {...{ 'data-testid': 'workflow-evaluation-drawer-close' }}
          >
            ×
          </button>
        </div>

        <div className={styles.body}>
          {eventQuery.isLoading && (
            <p className={styles.muted} aria-busy="true" {...{ 'data-testid': 'workflow-evaluation-drawer-loading' }}>
              Loading event…
            </p>
          )}
          {eventQuery.isError && (
            <div className={styles.inlineError} role="alert" {...{ 'data-testid': 'workflow-evaluation-drawer-error' }}>
              {eventQuery.error.status === 404 ? (
                <span>This event isn&apos;t available in this project.</span>
              ) : (
                <>
                  <span>Couldn&apos;t load this event.</span>
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => void eventQuery.refetch()}
                    {...{ 'data-testid': 'workflow-evaluation-drawer-retry' }}
                  >
                    Retry
                  </button>
                </>
              )}
            </div>
          )}
          {event && <EventDetailBody projectId={projectId} event={event} />}
        </div>
      </div>
    </>
  );
};

const EventDetailBody: React.FC<{ projectId: string; event: AdminEvaluationEventDetail }> = ({ projectId, event }) => {
  const judgeJob = event.jobs.find((job) => job.evaluatorKey === 'llm_judge');
  const judgeReady = judgeJob?.status === 'ready';
  const judge = <JudgeSection projectId={projectId} event={event} job={judgeJob} />;
  const human = <HumanFeedbackSection event={event} />;

  return (
    <>
      {judgeReady ? (
        <>
          {judge}
          {human}
        </>
      ) : (
        <>
          {human}
          {judge}
        </>
      )}
      <LineageSection event={event} />
      <DiagnosticsSection projectId={projectId} event={event} />
    </>
  );
};

const JudgeSection: React.FC<{
  projectId: string;
  event: AdminEvaluationEventDetail;
  job: AdminEvaluationJob | undefined;
}> = ({ projectId, event, job }) => {
  if (!job) {
    return (
      <section className={styles.section}>
        <h4 className={styles.sectionTitle}>Judge</h4>
        <p className={styles.muted}>No judge run recorded for this event.</p>
      </section>
    );
  }
  if (job.status !== 'ready') {
    const line = job.status === 'failed' ? 'Judge run failed — see Diagnostics below.' : `Judge run ${job.status}`;
    return (
      <section className={styles.section}>
        <h4 className={styles.sectionTitle}>Judge</h4>
        <p className={styles.muted}>{line}</p>
      </section>
    );
  }
  const output = event.judge.output;
  return (
    <section className={styles.section}>
      <h4 className={styles.sectionTitle}>Recommended improvements</h4>
      {output && output.recommendedImprovements.length > 0 ? (
        <ul className={styles.list} {...{ 'data-testid': 'workflow-evaluation-recommendations' }}>
          {output.recommendedImprovements.map((item, index) => (
            <li key={index}>
              {item.text}
              {item.criterion && <span className={styles.muted}> ({item.criterion})</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.muted} {...{ 'data-testid': 'workflow-evaluation-recommendations' }}>No recommendations returned</p>
      )}

      <h4 className={styles.sectionTitle}>Missed requirements</h4>
      <FindingList items={output?.missedRequirements ?? []} testId="workflow-evaluation-missed" />
      <h4 className={styles.sectionTitle}>Invented requirements</h4>
      <FindingList items={output?.inventedRequirements ?? []} testId="workflow-evaluation-invented" />

      <dl className={styles.facts}>
        {output?.alignmentScore !== undefined && (
          <>
            <dt>Alignment score</dt>
            <dd>{output.alignmentScore} / 5</dd>
          </>
        )}
        {output && (
          <>
            <dt>Confidence</dt>
            <dd>{output.confidence}</dd>
          </>
        )}
      </dl>

      <h4 className={styles.sectionTitle}>Judge narrative</h4>
      <JudgeAppendix projectId={projectId} eventId={event.id} enabled={event.judge.hasAppendix} />
    </section>
  );
};

const FindingList: React.FC<{ items: { description: string; evidence?: string }[]; testId: string }> = ({ items, testId }) =>
  items.length === 0 ? (
    <p className={styles.muted} {...{ 'data-testid': testId }}>None found</p>
  ) : (
    <ul className={styles.list} {...{ 'data-testid': testId }}>
      {items.map((item, index) => (
        <li key={index}>
          {item.description}
          {item.evidence && <blockquote className={styles.evidence}>{item.evidence}</blockquote>}
        </li>
      ))}
    </ul>
  );

const JudgeAppendix: React.FC<{ projectId: string; eventId: string; enabled: boolean }> = ({ projectId, eventId, enabled }) => {
  const appendixQuery = useAdminJudgeAppendix(projectId, eventId, enabled);
  if (!enabled) return <p className={styles.muted}>No narrative available</p>;
  if (appendixQuery.isLoading) return <p className={styles.muted}>Loading narrative…</p>;
  if (appendixQuery.isError) {
    return (
      <div className={styles.inlineError} role="alert">
        <span>The narrative couldn&apos;t be loaded.</span>
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => void appendixQuery.refetch()}
          {...{ 'data-testid': 'workflow-evaluation-appendix-retry' }}
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <div className={styles.markdown} {...{ 'data-testid': 'workflow-evaluation-appendix' }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{appendixQuery.data ?? ''}</ReactMarkdown>
    </div>
  );
};

const HumanFeedbackSection: React.FC<{ event: AdminEvaluationEventDetail }> = ({ event }) => (
  <section className={styles.section}>
    <h4 className={styles.sectionTitle}>Human scores</h4>
    <table className={styles.scores} {...{ 'data-testid': 'workflow-evaluation-scores' }}>
      <thead>
        <tr>
          <th scope="col">Criterion</th>
          <th scope="col">Score</th>
          <th scope="col">Meaning</th>
        </tr>
      </thead>
      <tbody>
        {event.criteria.map((criterion) => (
          <tr key={criterion.key}>
            <td>{criterion.label}</td>
            <td>{criterion.score}</td>
            <td>{criterion.scaleLabel}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <p className={styles.meta}>Average {event.criteriaAverage.toFixed(1)} / 5</p>
    <div {...{ 'data-testid': 'workflow-evaluation-reasons' }}>
      {event.reasons.length > 0 && (
        <p className={styles.text}><strong>Reasons:</strong> {event.reasons.map((reason) => reason.label).join(', ')}</p>
      )}
      {event.comment && <p className={styles.comment}>{event.comment}</p>}
      {event.hasCorrectedArtifact && <p className={styles.meta}>Corrected version supplied</p>}
    </div>
  </section>
);

const LineageSection: React.FC<{ event: AdminEvaluationEventDetail }> = ({ event }) => {
  const [copied, setCopied] = useState(false);
  const { lineage } = event;
  return (
    <section className={styles.section}>
      <h4 className={styles.sectionTitle}>Lineage</h4>
      <dl className={styles.facts} {...{ 'data-testid': 'workflow-evaluation-lineage' }}>
        <dt>Skill</dt>
        <dd className={styles.mono}>{lineage.skillPath ?? '—'}</dd>
        <dt>Skill version</dt>
        <dd className={styles.mono}>{lineage.skillVersion ?? '—'}</dd>
        <dt>Model</dt>
        <dd>{lineage.model ?? '—'}</dd>
        {lineage.interviewId && (
          <>
            <dt>Interview</dt>
            <dd className={styles.mono}>{lineage.interviewId}</dd>
          </>
        )}
        {lineage.prdId && (
          <>
            <dt>PRD</dt>
            <dd className={styles.mono}>{lineage.prdId}</dd>
          </>
        )}
        {event.phaseIndex !== null && (
          <>
            <dt>Phase</dt>
            <dd>{event.phaseIndex}</dd>
          </>
        )}
        <dt>Artifact hash</dt>
        <dd className={styles.mono}>
          <span title={event.artifactHash}>{event.artifactHash.slice(0, 12)}</span>{' '}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => {
              void navigator.clipboard?.writeText(event.artifactHash).then(() => setCopied(true));
            }}
            {...{ 'data-testid': 'workflow-evaluation-copy-hash' }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </dd>
      </dl>
    </section>
  );
};

const DiagnosticsSection: React.FC<{ projectId: string; event: AdminEvaluationEventDetail }> = ({ projectId, event }) => {
  const retry = useRetryWorkflowEvaluationJob(projectId, event.id);
  const [status, setStatus] = useState('');
  const [retryErrors, setRetryErrors] = useState<Partial<Record<WorkflowEvaluationJobEvaluator, string>>>({});
  const [retrying, setRetrying] = useState<WorkflowEvaluationJobEvaluator | null>(null);

  const onRetry = (key: WorkflowEvaluationJobEvaluator) => {
    setRetrying(key);
    setRetryErrors((current) => ({ ...current, [key]: undefined }));
    retry.mutate(key, {
      onSuccess: () => setStatus(`${JOB_NAMES[key]} retry started`),
      onError: (err) => {
        const message = err.status === 409 && err.code === 'job_not_failed'
          ? 'This job is no longer failed'
          : `Retry failed. The job is still failed. ${err.message}`;
        setRetryErrors((current) => ({ ...current, [key]: message }));
        setStatus('Retry failed');
      },
      onSettled: () => setRetrying(null),
    });
  };

  return (
    <section className={styles.section}>
      <h4 className={styles.sectionTitle}>Diagnostics</h4>
      {event.jobs.length === 0 && <p className={styles.muted}>No diagnostic jobs recorded for this event</p>}
      <ul className={styles.jobs}>
        {event.jobs.map((job) => (
          <li key={job.evaluatorKey} className={styles.job} {...{ 'data-testid': `workflow-evaluation-job-${job.evaluatorKey}` }}>
            <div className={styles.jobRow}>
              <span className={styles.jobName}>{JOB_NAMES[job.evaluatorKey]}</span>
              <JobStatusBadge status={job.status} data-testid={`workflow-evaluation-job-status-${job.evaluatorKey}`} />
              <span className={styles.meta}>Updated {formatDateTime(job.updatedAt)}</span>
              {job.status === 'failed' && (
                <button
                  type="button"
                  className={styles.retryButton}
                  disabled={retrying === job.evaluatorKey}
                  aria-label={`Retry ${JOB_NAMES[job.evaluatorKey]}`}
                  onClick={() => onRetry(job.evaluatorKey)}
                  {...{ 'data-testid': `workflow-evaluation-retry-${job.evaluatorKey}` }}
                >
                  {retrying === job.evaluatorKey ? 'Retrying…' : 'Retry'}
                </button>
              )}
            </div>
            {job.evaluatorKey === 'promptfoo' && event.promptfoo && (
              <PromptfooSummary summary={event.promptfoo} />
            )}
            {job.status === 'failed' && job.errorDetail && (
              <p className={styles.errorDetail}>{job.errorDetail}</p>
            )}
            {retryErrors[job.evaluatorKey] && (
              <p className={styles.fieldError} role="alert">{retryErrors[job.evaluatorKey]}</p>
            )}
          </li>
        ))}
      </ul>
      <p className={styles.srOnly} aria-live="polite" {...{ 'data-testid': 'workflow-evaluation-retry-status' }}>{status}</p>
    </section>
  );
};

const PromptfooSummary: React.FC<{ summary: NonNullable<AdminEvaluationEventDetail['promptfoo']> }> = ({ summary }) => (
  <div className={styles.promptfoo}>
    <p className={styles.meta}>
      {summary.totals.passed} of {summary.totals.tests} checks passed
    </p>
    {summary.failures.length > 0 && (
      <ul className={styles.list}>
        {summary.failures.map((failure, index) => (
          <li key={index}>
            <strong>{failure.test}</strong> ({failure.assertion}): {failure.reason}
          </li>
        ))}
      </ul>
    )}
  </div>
);
