import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppShell } from '../hooks/useAppShell';
import { useRequirementLoadTests } from '../hooks/useRequirementLoadTests';
import type { LoadTestRequirementLinkSummary } from '../../shared/types/loadTest';
import { LoadTestRunStatusBadge } from './LoadTestRunStatusBadge';
import styles from './RequirementLoadTestsSection.module.css';

export interface RequirementLoadTestsSectionProps {
  projectId: string;
  workItemId: number | string;
}

const RequirementLoadTestRow: React.FC<{ item: LoadTestRequirementLinkSummary }> = ({
  item,
}) => {
  const latest = item.latestRun;
  const definitionHref = `/load-tests/${item.definitionId}`;
  const runHref = latest ? `/load-tests/runs/${latest.runId}` : null;

  return (
    <li className={styles.row} data-testid="requirement-load-test-row">
      <div className={styles.rowTop}>
        <span className={styles.name}>{item.name}</span>
        <span data-testid="requirement-load-test-status">
          {latest ? (
            <LoadTestRunStatusBadge
              status={latest.status}
              overallResult={latest.overallResult}
            />
          ) : (
            <span className={styles.neverRun}>Never run</span>
          )}
        </span>
      </div>
      {latest?.completedAt ? (
        <div className={styles.meta}>
          Completed {new Date(latest.completedAt).toLocaleString()}
        </div>
      ) : null}
      <div className={styles.links}>
        <Link
          to={definitionHref}
          className={styles.link}
          data-testid="requirement-load-test-definition-link"
          aria-label={`Open definition ${item.name}`}
        >
          Open definition
        </Link>
        {runHref ? (
          <Link
            to={runHref}
            className={styles.link}
            data-testid="requirement-load-test-run-link"
            aria-label={`Open run ${latest!.runId} for ${item.name}`}
          >
            Open latest run
          </Link>
        ) : null}
      </div>
    </li>
  );
};

/**
 * FEAT-010 — read-only Load Tests section for ADO work-item DetailsPanel.
 * Returns null when the user lacks load-test:view (no disclosure).
 */
export const RequirementLoadTestsSection: React.FC<RequirementLoadTestsSectionProps> = ({
  projectId,
  workItemId,
}) => {
  const { can, isSuperAdmin } = useAppShell();
  const [expanded, setExpanded] = useState(true);
  const canView = isSuperAdmin || can('load-test:view');

  const query = useRequirementLoadTests(projectId, workItemId, { enabled: canView });

  if (!canView) {
    return null;
  }

  const count = query.data?.length ?? 0;

  return (
    <section
      className={styles.section}
      data-testid="requirement-load-tests-section"
      aria-labelledby="requirement-load-tests-heading"
    >
      <div
        className={styles.header}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
      >
        <h3 id="requirement-load-tests-heading" className={styles.title}>
          {expanded ? '▼' : '▶'} Load Tests{query.isSuccess ? ` (${count})` : ''}
        </h3>
      </div>

      {expanded && (
        <div>
          {query.isLoading && (
            <div
              className={styles.loading}
              data-testid="requirement-load-tests-loading"
            >
              Loading load tests…
            </div>
          )}

          {query.isError && (
            <div
              className={styles.error}
              data-testid="requirement-load-tests-error"
              role="alert"
            >
              Unable to load linked load tests.
              <button
                type="button"
                className={styles.retry}
                onClick={() => void query.refetch()}
              >
                Retry
              </button>
            </div>
          )}

          {query.isSuccess && count === 0 && (
            <div
              className={styles.empty}
              data-testid="requirement-load-tests-empty"
            >
              No load tests linked to this work item
            </div>
          )}

          {query.isSuccess && count > 0 && (
            <ul className={styles.list}>
              {query.data!.map((item) => (
                <RequirementLoadTestRow key={item.definitionId} item={item} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
};

export default RequirementLoadTestsSection;
