import React from 'react';
import type { DeploymentOutcome } from '../../shared/types/deploymentOutcome';
import type { RelatedItemCycleTime } from '../../shared/types/relatedItemCycleTime';
import { useReleaseRelatedCycleTime } from '../hooks/useDeploymentOutcomes';
import { useAppShell } from '../hooks/useAppShell';
import styles from './DeploymentOutcomeReport.module.css';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatCycleDays(days: number | null | undefined): string {
  if (days == null) return '—';
  return `${days} d`;
}

function incompleteNote(item: RelatedItemCycleTime): string {
  if (item.incompleteReason === 'missing_done') return 'Never reached Done';
  if (item.incompleteReason === 'end_not_after_start') return 'Reopened after Done';
  if (item.incompleteReason === 'missing_in_progress') return 'Never entered In Progress';
  return '';
}

/**
 * One table row: a release Epic, the outcome recorded for it, or both. Releases with
 * no recorded outcome still get a row so the report lists every release.
 */
export interface OutcomeReportRow {
  key: string;
  releaseVersion: string;
  epicId?: number;
  releaseStatus?: string;
  outcome?: DeploymentOutcome;
  deployedAt?: string;
  recordedAt?: string;
}

interface OutcomeReportTableRowProps {
  row: OutcomeReportRow;
  project?: string;
  areaPath?: string;
  expanded: boolean;
  onToggle: () => void;
  formatDowntime: (minutes: number) => string;
  formatDate: (iso: string) => string;
  getBadgeClass: (result: string) => string;
}

export const OutcomeReportTableRow: React.FC<OutcomeReportTableRowProps> = ({
  row,
  project,
  areaPath,
  expanded,
  onToggle,
  formatDowntime,
  formatDate: formatOutcomeDate,
  getBadgeClass,
}) => {
  const { setSelectedItem } = useAppShell();
  const { key, epicId, outcome } = row;
  const cycleQuery = useReleaseRelatedCycleTime(epicId, project, areaPath, epicId != null);

  const medianLabel =
    epicId == null
      ? '—'
      : cycleQuery.isLoading
        ? '…'
        : formatCycleDays(cycleQuery.data?.medianDays);

  return (
    <>
      <tr>
        <td>
          <button
            type="button"
            className={styles.btnExpand}
            onClick={onToggle}
            title={expanded ? 'Collapse' : 'Expand'}
            aria-expanded={expanded}
            {...{ 'data-testid': `outcome-report-expand-${key}` }}
          >
            {expanded ? '▼' : '▶'}
          </button>
        </td>
        <td>{row.releaseVersion}</td>
        <td>
          {outcome ? (
            <span className={`${styles.resultBadge} ${getBadgeClass(outcome.result)}`}>
              {outcome.result}
            </span>
          ) : (
            <span
              className={styles.notRecorded}
              {...{ 'data-testid': `outcome-report-not-recorded-${key}` }}
            >
              Not recorded
            </span>
          )}
        </td>
        <td>{outcome?.downtimeMinutes != null ? formatDowntime(outcome.downtimeMinutes) : '—'}</td>
        <td className={styles.detailsCell} title={outcome?.details ?? ''}>
          {outcome?.details ?? '—'}
        </td>
        <td>{outcome?.reportedBy ?? '—'}</td>
        <td>{row.deployedAt ? formatOutcomeDate(row.deployedAt) : '—'}</td>
        <td>{row.recordedAt ? formatOutcomeDate(row.recordedAt) : '—'}</td>
        <td {...{ 'data-testid': `outcome-report-cycle-time-${key}` }}>
          {medianLabel}
        </td>
      </tr>
      {expanded && (
        <tr className={styles.expandedRow}>
          <td colSpan={9}>
            {epicId == null ? (
              <div
                className={styles.cycleEmpty}
                {...{ 'data-testid': `outcome-report-cycle-empty-${key}` }}
              >
                No matching release Epic for this version.
              </div>
            ) : cycleQuery.isLoading ? (
              <div
                className={styles.cycleLoading}
                {...{ 'data-testid': `outcome-report-cycle-loading-${key}` }}
              >
                Loading cycle time…
              </div>
            ) : cycleQuery.error ? (
              <div
                className={styles.cycleEmpty}
                {...{ 'data-testid': `outcome-report-cycle-error-${key}` }}
              >
                Could not load cycle time.
              </div>
            ) : (
              <div
                className={styles.cycleExpand}
                {...{ 'data-testid': `outcome-report-cycle-panel-${key}` }}
              >
                <div className={styles.cycleHeader}>
                  Median cycle time · {cycleQuery.data?.sampleSize ?? 0} of{' '}
                  {cycleQuery.data?.items.length ?? 0} items completed
                </div>
                {(cycleQuery.data?.items.length ?? 0) === 0 ? (
                  <p className={styles.cycleEmpty}>No related work items linked to this release.</p>
                ) : (
                  <table className={styles.nestedTable}>
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Type</th>
                        <th>Title</th>
                        <th>State</th>
                        <th>Last In Progress</th>
                        <th>Last Done</th>
                        <th>Cycle Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cycleQuery.data!.items.map((item) => (
                        <tr
                          key={item.id}
                          className={styles.clickableRow}
                          onClick={() => setSelectedItem(item.workItem)}
                          title="Click to view details"
                          {...{ 'data-testid': `outcome-report-cycle-item-${item.id}` }}
                        >
                          <td>
                            <button
                              type="button"
                              className={styles.itemIdButton}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedItem(item.workItem);
                              }}
                              {...{ 'data-testid': `outcome-report-cycle-item-open-${item.id}` }}
                            >
                              {item.id}
                            </button>
                          </td>
                          <td>{item.workItemType}</td>
                          <td>{item.title}</td>
                          <td>{item.state}</td>
                          <td>{formatDate(item.lastInProgressAt)}</td>
                          <td>{formatDate(item.lastDoneAt)}</td>
                          <td>
                            {formatCycleDays(item.cycleTimeDays)}
                            {item.cycleTimeDays == null && incompleteNote(item) ? (
                              <span className={styles.incompleteNote}> {incompleteNote(item)}</span>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
};
