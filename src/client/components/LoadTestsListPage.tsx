import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppShell } from '../hooks/useAppShell';
import { useLoadTests } from '../hooks/useLoadTests';
import { LoadTestRunApiError, useEnqueueRun, useLoadTestRuns } from '../hooks/useLoadTestRuns';
import { isTerminalRunStatus } from '../hooks/useLoadTestRunStream';
import { LoadTestLastRunBadge } from './LoadTestLastRunBadge';
import { LoadTestRunStatusBadge } from './LoadTestRunStatusBadge';
import styles from './LoadTestsListPage.module.css';

interface LoadTestsListPageProps {
  project: string;
  canView: boolean;
}

export const LoadTestsListPage: React.FC<LoadTestsListPageProps> = ({ project, canView }) => {
  const navigate = useNavigate();
  const { can } = useAppShell();
  const canManage = can('load-test:manage');
  const canRun = can('load-test:run');
  const enqueueMutation = useEnqueueRun(project);
  const [runError, setRunError] = useState<string | null>(null);
  const [runningDefinitionId, setRunningDefinitionId] = useState<string | null>(null);
  const { data: items = [], isLoading, isError, refetch } = useLoadTests(canView ? project : null);
  const { data: recentRuns = [] } = useLoadTestRuns(canView ? project : null, { limit: 50 });

  const activeRuns = useMemo(
    () => recentRuns.filter((run) => !isTerminalRunStatus(run.status)),
    [recentRuns],
  );

  const onRun = async (definitionId: string) => {
    if (!canRun) return;
    setRunError(null);
    setRunningDefinitionId(definitionId);
    try {
      const run = await enqueueMutation.mutateAsync({ definitionId });
      navigate(`/load-tests/runs/${run.id}`);
    } catch (err) {
      const message =
        err instanceof LoadTestRunApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to start load test run';
      setRunError(message);
    } finally {
      setRunningDefinitionId(null);
    }
  };

  if (!canView) {
    return (
      <div className={styles.forbidden} data-testid="load-tests-forbidden">
        <p>You do not have permission to view Load Tests.</p>
      </div>
    );
  }

  return (
    <div className={styles.page} data-testid="load-tests-list">
      <div className={styles.header}>
        <h1 className={styles.title}>Load Tests</h1>
        {canManage && (
          <button
            type="button"
            className={styles.createBtn}
            data-testid="load-tests-create-btn"
            onClick={() => navigate('/load-tests/new')}
          >
            Create load test
          </button>
        )}
      </div>

      {runError && (
        <div className={styles.errorBox} role="alert" data-testid="load-tests-run-error">
          <p>{runError}</p>
        </div>
      )}

      {activeRuns.length > 0 && (
        <section className={styles.activePanel} data-testid="load-tests-active-runs">
          <h2 className={styles.activeTitle}>In progress</h2>
          <p className={styles.activeHint}>
            Queued and running executions across this project. Dispatched means waiting for a
            runner (local noop leaves runs here until Azure LT infra is configured).
          </p>
          <ul className={styles.activeList}>
            {activeRuns.map((run) => (
              <li key={run.id} className={styles.activeItem}>
                <button
                  type="button"
                  className={styles.linkBtn}
                  onClick={() => navigate(`/load-tests/runs/${run.id}`)}
                >
                  {run.executionSnapshot?.definitionName ?? run.loadTestId}
                </button>
                <LoadTestRunStatusBadge status={run.status} overallResult={run.overallResult} />
                <span className={styles.activeMeta}>
                  {run.executionSnapshot?.environment ?? '—'} ·{' '}
                  {run.executionSnapshot?.targetUrl ?? run.targetKey ?? 'target unknown'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {isLoading && (
        <div className={styles.skeleton} aria-busy="true">
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
        </div>
      )}

      {isError && (
        <div className={styles.errorBox} role="alert">
          <p>Failed to load load tests.</p>
          <button type="button" className={styles.retryBtn} onClick={() => refetch()}>
            Retry
          </button>
        </div>
      )}

      {!isLoading && !isError && items.length === 0 && (
        <div className={styles.empty} data-testid="load-tests-list-empty">
          <p className={styles.emptyText}>No load tests yet</p>
          <p className={styles.emptyHint}>
            Create a definition with a guided form or raw k6 script against an allowlisted non-prod
            target.
          </p>
          {canManage && (
            <button
              type="button"
              className={styles.createBtn}
              data-testid="load-tests-create-btn"
              onClick={() => navigate('/load-tests/new')}
            >
              Create load test
            </button>
          )}
        </div>
      )}

      {!isLoading && !isError && items.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Target</th>
                <th scope="col">Last run</th>
                <th scope="col">
                  <span className={styles.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} data-testid={`load-test-row-${item.id}`}>
                  <td>
                    <button
                      type="button"
                      className={styles.linkBtn}
                      onClick={() => navigate(`/load-tests/${item.id}`)}
                    >
                      {item.name}
                    </button>
                  </td>
                  <td>
                    <span className={styles.muted}>{item.environment}</span>
                    <div className={styles.url}>{item.targetUrl}</div>
                  </td>
                  <td>
                    {item.latestRun?.id ? (
                      <button
                        type="button"
                        className={styles.linkBtn}
                        data-testid={`load-test-last-run-link-${item.id}`}
                        onClick={() => navigate(`/load-tests/runs/${item.latestRun!.id}`)}
                      >
                        <LoadTestLastRunBadge
                          status={item.latestRun?.status}
                          overallResult={item.latestRun?.overallResult}
                        />
                      </button>
                    ) : (
                      <LoadTestLastRunBadge
                        status={item.latestRun?.status}
                        overallResult={item.latestRun?.overallResult}
                      />
                    )}
                  </td>
                  <td>
                    <div className={styles.rowActions}>
                      {canRun && (
                        <button
                          type="button"
                          className={styles.runBtn}
                          data-testid={`load-test-run-btn-${item.id}`}
                          onClick={() => onRun(item.id)}
                          disabled={enqueueMutation.isPending}
                        >
                          {runningDefinitionId === item.id ? 'Starting…' : 'Run'}
                        </button>
                      )}
                      <button
                        type="button"
                        className={styles.secondaryBtn}
                        data-testid={`load-test-view-runs-btn-${item.id}`}
                        onClick={() => navigate(`/load-tests/${item.id}/runs`)}
                      >
                        Runs
                      </button>
                      <button
                        type="button"
                        className={styles.secondaryBtn}
                        onClick={() => navigate(`/load-tests/${item.id}`)}
                      >
                        {canManage ? 'Edit' : 'View'}
                      </button>
                    </div>
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

export default LoadTestsListPage;
