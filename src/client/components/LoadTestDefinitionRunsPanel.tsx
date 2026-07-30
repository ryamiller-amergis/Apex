import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useLoadTestRuns } from '../hooks/useLoadTestRuns';
import { isTerminalRunStatus } from '../hooks/useLoadTestRunStream';
import { LoadTestRunStatusBadge } from './LoadTestRunStatusBadge';
import styles from './LoadTestDefinitionRunsPanel.module.css';

interface LoadTestDefinitionRunsPanelProps {
  project: string;
  definitionId: string;
}

function formatWhen(value?: string | null): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export const LoadTestDefinitionRunsPanel: React.FC<LoadTestDefinitionRunsPanelProps> = ({
  project,
  definitionId,
}) => {
  const navigate = useNavigate();
  const { data: runs = [], isLoading, isError, refetch } = useLoadTestRuns(project, {
    definitionId,
    limit: 100,
  });

  const activeCount = runs.filter((run) => !isTerminalRunStatus(run.status)).length;

  if (isLoading) {
    return (
      <div className={styles.panel} data-testid="load-test-definition-runs" aria-busy="true">
        <div className={styles.skeleton} />
        <div className={styles.skeleton} />
      </div>
    );
  }

  if (isError) {
    return (
      <div className={styles.panel} data-testid="load-test-definition-runs">
        <div className={styles.errorBox} role="alert">
          <p>Failed to load runs for this load test.</p>
          <button type="button" className={styles.secondaryBtn} onClick={() => refetch()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel} data-testid="load-test-definition-runs">
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>Run history</h2>
          <p className={styles.hint}>
            {runs.length === 0
              ? 'No runs yet for this definition.'
              : `${runs.length} run${runs.length === 1 ? '' : 's'}${
                  activeCount > 0 ? ` · ${activeCount} in progress` : ''
                }`}
          </p>
        </div>
      </div>

      {runs.length === 0 ? (
        <div className={styles.empty} data-testid="load-test-definition-runs-empty">
          <p>Start a run from the Definition tab to see status and results here.</p>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Result</th>
                <th scope="col">Queued</th>
                <th scope="col">Completed</th>
                <th scope="col">Target</th>
                <th scope="col">
                  <span className={styles.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} data-testid={`load-test-definition-run-row-${run.id}`}>
                  <td>
                    <LoadTestRunStatusBadge
                      status={run.status}
                      overallResult={run.overallResult}
                    />
                  </td>
                  <td className={styles.muted}>
                    {run.overallResult ?? (isTerminalRunStatus(run.status) ? '—' : 'In progress')}
                  </td>
                  <td className={styles.muted}>{formatWhen(run.queuedAt)}</td>
                  <td className={styles.muted}>{formatWhen(run.completedAt)}</td>
                  <td className={styles.url}>
                    {run.executionSnapshot?.targetUrl ?? run.targetKey ?? '—'}
                  </td>
                  <td>
                    <button
                      type="button"
                      className={styles.linkBtn}
                      data-testid={`load-test-definition-run-open-${run.id}`}
                      onClick={() => navigate(`/load-tests/runs/${run.id}`)}
                    >
                      View details
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default LoadTestDefinitionRunsPanel;
