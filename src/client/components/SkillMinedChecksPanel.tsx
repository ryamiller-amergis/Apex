import React from 'react';
import grid from './DataGrid.module.css';
import healthStyles from './SkillHealthAdmin.module.css';
import styles from './SkillExperimentsPanel.module.css';
import { stageLabel } from './SkillHealthEvaluationPanel';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import { useDecideMinedCheck, useMinedChecks } from '../hooks/useSkillExperiments';
import type { SkillMinedCheck } from '../../shared/types/skillExperiment';

export function minedCheckStatusLabel(status: SkillMinedCheck['status']): string {
  switch (status) {
    case 'proposed':
      return 'Proposed';
    case 'accepted':
      return 'In the suite';
    case 'dismissed':
      return 'Dismissed';
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

function share(check: SkillMinedCheck): string {
  return check.share === null ? `${check.support}` : `${check.support} of ${check.corrections} (${Math.round(check.share * 100)}%)`;
}

/** Promptfoo checks proposed from reviewers' corrected text; a person accepts or dismisses each. */
export const SkillMinedChecksPanel: React.FC<{ project: string }> = ({ project }) => {
  const enabled = useFeatureFlag('skill-learning', project);
  const { data: checks = [], error } = useMinedChecks(project, enabled);
  const decide = useDecideMinedCheck(project);
  if (!enabled) return null;

  return (
    <section className={styles.panel} data-testid="skill-mined-checks">
      <h4 className={healthStyles.sectionTitle}>Checks learned from corrections</h4>
      <p className={grid.hint}>
        When most corrected documents of a stage add the same section, Apex proposes a Promptfoo check that
        requires it. Accepted checks run on every later review in {project}.
      </p>
      {error && <p className={styles.error}>{error.message}</p>}
      {decide.error && <p className={styles.error}>{decide.error.message}</p>}
      {checks.length === 0 ? (
        <p className={healthStyles.muted} data-testid="skill-mined-checks-empty">
          No pattern in reviewers&apos; corrections yet.
        </p>
      ) : (
        <div className={grid.tableWrap}>
          <table className={grid.table} data-testid="skill-mined-checks-table">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Required section</th>
                <th>Corrections with it</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((check) => {
                const id = `${check.stageKey}-${check.heading}`;
                return (
                  <tr key={id} data-testid={`skill-mined-check-${id}`}>
                    <td>{stageLabel(check.stageKey)}</td>
                    <td>## {check.heading}</td>
                    <td>{share(check)}</td>
                    <td>{minedCheckStatusLabel(check.status)}</td>
                    <td>
                      <div className={grid.rowActions}>
                        {check.status !== 'accepted' && (
                          <button
                            type="button"
                            className={grid.buttonGhost}
                            disabled={decide.isPending}
                            onClick={() => decide.mutate({ stageKey: check.stageKey, heading: check.heading, support: check.support, decision: 'accepted' })}
                            data-testid={`skill-mined-check-accept-${id}`}
                          >
                            Add to suite
                          </button>
                        )}
                        {check.status !== 'dismissed' && (
                          <button
                            type="button"
                            className={grid.buttonGhost}
                            disabled={decide.isPending}
                            onClick={() => decide.mutate({ stageKey: check.stageKey, heading: check.heading, support: check.support, decision: 'dismissed' })}
                            data-testid={`skill-mined-check-dismiss-${id}`}
                          >
                            {check.status === 'accepted' ? 'Remove' : 'Dismiss'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
