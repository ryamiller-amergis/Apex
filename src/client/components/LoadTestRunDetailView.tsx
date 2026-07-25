import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppShell } from '../hooks/useAppShell';
import { useCancelRun, useLoadTestRun } from '../hooks/useLoadTestRuns';
import {
  isTerminalRunStatus,
  useLoadTestRunStream,
} from '../hooks/useLoadTestRunStream';
import { LoadTestRunStatusBadge } from './LoadTestRunStatusBadge';
import { LoadTestThresholdResultsTable } from './LoadTestThresholdResultsTable';
import styles from './LoadTestRunDetailView.module.css';

interface LoadTestRunDetailViewProps {
  project: string;
  runId: string;
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

  return (
    <div className={styles.page} data-testid="load-test-run-detail">
      <div className={styles.header}>
        <div>
          <button
            type="button"
            className={styles.backLink}
            onClick={() => navigate('/load-tests')}
          >
            ← Load Tests
          </button>
          <h1 className={styles.title}>
            {run.executionSnapshot?.definitionName ?? 'Load test run'}
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

      {(progress?.vu != null || progress?.iteration != null || progress?.message) && (
        <section className={styles.panel} data-testid="load-test-run-progress">
          <h2 className={styles.panelTitle}>Live progress</h2>
          <ul className={styles.progressList}>
            {progress?.vu != null && <li>VUs: {progress.vu}</li>}
            {progress?.iteration != null && <li>Iteration: {progress.iteration}</li>}
            {progress?.message && <li>{progress.message}</li>}
          </ul>
        </section>
      )}

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
