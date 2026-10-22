import React from 'react';
import grid from './DataGrid.module.css';
import styles from './SkillHealthAdmin.module.css';
import {
  WORKFLOW_EVALUATION_CRITERIA_KEYS,
  WORKFLOW_EVALUATION_CRITERION_LABELS,
  WORKFLOW_EVALUATION_OUTCOME_LABELS,
  type WorkflowEvaluationOutcome,
  type WorkflowEvaluationSubjectType,
} from '../../shared/types/workflowEvaluation';
import type {
  SkillHealthEvaluationSkill,
  SkillHealthJobCounts,
  SkillHealthJudgeRecommendation,
  SkillHealthProjectEvaluation,
  SkillHealthWorkItemTarget,
} from '../../shared/types/skillHealth';

export interface SkillHealthWorkItemDraft {
  skill: SkillHealthWorkItemTarget;
  title: string;
  description: string;
}

export const PROPOSED_CHANGE_PROMPT = 'Proposed SKILL.md change:\n<quote the current line and its replacement>';

/** `.cursor/skills/to-prd/SKILL.md` -> `to-prd`. */
export function skillNameOf(skillPath: string | null): string {
  if (!skillPath) return 'app default Skill';
  const parts = skillPath.split('/');
  return parts.length > 1 ? parts[parts.length - 2] : skillPath;
}

export function stageLabel(stageKey: string): string {
  if (stageKey === 'prd_human_review') return 'PRD review';
  if (stageKey === 'design_doc_human_review') return 'Design doc review';
  const phase = /^interview_phase_(\d+)$/.exec(stageKey);
  return phase ? `Interview phase ${phase[1]}` : stageKey;
}

function subjectLabel(subjectType: WorkflowEvaluationSubjectType): string {
  switch (subjectType) {
    case 'prd':
      return 'PRD';
    case 'interview_phase':
      return 'Interview';
    case 'design_doc':
      return 'Design doc';
    default: {
      const unreachable: never = subjectType;
      return unreachable;
    }
  }
}

function outcomeLabel(outcome: WorkflowEvaluationOutcome): string {
  return WORKFLOW_EVALUATION_OUTCOME_LABELS.find((o) => o.key === outcome)?.label ?? outcome;
}

function score(value: number | null): string {
  return value === null ? '—' : value.toFixed(1);
}

function jobSummary(counts: SkillHealthJobCounts, readyLabel: string): string {
  const open = counts.pending + counts.running;
  return `${counts.ready} ${readyLabel} · ${counts.failed} failed${open > 0 ? ` · ${open} in progress` : ''}`;
}

function draftForRecommendation(
  project: string,
  skill: SkillHealthEvaluationSkill,
  recommendation: SkillHealthJudgeRecommendation,
): SkillHealthWorkItemDraft {
  return {
    skill: {
      project,
      artifactKind: skill.subjectType === 'interview_phase' ? 'interview' : skill.subjectType,
      skillPath: skill.skillPath,
    },
    title: `Skill Health: ${skillNameOf(skill.skillPath)} — judge recommendation (${project})`,
    description: [
      `The LLM judge recommended this after ${stageLabel(recommendation.stageKey)} feedback in ${project} ` +
        `on ${recommendation.createdAt.slice(0, 10)}` +
        `${recommendation.criterion ? ` (criterion: ${recommendation.criterion})` : ''}:`,
      recommendation.text,
      `Human feedback on this Skill: ${skill.events} events, average ${score(skill.averageScore)} of 5.`,
      PROPOSED_CHANGE_PROMPT,
    ].join('\n\n'),
  };
}

/** Compact human-feedback summary for one Skill, shown in the Skill's detail view. */
export const SkillFeedbackSummary: React.FC<{ feedback: SkillHealthEvaluationSkill | null }> = ({ feedback }) => (
  <section className={styles.card} data-testid="skill-health-feedback-summary">
    <h4 className={styles.cardTitle}>Human feedback</h4>
    {!feedback ? (
      <p className={styles.muted}>No feedback on this Skill in this period.</p>
    ) : (
      <div className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Events</span>
          <span className={styles.statValue}>{feedback.events}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Average (1–5)</span>
          <span className={styles.statValue}>{score(feedback.averageScore)}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Regenerate or reject</span>
          <span className={styles.statValue}>{feedback.outcomes.regenerate + feedback.outcomes.reject}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Promptfoo failed</span>
          <span className={styles.statValue}>{feedback.promptfoo.failed}</span>
        </div>
      </div>
    )}
  </section>
);

interface SkillHealthEvaluationPanelProps {
  project: string;
  evaluation: SkillHealthProjectEvaluation | null;
  onCreateWorkItem: (draft: SkillHealthWorkItemDraft) => void;
}

/** Human workflow evaluation results for one project: stages, flagged events and per-Skill feedback. */
export const SkillHealthEvaluationPanel: React.FC<SkillHealthEvaluationPanelProps> = ({
  project,
  evaluation,
  onCreateWorkItem,
}) => {
  if (!evaluation) {
    return (
      <p className={grid.hint} data-testid="skill-health-evaluation-off">
        Human feedback (Workflow evaluations) is off for {project}. Turn on the workflow-human-evaluation flag for
        this project to collect it.
      </p>
    );
  }

  return (
    <div className={styles.evaluation} data-testid="skill-health-evaluation">
      <h4 className={styles.sectionTitle}>Human feedback</h4>
      {evaluation.events === 0 ? (
        <p className={styles.muted}>No feedback has been submitted in {project} in this period.</p>
      ) : (
        <>
          <section className={styles.card}>
            <h4 className={styles.cardTitle}>By stage</h4>
            <table className={styles.versionTable} data-testid="skill-health-evaluation-stages">
              <thead>
                <tr>
                  <th scope="col">Stage</th>
                  <th scope="col">Events</th>
                  {WORKFLOW_EVALUATION_OUTCOME_LABELS.map((outcome) => (
                    <th scope="col" key={outcome.key}>
                      {outcome.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {evaluation.stages.map((stage) => (
                  <tr key={stage.stageKey} data-testid={`skill-health-evaluation-stage-${stage.stageKey}`}>
                    <td>{stageLabel(stage.stageKey)}</td>
                    <td>{stage.events}</td>
                    {WORKFLOW_EVALUATION_OUTCOME_LABELS.map((outcome) => (
                      <td key={outcome.key}>{stage.outcomes[outcome.key]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className={styles.card}>
            <h4 className={styles.cardTitle}>Needs attention</h4>
            {evaluation.flagged.length === 0 ? (
              <p className={styles.muted}>No regenerate or reject outcomes in this period.</p>
            ) : (
              <ul className={styles.gapList} data-testid="skill-health-evaluation-flagged">
                {evaluation.flagged.map((event) => (
                  <li key={event.eventId}>
                    <div className={styles.gapHeader}>
                      <span>
                        {outcomeLabel(event.outcome)} · {stageLabel(event.stageKey)}
                      </span>
                      <span className={styles.gapMeta}>
                        {skillNameOf(event.skillPath)} · {event.createdAt.slice(0, 10)}
                      </span>
                    </div>
                    {event.commentExcerpt && <p className={styles.gapSamples}>{event.commentExcerpt}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {evaluation.skills.map((skill) => (
            <section
              key={skill.key}
              className={styles.card}
              data-testid={`skill-health-evaluation-skill-${skill.key}`}
            >
              <div className={styles.cardHeader}>
                <h4 className={styles.cardTitle}>
                  {skillNameOf(skill.skillPath)}{' '}
                  <span className={styles.gapMeta}>
                    {subjectLabel(skill.subjectType)} · {skill.events} events · average {score(skill.averageScore)}
                  </span>
                </h4>
              </div>
              <div className={styles.stats}>
                {WORKFLOW_EVALUATION_CRITERIA_KEYS.map((criterion) => (
                  <div className={styles.stat} key={criterion}>
                    <span className={styles.statLabel}>{WORKFLOW_EVALUATION_CRITERION_LABELS[criterion]}</span>
                    <span className={styles.statValue}>{score(skill.criteriaAverages[criterion])}</span>
                  </div>
                ))}
              </div>
              <p className={grid.hint}>
                Promptfoo: {jobSummary(skill.promptfoo, 'passed')} · Judge: {jobSummary(skill.judge, 'ready')}
              </p>
              {skill.recommendations.length === 0 ? (
                <p className={styles.muted}>No judge recommendations yet.</p>
              ) : (
                <ul className={styles.gapList}>
                  {skill.recommendations.map((recommendation, index) => (
                    <li key={`${recommendation.eventId}-${index}`}>
                      <div className={styles.gapHeader}>
                        <span>{recommendation.text}</span>
                        <button
                          type="button"
                          className={grid.buttonGhost}
                          onClick={() => onCreateWorkItem(draftForRecommendation(project, skill, recommendation))}
                          data-testid={`skill-health-recommendation-work-item-${recommendation.eventId}-${index}`}
                        >
                          Create work item
                        </button>
                      </div>
                      <span className={styles.gapMeta}>
                        {stageLabel(recommendation.stageKey)} · {recommendation.createdAt.slice(0, 10)}
                        {recommendation.criterion ? ` · ${recommendation.criterion}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </>
      )}
    </div>
  );
};
