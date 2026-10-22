import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  WORKFLOW_EVALUATION_OUTCOME_LABELS,
  WORKFLOW_EVALUATION_REASON_CODE_LABELS,
  WORKFLOW_EVALUATION_SEEDED_STAGE_KEYS,
  type WorkflowEvaluationOutcome,
} from '../../shared/types/workflowEvaluation';
import {
  workflowEvaluationStageLabel,
  type AdminEvaluationEventSummary,
  type AdminEvaluationExportFormat,
  type AdminEvaluationFilters,
} from '../../shared/types/workflowEvaluationAdmin';
import { useWorkflowEvaluationAccess } from '../hooks/useWorkflowEvaluationAccess';
import {
  useAdminWorkflowEvaluationEvents,
  useExportWorkflowEvaluations,
} from '../hooks/useWorkflowEvaluationsAdmin';
import {
  hasActiveFilters,
  isDateRangeInvalid,
  parseWorkflowEvaluationFilters,
  writeWorkflowEvaluationFilters,
} from '../utils/workflowEvaluationFilters';
import {
  DataGridFilterDivider,
  DataGridFilterPills,
  DataGridFilterSelect,
  DataGridToolbar,
} from './DataGridToolbar';
import { EVALUATOR_LABELS, JobStatusBadge, OutcomeBadge } from './WorkflowEvaluationBadges';
import { WorkflowEvaluationDetailDrawer } from './WorkflowEvaluationDetailDrawer';
import gridStyles from './DataGrid.module.css';
import styles from './WorkflowEvaluationsPage.module.css';

export interface WorkflowEvaluationsPageProps {
  selectedProject: string | null;
}

type OutcomeFilter = 'all' | WorkflowEvaluationOutcome;

const OUTCOME_OPTIONS: readonly { label: string; value: OutcomeFilter }[] = [
  { label: 'All', value: 'all' },
  ...WORKFLOW_EVALUATION_OUTCOME_LABELS.map((outcome) => ({ label: outcome.label, value: outcome.key })),
];
const STAGE_OPTIONS = WORKFLOW_EVALUATION_SEEDED_STAGE_KEYS.map((key) => ({
  label: workflowEvaluationStageLabel(key),
  value: key as string,
}));
const REASON_OPTIONS = WORKFLOW_EVALUATION_REASON_CODE_LABELS.map((reason) => ({
  label: reason.label,
  value: reason.key as string,
}));
const SUBJECT_OPTIONS = [
  { label: 'PRD', value: 'prd' },
  { label: 'Interview phase', value: 'interview_phase' },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_DEBOUNCE_MS = 300;

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function subjectText(event: AdminEvaluationEventSummary): string {
  if (event.subjectType === 'interview_phase') {
    return `Interview ${event.subjectId.slice(0, 8)} · phase ${event.phaseIndex ?? '?'}`;
  }
  return `PRD ${event.subjectId.slice(0, 8)}`;
}

export const WorkflowEvaluationsPage: React.FC<WorkflowEvaluationsPageProps> = ({ selectedProject }) => {
  const access = useWorkflowEvaluationAccess(selectedProject ?? undefined);
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parseWorkflowEvaluationFilters(searchParams), [searchParams]);
  const drawerParam = searchParams.get('drawer');
  const drawerEventId = drawerParam && UUID_RE.test(drawerParam) ? drawerParam : null;
  const dateInvalid = isDateRangeInvalid(filters);
  const [search, setSearch] = useState(filters.q ?? '');
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState('');

  const listQuery = useAdminWorkflowEvaluationEvents(selectedProject, filters, access.canAdmin && !dateInvalid);
  const exportEvents = useExportWorkflowEvaluations(selectedProject);

  const updateFilters = (patch: Partial<AdminEvaluationFilters>) => {
    setSearchParams(
      (current) => writeWorkflowEvaluationFilters(current, { ...parseWorkflowEvaluationFilters(current), ...patch }),
      { replace: true },
    );
  };

  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === (filters.q ?? '')) return undefined;
    const timer = window.setTimeout(() => updateFilters({ q: trimmed || undefined }), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // updateFilters reads the latest params through the setter callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filters.q]);

  const setDrawer = (eventId: string | null) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (eventId) next.set('drawer', eventId);
      else next.delete('drawer');
      return next;
    });
  };

  const onExport = async (format: AdminEvaluationExportFormat) => {
    setExporting(true);
    setExportStatus('');
    try {
      const count = await exportEvents(filters, format);
      setExportStatus(count === null ? 'Export complete' : `Export complete: ${count} event${count === 1 ? '' : 's'}`);
    } catch (err) {
      setExportStatus(`Export failed${err instanceof Error ? `: ${err.message}` : ''}`);
    } finally {
      setExporting(false);
    }
  };

  if (!access.ready) {
    return (
      <div className={styles.page}>
        <p className={gridStyles.loading}>Loading…</p>
      </div>
    );
  }

  if (!access.canAdmin) {
    return (
      <div className={styles.page}>
        <section className={gridStyles.section} {...{ 'data-testid': 'workflow-evaluations-access-denied' }}>
          <p className={gridStyles.error} role="alert">
            You don&apos;t have permission to view workflow evaluations.
          </p>
        </section>
      </div>
    );
  }

  if (!selectedProject) {
    return (
      <div className={styles.page}>
        <section className={gridStyles.section}>
          <p className={gridStyles.empty}>Select a project to view workflow evaluations.</p>
        </section>
      </div>
    );
  }

  const items = listQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = hasActiveFilters(filters);
  const exportDisabled = listQuery.isLoading || exporting || dateInvalid;

  return (
    <div className={styles.page}>
      <section className={gridStyles.section} {...{ 'data-testid': 'workflow-evaluations-page' }}>
        <div className={gridStyles.header}>
          <div>
            <h2 className={gridStyles.title}>Workflow evaluations</h2>
            <p className={gridStyles.hint}>
              Human feedback on Interview phases and PRDs, with Promptfoo and judge diagnostics.
            </p>
          </div>
          <div className={gridStyles.headerActions}>
            <button
              type="button"
              className={gridStyles.button}
              disabled={exportDisabled}
              onClick={() => void onExport('json')}
              {...{ 'data-testid': 'workflow-evaluations-export-json' }}
            >
              Export JSON
            </button>
            <button
              type="button"
              className={gridStyles.button}
              disabled={exportDisabled}
              onClick={() => void onExport('csv')}
              {...{ 'data-testid': 'workflow-evaluations-export-csv' }}
            >
              Export CSV
            </button>
          </div>
        </div>
        <p className={styles.srOnly} aria-live="polite" {...{ 'data-testid': 'workflow-evaluations-export-status' }}>
          {exportStatus}
        </p>
        {exportStatus.startsWith('Export failed') && (
          <p className={gridStyles.error} role="alert">{exportStatus}</p>
        )}

        <DataGridToolbar
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search by event or subject id…"
          searchTestId="workflow-evaluations-search"
        >
          <DataGridFilterPills
            options={OUTCOME_OPTIONS}
            value={filters.outcome ?? 'all'}
            onChange={(value) => updateFilters({ outcome: value === 'all' ? undefined : value })}
            testIdPrefix="workflow-evaluations-filter-outcome"
            data-testid="workflow-evaluations-filter-outcome"
            aria-label="Outcome"
          />
          <DataGridFilterDivider />
          <DataGridFilterSelect
            label="Stage"
            value={filters.stage ?? ''}
            onChange={(value) => updateFilters({ stage: value || undefined })}
            options={STAGE_OPTIONS}
            includeEmptyOption
            data-testid="workflow-evaluations-filter-stage"
          />
          <DataGridFilterSelect
            label="Reason code"
            value={filters.reason ?? ''}
            onChange={(value) => updateFilters({ reason: value || undefined })}
            options={REASON_OPTIONS}
            includeEmptyOption
            data-testid="workflow-evaluations-filter-reason"
          />
          <DataGridFilterSelect
            label="Subject type"
            value={filters.subjectType ?? ''}
            onChange={(value) => updateFilters({ subjectType: (value || undefined) as AdminEvaluationFilters['subjectType'] })}
            options={SUBJECT_OPTIONS}
            includeEmptyOption
            data-testid="workflow-evaluations-filter-subject-type"
          />
          <label className={styles.dateField}>
            <span className={styles.dateLabel}>From</span>
            <input
              type="date"
              className={styles.dateInput}
              value={filters.from ?? ''}
              onChange={(event) => updateFilters({ from: event.target.value || undefined })}
              {...{ 'data-testid': 'workflow-evaluations-filter-from' }}
            />
          </label>
          <label className={styles.dateField}>
            <span className={styles.dateLabel}>To</span>
            <input
              type="date"
              className={styles.dateInput}
              value={filters.to ?? ''}
              onChange={(event) => updateFilters({ to: event.target.value || undefined })}
              {...{ 'data-testid': 'workflow-evaluations-filter-to' }}
            />
          </label>
        </DataGridToolbar>

        {dateInvalid && (
          <p className={gridStyles.error} role="alert">Start date must be on or before the end date</p>
        )}

        {filters.eventId && (
          <div className={styles.chips}>
            <span className={styles.chip} {...{ 'data-testid': 'workflow-evaluations-event-chip' }}>
              Event {filters.eventId.slice(0, 8)}
              <button
                type="button"
                className={styles.chipRemove}
                aria-label="Remove event filter"
                onClick={() => updateFilters({ eventId: undefined })}
                {...{ 'data-testid': 'workflow-evaluations-event-chip-remove' }}
              >
                ×
              </button>
            </span>
          </div>
        )}

        {listQuery.isLoading && (
          <p className={gridStyles.loading} {...{ 'data-testid': 'workflow-evaluations-loading' }}>
            Loading workflow evaluations…
          </p>
        )}

        {listQuery.isError && (
          <div className={styles.errorRow} role="alert" {...{ 'data-testid': 'workflow-evaluations-error' }}>
            <span>Couldn&apos;t load workflow evaluations. {listQuery.error.message}</span>
            <button
              type="button"
              className={gridStyles.button}
              onClick={() => void listQuery.refetch()}
              {...{ 'data-testid': 'workflow-evaluations-retry' }}
            >
              Retry
            </button>
          </div>
        )}

        {listQuery.isSuccess && items.length === 0 && (
          filtered ? (
            <div className={styles.emptyRow} {...{ 'data-testid': 'workflow-evaluations-no-matches' }}>
              <span className={gridStyles.empty}>No events match the current filters.</span>
              <button
                type="button"
                className={gridStyles.button}
                onClick={() => {
                  setSearch('');
                  setSearchParams(new URLSearchParams(), { replace: true });
                }}
                {...{ 'data-testid': 'workflow-evaluations-clear-filters' }}
              >
                Clear filters
              </button>
            </div>
          ) : (
            <p className={gridStyles.empty} {...{ 'data-testid': 'workflow-evaluations-empty' }}>
              No feedback has been submitted for this project yet.
            </p>
          )
        )}

        {items.length > 0 && (
          <>
            <div className={gridStyles.tableWrap} {...{ 'data-testid': 'workflow-evaluations-table' }}>
              <table className={gridStyles.table}>
                <thead>
                  <tr>
                    <th scope="col">Event</th>
                    <th scope="col">Submitted</th>
                    <th scope="col">Stage</th>
                    <th scope="col">Subject</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Average score</th>
                    <th scope="col">Reviewer</th>
                    <th scope="col">Diagnostics</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((event) => (
                    <tr key={event.id} {...{ 'data-testid': `workflow-evaluation-row-${event.id}` }}>
                      <td className={styles.mono}>{event.id.slice(0, 8)}</td>
                      <td>{formatDateTime(event.createdAt)}</td>
                      <td>{event.stageLabel}</td>
                      <td className={styles.mono}>{subjectText(event)}</td>
                      <td>
                        <OutcomeBadge
                          outcome={event.outcome}
                          label={event.outcomeLabel}
                          data-testid={`workflow-evaluation-outcome-${event.id}`}
                        />
                      </td>
                      <td>{event.criteriaAverage.toFixed(1)} / 5</td>
                      <td>{event.reviewerDisplayName} · {event.reviewerRoleLabel}</td>
                      <td>
                        <div className={styles.badgeStack}>
                          {event.jobs.length === 0 && <span className={styles.muted}>None</span>}
                          {event.jobs.map((job) => (
                            <JobStatusBadge
                              key={job.evaluatorKey}
                              status={job.status}
                              prefix={EVALUATOR_LABELS[job.evaluatorKey]}
                              data-testid={`workflow-evaluation-job-${event.id}-${job.evaluatorKey}`}
                            />
                          ))}
                        </div>
                      </td>
                      <td>
                        <div className={gridStyles.rowActions}>
                          <button
                            type="button"
                            className={gridStyles.buttonGhost}
                            aria-label={`View details for event ${event.id.slice(0, 8)}`}
                            onClick={() => setDrawer(event.id)}
                            {...{ 'data-testid': `workflow-evaluation-view-${event.id}` }}
                          >
                            View details
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {listQuery.hasNextPage && (
              <div className={styles.loadMore}>
                <button
                  type="button"
                  className={gridStyles.button}
                  disabled={listQuery.isFetchingNextPage}
                  onClick={() => void listQuery.fetchNextPage()}
                  {...{ 'data-testid': 'workflow-evaluations-load-more' }}
                >
                  {listQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}

        {drawerEventId && (
          <WorkflowEvaluationDetailDrawer
            key={drawerEventId}
            projectId={selectedProject}
            eventId={drawerEventId}
            onClose={() => setDrawer(null)}
            data-testid="workflow-evaluation-drawer"
          />
        )}
      </section>
    </div>
  );
};

export default WorkflowEvaluationsPage;
