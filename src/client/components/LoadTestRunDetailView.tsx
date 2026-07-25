import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppShell } from '../hooks/useAppShell';
import { useCancelRun, useLoadTestRun } from '../hooks/useLoadTestRuns';
import {
  isTerminalRunStatus,
  useLoadTestRunStream,
} from '../hooks/useLoadTestRunStream';
import type { RunStatus } from '../../shared/types/loadTest';
import { LoadTestRunStatusBadge } from './LoadTestRunStatusBadge';
import { LoadTestThresholdResultsTable } from './LoadTestThresholdResultsTable';
import styles from './LoadTestRunDetailView.module.css';

interface LoadTestRunDetailViewProps {
  project: string;
  runId: string;
}

const STATUS_PIPELINE: RunStatus[] = ['queued', 'dispatched', 'running'];

function formatWhen(value?: string | null): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function statusExplanation(
  status: RunStatus | string | null | undefined,
  errorDetail?: string | null,
): string {
  switch (status) {
    case 'queued':
      return 'Waiting for a free target slot before dispatch.';
    case 'dispatched':
      return 'Dispatch accepted. Waiting for the k6 runner to start (or noop publisher in local dev — no runner will attach until Azure LT infra is configured).';
    case 'running':
      return 'Runner is executing the frozen script snapshot.';
    case 'passed':
      return 'Run finished and all client thresholds passed.';
    case 'failed':
      return 'Run finished but one or more thresholds failed.';
    case 'errored':
      if (errorDetail?.includes('Stale heartbeat')) {
        return 'No runner heartbeats arrived in time, so the reaper marked this run errored. With LT_DISPATCH_PUBLISHER=noop (local default), nothing executes the script until Azure LT infra or a local k6 runner is configured.';
      }
      return 'Run ended with an infrastructure or runner error.';
    case 'cancelled':
      return 'Run was cancelled before completion.';
    default:
      return 'Status updating…';
  }
}

export const LoadTestRunDetailView: React.FC<LoadTestRunDetailViewProps> = ({
  project,
  runId,
}) => {
  const navigate = useNavigate();
  const { can } = useAppShell();
  const canView = can('load-test:view');
  const canRun = can('load-test:run');

  const {
    data: run,
    isLoading,
    isError,
    refetch,
  } = useLoadTestRun(canView ? project : null, canView ? runId : null);

  const stream = useLoadTestRunStream(canView ? project : null, canView ? runId : null, {
    enabled: canView && Boolean(run) && !isTerminalRunStatus(run?.status),
    initialStatus: run?.status ?? null,
  });

  const cancelMutation = useCancelRun(project);

  const status = stream.status ?? run?.status ?? null;
  const cancelRequested = stream.cancelRequested || Boolean(run?.cancelRequested);
  const thresholdResults = stream.thresholdResults ?? run?.thresholdResults ?? null;
  const overallResult = stream.overallResult ?? run?.overallResult ?? null;
  const progress = stream.progress;
  const showChart = Boolean(run?.timeseriesArtifactRef);
  const terminal = isTerminalRunStatus(status);
  const canCancel =
    canRun && Boolean(status) && !terminal && !cancelMutation.isPending;
  const snapshot = run?.executionSnapshot ?? null;

  if (!canView) {
    return (
      <div className={styles.forbidden} data-testid="load-test-run-detail">
        <p>You do not have permission to view this load test run.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={styles.page} data-testid="load-test-run-detail" aria-busy="true">
        <div className={styles.skeleton} />
        <div className={styles.skeleton} />
      </div>
    );
  }

  if (isError || !run) {
    return (
      <div className={styles.page} data-testid="load-test-run-detail">
        <div className={styles.errorBox} role="alert">
          <p>Failed to load run {runId}.</p>
          <button type="button" className={styles.secondaryBtn} onClick={() => refetch()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const pipelineCompleteIndex = (() => {
    if (status === 'queued') return 0;
    if (status === 'dispatched') return 1;
    if (status === 'running') return 2;
    if (terminal) return 3;
    return -1;
  })();

  return (
    <div className={styles.page} data-testid="load-test-run-detail">
      <div className={styles.header}>
        <div>
          <button
            type="button"
            className={styles.backLink}
            onClick={() =>
              navigate(
                run.loadTestId
                  ? `/load-tests/${run.loadTestId}/runs`
                  : '/load-tests',
              )
            }
          >
            ← {run.loadTestId ? 'Back to runs' : 'Load Tests'}
          </button>
          <h1 className={styles.title}>
            {snapshot?.definitionName ?? 'Load test run'}
          </h1>
          <p className={styles.meta}>
            Run <code>{runId}</code>
            {run.loadTestId ? (
              <>
                {' · '}
                <button
                  type="button"
                  className={styles.linkBtn}
                  onClick={() => navigate(`/load-tests/${run.loadTestId}`)}
                >
                  Open definition
                </button>
              </>
            ) : null}
          </p>
        </div>
        <div className={styles.actions}>
          <LoadTestRunStatusBadge status={status} overallResult={overallResult} />
          {canRun && (
            <button
              type="button"
              className={styles.cancelBtn}
              data-testid="load-test-run-cancel-btn"
              disabled={!canCancel || cancelRequested}
              onClick={() => cancelMutation.mutate({ runId })}
            >
              {cancelRequested ? 'Cancel requested' : 'Cancel run'}
            </button>
          )}
        </div>
      </div>

      <div
        className={styles.liveRegion}
        data-testid="load-test-run-live-region"
        aria-live="polite"
      >
        Status: {status ?? 'unknown'}
        {progress?.message ? ` — ${progress.message}` : ''}
      </div>

      {stream.reconnecting && (
        <div
          className={styles.reconnect}
          data-testid="load-test-run-reconnect-banner"
          role="status"
        >
          Live connection interrupted. Showing last known status for run {runId}; reconnecting…
        </div>
      )}

      <section className={styles.panel} data-testid="load-test-run-pipeline">
        <h2 className={styles.panelTitle}>Run pipeline</h2>
        <ol className={styles.pipeline}>
          {STATUS_PIPELINE.map((step, index) => {
            const active = status === step;
            const done = pipelineCompleteIndex > index || (terminal && index < 3);
            return (
              <li
                key={step}
                className={`${styles.pipelineStep} ${active ? styles.pipelineActive : ''} ${done ? styles.pipelineDone : ''}`}
                data-testid={`load-test-run-pipeline-${step}`}
                data-active={active ? 'true' : 'false'}
              >
                <span className={styles.pipelineDot} aria-hidden="true" />
                <span className={styles.pipelineLabel}>{step}</span>
              </li>
            );
          })}
          <li
            className={`${styles.pipelineStep} ${terminal ? styles.pipelineActive : ''} ${terminal ? styles.pipelineDone : ''}`}
            data-testid="load-test-run-pipeline-terminal"
            data-active={terminal ? 'true' : 'false'}
          >
            <span className={styles.pipelineDot} aria-hidden="true" />
            <span className={styles.pipelineLabel}>
              {terminal ? String(status) : 'complete'}
            </span>
          </li>
        </ol>
        <p className={styles.statusExplain} data-testid="load-test-run-status-explain">
          {statusExplanation(status, run.errorDetail)}
        </p>
        <dl className={styles.metaGrid}>
          <div>
            <dt>Queued</dt>
            <dd>{formatWhen(run.queuedAt)}</dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>{formatWhen(run.startedAt)}</dd>
          </div>
          <div>
            <dt>Completed</dt>
            <dd>{formatWhen(run.completedAt)}</dd>
          </div>
          <div>
            <dt>Heartbeat</dt>
            <dd>{formatWhen(run.heartbeatAt ?? stream.lastEventAt)}</dd>
          </div>
        </dl>
      </section>

      <section className={styles.panel} data-testid="load-test-run-execution">
        <h2 className={styles.panelTitle}>What is running</h2>
        {snapshot ? (
          <>
            <dl className={styles.metaGrid}>
              <div>
                <dt>Target</dt>
                <dd className={styles.urlCell}>{snapshot.targetUrl}</dd>
              </div>
              <div>
                <dt>Environment</dt>
                <dd>{snapshot.environment}</dd>
              </div>
              <div>
                <dt>Load profile</dt>
                <dd>
                  {snapshot.loadProfile.vus} VUs · {snapshot.loadProfile.durationMinutes} min
                  {snapshot.loadProfile.rpsCap != null
                    ? ` · RPS cap ${snapshot.loadProfile.rpsCap}`
                    : ''}
                </dd>
              </div>
              <div>
                <dt>Thresholds</dt>
                <dd>
                  {snapshot.clientThresholds.length > 0
                    ? snapshot.clientThresholds
                        .map((t) => `${t.metric} ${t.expression}`)
                        .join('; ')
                    : 'None'}
                </dd>
              </div>
            </dl>
            <h3 className={styles.subTitle}>Frozen script snapshot</h3>
            <pre className={styles.scriptPreview} data-testid="load-test-run-script-preview">
              {snapshot.script}
            </pre>
          </>
        ) : (
          <p className={styles.muted}>No execution snapshot was stored for this run.</p>
        )}
      </section>

      <section className={styles.panel} data-testid="load-test-run-progress">
        <h2 className={styles.panelTitle}>Live progress</h2>
        {progress?.vu != null || progress?.iteration != null || progress?.message ? (
          <ul className={styles.progressList}>
            {progress?.vu != null && <li>VUs: {progress.vu}</li>}
            {progress?.iteration != null && <li>Iteration: {progress.iteration}</li>}
            {progress?.message && <li>{progress.message}</li>}
          </ul>
        ) : (
          <p className={styles.muted} data-testid="load-test-run-progress-empty">
            {terminal
              ? 'No live progress samples were recorded for this run.'
              : status === 'running'
                ? 'Waiting for the next runner heartbeat…'
                : 'Live VU/iteration samples appear once a runner starts executing.'}
          </p>
        )}
      </section>

      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Threshold results</h2>
        <LoadTestThresholdResultsTable
          results={thresholdResults}
          overallResult={overallResult}
        />
      </section>

      {showChart ? (
        <section className={styles.panel} data-testid="load-test-run-timeseries-chart">
          <h2 className={styles.panelTitle}>Time series</h2>
          <p className={styles.muted}>
            Timeseries artifact is available. Chart rendering uses in-repo recharts when points are
            loaded; until then the threshold table above remains the source of truth.
          </p>
        </section>
      ) : null}

      {run.errorDetail && (
        <section className={styles.panel} role="alert">
          <h2 className={styles.panelTitle}>Error detail</h2>
          <pre className={styles.errorDetail}>{run.errorDetail}</pre>
        </section>
      )}
    </div>
  );
};

export default LoadTestRunDetailView;
