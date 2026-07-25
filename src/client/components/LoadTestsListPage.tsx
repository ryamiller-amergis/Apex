import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppShell } from '../hooks/useAppShell';
import { useLoadTests, type LoadTestDefinitionListItem } from '../hooks/useLoadTests';
import { LoadTestLastRunBadge } from './LoadTestLastRunBadge';
import styles from './LoadTestsListPage.module.css';

interface LoadTestsListPageProps {
  project: string;
  canView: boolean;
}

function requirementLabel(item: LoadTestDefinitionListItem): string {
  const ref = item.requirementRef;
  if (!ref) return '—';
  return ref.displayLabel || ref.id;
}

export const LoadTestsListPage: React.FC<LoadTestsListPageProps> = ({ project, canView }) => {
  const navigate = useNavigate();
  const { can } = useAppShell();
  const canManage = can('load-test:manage');
  const { data: items = [], isLoading, isError, refetch } = useLoadTests(canView ? project : null);

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
                <th scope="col">Requirement</th>
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
                  <td>{requirementLabel(item)}</td>
                  <td>
                    <LoadTestLastRunBadge
                      status={item.latestRun?.status}
                      overallResult={item.latestRun?.overallResult}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className={styles.secondaryBtn}
                      onClick={() => navigate(`/load-tests/${item.id}`)}
                    >
                      {canManage ? 'Edit' : 'View'}
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

export default LoadTestsListPage;
