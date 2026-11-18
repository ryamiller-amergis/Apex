import React, { useState } from 'react';
import {
  SKILL_REGRESSION_CASE_REASON_LABELS,
  SKILL_REGRESSION_SNAPSHOT_STATUS_LABELS,
  SKILL_REGRESSION_STATUS_REASON_MAX,
  type SkillRegressionBackfillResult,
  type SkillRegressionCase,
  type SkillRegressionCaseStatus,
} from '../../shared/types/skillRegressionCase';
import {
  WORKFLOW_EVALUATION_CRITERION_LABELS,
  type WorkflowEvaluationCriteriaKey,
} from '../../shared/types/workflowEvaluation';
import { workflowEvaluationStageLabel } from '../../shared/types/workflowEvaluationAdmin';
import {
  useBackfillSkillRegressionCases,
  useSkillRegressionCases,
  useUpdateSkillRegressionCase,
} from '../hooks/useWorkflowEvaluationsAdmin';
import gridStyles from './DataGrid.module.css';
import styles from './WorkflowRegressionCasesPanel.module.css';

export interface WorkflowRegressionCasesPanelProps {
  project: string;
  'data-testid'?: string;
}

type StatusFilter = '' | SkillRegressionCaseStatus;

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function criterionLabel(key: string): string {
  return WORKFLOW_EVALUATION_CRITERION_LABELS[key as WorkflowEvaluationCriteriaKey] ?? key;
}

function skillName(skillPath: string | null): string {
  if (!skillPath) return 'Unknown skill';
  const parts = skillPath.split('/');
  return parts.length >= 2 && parts[parts.length - 1] === 'SKILL.md' ? parts[parts.length - 2] : skillPath;
}

function backfillMessage(result: SkillRegressionBackfillResult): string {
  const parts = [
    `${result.created} new case${result.created === 1 ? '' : 's'}`,
    `${result.stored} cop${result.stored === 1 ? 'y' : 'ies'} saved`,
  ];
  if (result.artifactChanged > 0) parts.push(`${result.artifactChanged} changed before a copy could be saved`);
  if (result.failed > 0) parts.push(`${result.failed} failed`);
  if (result.remaining > 0) parts.push(`${result.remaining} still waiting. Run it again to continue`);
  return `${parts.join(', ')}.`;
}

export const WorkflowRegressionCasesPanel: React.FC<WorkflowRegressionCasesPanelProps> = ({
  project,
  'data-testid': testId = 'workflow-regression-cases',
}) => {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<StatusFilter>('active');
  const [skillPath, setSkillPath] = useState('');
  const [retiringId, setRetiringId] = useState<string | null>(null);
  const [retireReason, setRetireReason] = useState('');
  const [backfillStatus, setBackfillStatus] = useState('');

  const casesQuery = useSkillRegressionCases(
    project,
    { ...(status ? { status } : {}), ...(skillPath ? { skillPath } : {}) },
    open,
  );
  const updateCase = useUpdateSkillRegressionCase(project);
  const backfill = useBackfillSkillRegressionCases(project);
  const list = casesQuery.data;

  const startRetire = (id: string) => {
    updateCase.reset();
    setRetiringId(id);
    setRetireReason('');
  };

  const confirmRetire = (id: string) => {
    updateCase.mutate(
      { caseId: id, update: { status: 'retired', reason: retireReason.trim() } },
      { onSuccess: () => setRetiringId(null) },
    );
  };

  const restore = (id: string) => {
    updateCase.mutate({ caseId: id, update: { status: 'active' } });
  };

  const runBackfill = () => {
    setBackfillStatus('Adding past reviews…');
    backfill.mutate(undefined, {
      onSuccess: (result) => setBackfillStatus(backfillMessage(result)),
      onError: (error) => setBackfillStatus(`Could not add past reviews: ${error.message}`),
    });
  };

  const renderAction = (entry: SkillRegressionCase) => {
    if (entry.status === 'retired') {
      return (
        <div className={styles.actionCell}>
          <span className={styles.statusReason}>
            Retired{entry.statusChangedByName ? ` by ${entry.statusChangedByName}` : ''}: {entry.statusReason}
          </span>
          <button
            type="button"
            className={gridStyles.button}
            disabled={updateCase.isPending}
            onClick={() => restore(entry.id)}
            {...{ 'data-testid': `workflow-regression-case-restore-${entry.id}` }}
          >
            Restore
          </button>
        </div>
      );
    }
    if (retiringId === entry.id) {
      const reasonId = `regression-retire-reason-${entry.id}`;
      return (
        <div className={styles.actionCell}>
          <label className={styles.srOnly} htmlFor={reasonId}>Reason for retiring</label>
          <input
            id={reasonId}
            className={styles.input}
            value={retireReason}
            maxLength={SKILL_REGRESSION_STATUS_REASON_MAX}
            placeholder="Why should this case not count?"
            onChange={(event) => setRetireReason(event.target.value)}
            {...{ 'data-testid': `workflow-regression-case-retire-reason-${entry.id}` }}
          />
          <div className={styles.actionButtons}>
            <button
              type="button"
              className={gridStyles.button}
              disabled={!retireReason.trim() || updateCase.isPending}
              onClick={() => confirmRetire(entry.id)}
              {...{ 'data-testid': `workflow-regression-case-retire-confirm-${entry.id}` }}
            >
              Retire
            </button>
            <button
              type="button"
              className={gridStyles.button}
              onClick={() => setRetiringId(null)}
              {...{ 'data-testid': `workflow-regression-case-retire-cancel-${entry.id}` }}
            >
              Cancel
            </button>
          </div>
        </div>
      );
    }
    return (
      <button
        type="button"
        className={gridStyles.button}
        onClick={() => startRetire(entry.id)}
        {...{ 'data-testid': `workflow-regression-case-retire-${entry.id}` }}
      >
        Retire
      </button>
    );
  };

  return (
    <section className={styles.panel} {...{ 'data-testid': testId }}>
      <div className={styles.header}>
        <div>
          <h3 className={styles.title}>Regression cases</h3>
          <p className={gridStyles.hint}>
            Reviews that scored a question 2 or lower, or were accepted after edits with corrected text.
            Active cases feed the monthly skill review.
          </p>
        </div>
        <div className={styles.headerControls}>
          {open && (
            <>
              <label className={styles.field}>
                <span className={styles.label}>Status</span>
                <select
                  className={styles.select}
                  value={status}
                  onChange={(event) => setStatus(event.target.value as StatusFilter)}
                  {...{ 'data-testid': 'workflow-regression-cases-status' }}
                >
                  <option value="active">Active</option>
                  <option value="retired">Retired</option>
                  <option value="">All</option>
                </select>
              </label>
              <label className={styles.field}>
                <span className={styles.label}>Skill</span>
                <select
                  className={styles.select}
                  value={skillPath}
                  onChange={(event) => setSkillPath(event.target.value)}
                  {...{ 'data-testid': 'workflow-regression-cases-skill' }}
                >
                  <option value="">All skills</option>
                  {(list?.skillPaths ?? []).map((path) => (
                    <option key={path} value={path}>{skillName(path)}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className={gridStyles.button}
                disabled={backfill.isPending}
                onClick={runBackfill}
                {...{ 'data-testid': 'workflow-regression-cases-backfill' }}
              >
                Add past reviews
              </button>
            </>
          )}
          <button
            type="button"
            className={gridStyles.button}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            {...{ 'data-testid': 'workflow-regression-cases-toggle' }}
          >
            {open ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      <p className={styles.srOnly} aria-live="polite">{backfillStatus}</p>
      {open && backfillStatus && (
        <p className={gridStyles.hint} {...{ 'data-testid': 'workflow-regression-cases-backfill-status' }}>
          {backfillStatus}
        </p>
      )}
      {open && updateCase.isError && (
        <p className={gridStyles.error} role="alert">
          Could not update the case: {updateCase.error.message}
        </p>
      )}

      {open && casesQuery.isLoading && <p className={gridStyles.loading}>Loading cases…</p>}
      {open && casesQuery.isError && (
        <p className={gridStyles.error} role="alert">
          Could not load cases: {casesQuery.error.message}
        </p>
      )}

      {open && list && (
        list.cases.length === 0 ? (
          <p className={gridStyles.hint}>No cases match these filters.</p>
        ) : (
          <div className={gridStyles.tableWrap}>
            <table className={gridStyles.table} {...{ 'data-testid': 'workflow-regression-cases-table' }}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Stage</th>
                  <th>Skill</th>
                  <th>Why</th>
                  <th>Low scores</th>
                  <th>Comment</th>
                  <th>Reviewer</th>
                  <th>Document copy</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {list.cases.map((entry) => (
                  <tr key={entry.id} {...{ 'data-testid': `workflow-regression-case-${entry.id}` }}>
                    <td>{formatDate(entry.createdAt)}</td>
                    <td>{workflowEvaluationStageLabel(entry.stageKey)}</td>
                    <td title={entry.skillPath ?? undefined}>{skillName(entry.skillPath)}</td>
                    <td>{SKILL_REGRESSION_CASE_REASON_LABELS[entry.reason]}</td>
                    <td>{entry.lowCriteria.map(criterionLabel).join(', ') || '—'}</td>
                    <td className={styles.comment}>{entry.comment ?? '—'}</td>
                    <td>{entry.reviewerName ?? 'Unknown'}</td>
                    <td>{SKILL_REGRESSION_SNAPSHOT_STATUS_LABELS[entry.snapshotStatus]}</td>
                    <td>{renderAction(entry)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {list.cases.length >= list.limit && (
              <p className={gridStyles.hint}>Showing the newest {list.limit}. Filter by skill to see more.</p>
            )}
          </div>
        )
      )}
    </section>
  );
};
