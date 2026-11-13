import React from 'react';
import grid from './DataGrid.module.css';
import healthStyles from './SkillHealthAdmin.module.css';
import styles from './SkillExperimentsPanel.module.css';
import { stageLabel } from './SkillHealthEvaluationPanel';
import { minedCheckStatusLabel } from './SkillMinedChecksPanel';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import { useDecideSemanticCheck, useSemanticChecks, useSuggestSemanticChecks } from '../hooks/useSkillExperiments';
import type { SkillCheckMiningRun } from '../../shared/types/skillExperiment';

export function miningRunLabel(run: SkillCheckMiningRun | undefined): string {
  if (!run) return 'Never suggested';
  switch (run.status) {
    case 'running':
      return `Reading ${run.corrections} corrections…`;
    case 'completed':
      return `${run.proposals ?? 0} new from ${run.corrections} corrections`;
    case 'failed':
      return 'Last suggestion failed';
    default: {
      const unhandled: never = run.status;
      return unhandled;
    }
  }
}

/**
 * Plain-language checks an AI run suggests from reviewer corrections. Accepted ones are graded by
 * a model on every later review of that stage.
 */
export const SkillSemanticChecksPanel: React.FC<{ project: string }> = ({ project }) => {
  const enabled = useFeatureFlag('skill-learning', project);
  const { data, error } = useSemanticChecks(project, enabled);
  const suggest = useSuggestSemanticChecks(project);
  const decide = useDecideSemanticCheck(project);
  if (!enabled) return null;

  const checks = data?.checks ?? [];
  const runs = new Map((data?.latestRuns ?? []).map((run) => [run.stageKey, run]));

  return (
    <section className={styles.panel} data-testid="skill-semantic-checks">
      <h4 className={healthStyles.sectionTitle}>Meaning checks suggested from corrections</h4>
      <p className={grid.hint}>
        An AI run reads what reviewers changed and suggests checks such as &quot;every requirement has a measurable
        target&quot;. Each costs about ${(data?.estimatedCostUsd ?? 0).toFixed(2)} from the monthly budget. Accepted
        checks are graded by a model on every later review in {project}, up to {data?.maxAcceptedPerStage ?? 0} per stage.
      </p>
      {error && <p className={styles.error}>{error.message}</p>}
      {suggest.error && <p className={styles.error} data-testid="skill-semantic-suggest-error">{suggest.error.message}</p>}
      {decide.error && <p className={styles.error}>{decide.error.message}</p>}

      <div className={grid.tableWrap}>
        <table className={grid.table} data-testid="skill-semantic-stages-table">
          <thead>
            <tr>
              <th>Stage</th>
              <th>Last suggestion</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(data?.stageKeys ?? []).map((stageKey) => {
              const run = runs.get(stageKey);
              return (
                <tr key={stageKey} data-testid={`skill-semantic-stage-${stageKey}`}>
                  <td>{stageLabel(stageKey)}</td>
                  <td>
                    {miningRunLabel(run)}
                    {run?.status === 'failed' && run.error && <div className={healthStyles.muted}>{run.error}</div>}
                  </td>
                  <td>
                    <button
                      type="button"
                      className={grid.buttonGhost}
                      disabled={suggest.isPending || run?.status === 'running'}
                      onClick={() => suggest.mutate(stageKey)}
                      data-testid={`skill-semantic-suggest-${stageKey}`}
                    >
                      Suggest checks
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {checks.length === 0 ? (
        <p className={healthStyles.muted} data-testid="skill-semantic-checks-empty">No suggested checks yet.</p>
      ) : (
        <div className={grid.tableWrap}>
          <table className={grid.table} data-testid="skill-semantic-checks-table">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Check</th>
                <th>Corrections behind it</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((check) => (
                <tr key={check.id} data-testid={`skill-semantic-check-${check.id}`}>
                  <td>{stageLabel(check.stageKey)}</td>
                  <td>
                    {check.statement}
                    {check.rationale && <div className={healthStyles.muted}>{check.rationale}</div>}
                  </td>
                  <td>{check.support}</td>
                  <td>{minedCheckStatusLabel(check.status)}</td>
                  <td>
                    <div className={grid.rowActions}>
                      {check.status !== 'accepted' && (
                        <button
                          type="button"
                          className={grid.buttonGhost}
                          disabled={decide.isPending}
                          onClick={() => decide.mutate({ id: check.id, decision: 'accepted' })}
                          data-testid={`skill-semantic-check-accept-${check.id}`}
                        >
                          Add to suite
                        </button>
                      )}
                      {check.status !== 'dismissed' && (
                        <button
                          type="button"
                          className={grid.buttonGhost}
                          disabled={decide.isPending}
                          onClick={() => decide.mutate({ id: check.id, decision: 'dismissed' })}
                          data-testid={`skill-semantic-check-dismiss-${check.id}`}
                        >
                          {check.status === 'accepted' ? 'Remove' : 'Dismiss'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
