import React, { useEffect, useState } from 'react';
import grid from './DataGrid.module.css';
import healthStyles from './SkillHealthAdmin.module.css';
import styles from './SkillExperimentsPanel.module.css';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import {
  useCandidateFrontier,
  useReplayableSkills,
  useSetSkillLearningBudget,
  useSkillExperiment,
  useSkillExperimentAction,
  useSkillExperiments,
  useSkillLearningSettings,
  useStartSkillExperiment,
} from '../hooks/useSkillExperiments';
import type {
  SkillCandidateFrontierEntry,
  SkillExperimentResult,
  SkillExperimentSplitResult,
  SkillExperimentStatus,
  SkillExperimentSummary,
  SkillExperimentVerdict,
  SkillPostReleaseReport,
  SkillPostReleaseStatus,
} from '../../shared/types/skillExperiment';

export function experimentStatusLabel(status: SkillExperimentStatus): string {
  switch (status) {
    case 'drafting':
      return 'Drafting the candidate';
    case 'running':
      return 'Running';
    case 'completed':
      return 'Finished';
    case 'awaiting_approval':
      return 'Waiting for approval';
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Rejected';
    case 'promoted':
      return 'Pull request open';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

export function verdictLabel(verdict: SkillExperimentVerdict): string {
  switch (verdict) {
    case 'promote':
      return 'Better — ready to approve';
    case 'keep_current':
      return 'Keep the current Skill';
    case 'insufficient_data':
      return 'Not enough cases to tell';
    default: {
      const unhandled: never = verdict;
      return unhandled;
    }
  }
}

/** "+0.42 (0.10 to 0.74)" on the 1–5 judge scale, or a dash. */
export function scoreChange(split: SkillExperimentSplitResult): string {
  if (split.meanDiff === null) return '—';
  const signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
  const range = split.diffInterval ? ` (${signed(split.diffInterval.low)} to ${signed(split.diffInterval.high)})` : '';
  return `${signed(split.meanDiff)}${range}`;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function skillLabel(skillPath: string): string {
  const parts = skillPath.split('/').filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : skillPath;
}

const BudgetEditor: React.FC<{ project: string }> = ({ project }) => {
  const { data: settings } = useSkillLearningSettings(project, true);
  const save = useSetSkillLearningBudget(project);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    setDraft(settings?.monthlyBudgetUsd == null ? '' : String(settings.monthlyBudgetUsd));
  }, [settings?.monthlyBudgetUsd]);

  if (!settings) return null;
  const parsed = draft.trim() === '' ? null : Number(draft);
  const invalid = parsed !== null && (!Number.isFinite(parsed) || parsed < 0);

  return (
    <div className={styles.row} data-testid="skill-experiments-budget">
      <label className={styles.field}>
        Monthly budget (USD) — empty turns experiments off
        <input
          className={styles.input}
          type="number"
          min={0}
          step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          data-testid="skill-experiments-budget-input"
        />
      </label>
      <button
        type="button"
        className={grid.button}
        disabled={invalid || save.isPending}
        onClick={() => save.mutate(parsed)}
        data-testid="skill-experiments-budget-save"
      >
        Save
      </button>
      <span className={healthStyles.gapMeta} data-testid="skill-experiments-budget-spent">
        {settings.monthlyBudgetUsd === null
          ? 'Off for this project'
          : `${usd(settings.spentThisMonthUsd)} of ${usd(settings.monthlyBudgetUsd)} used this month (estimated)`}
      </span>
      {save.error && <span className={styles.error}>{save.error.message}</span>}
    </div>
  );
};

const CandidateFrontier: React.FC<{
  project: string;
  skillPath: string;
  onUse: (entry: SkillCandidateFrontierEntry) => void;
}> = ({ project, skillPath, onUse }) => {
  const { data: entries = [] } = useCandidateFrontier(project, skillPath);
  if (entries.length === 0) return null;
  return (
    <div className={styles.field} data-testid="skill-experiments-frontier">
      Best candidates so far — none is beaten on every measure by another
      <ul className={styles.reasons}>
        {entries.map((entry) => (
          <li key={entry.experimentId}>
            {verdictLabel(entry.verdict)}, score change {entry.devMeanDiff == null ? '—' : entry.devMeanDiff.toFixed(2)}
            {entry.changeNotes ? ` — ${entry.changeNotes.split('\n')[0]}` : ''}{' '}
            <button
              type="button"
              className={grid.buttonGhost}
              onClick={() => onUse(entry)}
              data-testid="skill-experiments-frontier-use"
            >
              Start from this
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};

const StartForm: React.FC<{ project: string; onStarted: (id: string) => void }> = ({ project, onStarted }) => {
  const { data: skills = [] } = useReplayableSkills(project, true);
  const start = useStartSkillExperiment(project);
  const [skillKey, setSkillKey] = useState('');
  const [candidate, setCandidate] = useState('');
  const [notes, setNotes] = useState('');
  const [maxCases, setMaxCases] = useState('20');

  const selected = skills.find((s) => `${s.subjectType}:${s.skillPath}` === skillKey) ?? skills[0] ?? null;

  if (skills.length === 0) {
    return (
      <p className={healthStyles.muted} data-testid="skill-experiments-no-skills">
        No PRD or design doc runs on the new document worker in the last 90 days, so there is nothing to replay yet.
      </p>
    );
  }

  return (
    <form
      className={styles.panel}
      onSubmit={(e) => {
        e.preventDefault();
        if (!selected) return;
        start.mutate(
          {
            subjectType: selected.subjectType,
            skillPath: selected.skillPath,
            candidateContent: candidate.trim() ? candidate : undefined,
            changeNotes: notes.trim() || undefined,
            maxCases: Number(maxCases) || undefined,
          },
          { onSuccess: (created) => onStarted(created.id) },
        );
      }}
      data-testid="skill-experiments-start"
    >
      <div className={styles.row}>
        <label className={styles.field}>
          Skill
          <select
            className={styles.input}
            value={selected ? `${selected.subjectType}:${selected.skillPath}` : ''}
            onChange={(e) => setSkillKey(e.target.value)}
            data-testid="skill-experiments-skill"
          >
            {skills.map((s) => (
              <option key={`${s.subjectType}:${s.skillPath}`} value={`${s.subjectType}:${s.skillPath}`}>
                {skillLabel(s.skillPath)} ({s.subjectType === 'prd' ? 'PRD' : 'design doc'}, {s.runs} runs)
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          Most cases
          <input
            className={styles.input}
            type="number"
            min={8}
            max={60}
            value={maxCases}
            onChange={(e) => setMaxCases(e.target.value)}
            data-testid="skill-experiments-max-cases"
          />
        </label>
      </div>
      <label className={styles.field}>
        New SKILL.md — leave empty to have Apex draft one from recent failures
        <textarea
          className={styles.textarea}
          value={candidate}
          onChange={(e) => setCandidate(e.target.value)}
          data-testid="skill-experiments-candidate"
        />
      </label>
      {selected && (
        <CandidateFrontier
          project={project}
          skillPath={selected.skillPath}
          onUse={(entry) => {
            setCandidate(entry.candidateContent);
            setNotes(entry.changeNotes ?? '');
          }}
        />
      )}
      <label className={styles.field}>
        What changed (optional)
        <input
          className={`${styles.input} ${styles.wide}`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          data-testid="skill-experiments-notes"
        />
      </label>
      <div className={styles.row}>
        <button
          type="submit"
          className={grid.buttonPrimary}
          disabled={start.isPending || !selected}
          data-testid="skill-experiments-start-button"
        >
          {start.isPending ? 'Starting…' : 'Run experiment'}
        </button>
        {start.error && (
          <span className={styles.error} data-testid="skill-experiments-start-error">
            {start.error.message}
          </span>
        )}
      </div>
    </form>
  );
};

const ResultView: React.FC<{ result: SkillExperimentResult }> = ({ result }) => (
  <div className={styles.panel} data-testid="skill-experiment-result">
    <span className={styles[`verdict-${result.verdict}`]}>{verdictLabel(result.verdict)}</span>
    <div className={healthStyles.stats}>
      <div className={healthStyles.stat}>
        <span className={healthStyles.statLabel}>Dev cases change (1–5)</span>
        <span className={healthStyles.statValue}>{scoreChange(result.dev)}</span>
      </div>
      <div className={healthStyles.stat}>
        <span className={healthStyles.statLabel}>Holdout cases change</span>
        <span className={healthStyles.statValue}>{scoreChange(result.holdout)}</span>
      </div>
      <div className={healthStyles.stat}>
        <span className={healthStyles.statLabel}>Wins / losses / ties</span>
        <span className={healthStyles.statValue}>
          {result.dev.wins} / {result.dev.losses} / {result.dev.ties}
        </span>
      </div>
    </div>
    <ul className={styles.reasons}>
      {result.reasons.map((reason) => (
        <li key={reason}>{reason}</li>
      ))}
    </ul>
  </div>
);

export function postReleaseStatusLabel(status: SkillPostReleaseStatus): string {
  switch (status) {
    case 'waiting':
      return 'No live documents use the new Skill yet. Merge the pull request to start.';
    case 'collecting':
      return 'Collecting live documents.';
    case 'holding':
      return 'The new Skill is not doing worse in live use.';
    case 'regressed':
      return 'The new Skill is doing worse in live use. Consider reverting the pull request.';
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

function armValue(value: number | null, range: { low: number; high: number } | null): string {
  if (value == null) return '—';
  return range ? `${value} (${range.low}–${range.high})` : String(value);
}

const PostReleaseView: React.FC<{ report: SkillPostReleaseReport }> = ({ report }) => (
  <div className={styles.panel} data-testid="skill-experiment-post-release">
    <div className={healthStyles.statLabel}>Live use since promotion</div>
    <p className={report.status === 'regressed' ? styles.error : healthStyles.muted}>
      {postReleaseStatusLabel(report.status)}
    </p>
    <table className={grid.table}>
      <thead>
        <tr>
          <th>Version</th>
          <th>Documents</th>
          <th>Average score</th>
          <th>Accepted</th>
        </tr>
      </thead>
      <tbody>
        {([['Old Skill', report.baseline], ['New Skill', report.candidate]] as const).map(([label, arm]) => (
          <tr key={label}>
            <td>{label}</td>
            <td>{arm.documents}{arm.documents < report.minimumDocuments ? ' (too few)' : ''}</td>
            <td>{armValue(arm.averageScore, arm.scoreInterval)}</td>
            <td>{armValue(arm.acceptanceRate, arm.acceptanceInterval)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const ExperimentDetail: React.FC<{ project: string; id: string }> = ({ project, id }) => {
  const { data: detail, isLoading, error } = useSkillExperiment(project, id);
  if (isLoading) return <p className={healthStyles.muted}>Loading experiment…</p>;
  if (error || !detail) return <p className={styles.error}>{error?.message ?? 'Experiment not found'}</p>;

  return (
    <div className={styles.panel} data-testid="skill-experiment-detail">
      <h4 className={healthStyles.sectionTitle}>
        {skillLabel(detail.skillPath)} — {experimentStatusLabel(detail.status)}
      </h4>
      {detail.changeNotes && <p className={grid.hint}>{detail.changeNotes}</p>}
      {detail.error && (
        <p className={healthStyles.warning} data-testid="skill-experiment-error">{detail.error}</p>
      )}
      {detail.result ? (
        <ResultView result={detail.result} />
      ) : detail.status === 'drafting' ? (
        <p className={healthStyles.muted}>Apex is drafting the candidate from past failures. Replays start when it is ready.</p>
      ) : (
        <p className={healthStyles.muted}>
          {detail.runsScored} of {detail.cases * 2} replays scored so far.
        </p>
      )}
      {detail.pullRequestUrl && (
        <a href={detail.pullRequestUrl} target="_blank" rel="noreferrer" data-testid="skill-experiment-pr-link">
          Open the pull request
        </a>
      )}
      {detail.postRelease && <PostReleaseView report={detail.postRelease} />}
      <div className={styles.diff} data-testid="skill-experiment-diff">
        <div>
          <div className={healthStyles.statLabel}>Current Skill</div>
          <pre className={styles.skillText}>{detail.baselineContent}</pre>
        </div>
        <div>
          <div className={healthStyles.statLabel}>
            Candidate ({detail.candidateSource === 'reflective' ? 'drafted by Apex' : 'written by hand'})
          </div>
          <pre className={styles.skillText}>{detail.candidateContent ?? 'Not drafted yet.'}</pre>
        </div>
      </div>
      <div className={grid.tableWrap}>
        <table className={grid.table} data-testid="skill-experiment-runs">
          <thead>
            <tr>
              <th>Case</th>
              <th>Kind</th>
              <th>Split</th>
              <th>Skill</th>
              <th>Status</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {detail.runs.map((run) => (
              <tr key={run.id}>
                <td>{run.caseKey.slice(0, 8)}</td>
                <td>{run.caseKind === 'failure' ? 'Past failure' : 'Past success'}</td>
                <td>{run.split === 'holdout' ? 'Holdout' : 'Dev'}</td>
                <td>{run.arm === 'baseline' ? 'Current' : 'Candidate'}</td>
                <td title={run.error ?? undefined}>{run.status}</td>
                <td>{run.overallScore === null ? '—' : run.overallScore.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

function initialExperimentId(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('experiment');
}

/** Replays a candidate SKILL.md against the current one on past cases, then gates the change on approval. */
export const SkillExperimentsPanel: React.FC<{ project: string }> = ({ project }) => {
  const enabled = useFeatureFlag('skill-learning', project);
  const { data: experiments = [], error } = useSkillExperiments(project, enabled);
  const action = useSkillExperimentAction(project);
  const [selected, setSelectedId] = useState<string | null>(initialExperimentId);

  if (!enabled) return null;

  const actions = (experiment: SkillExperimentSummary) => (
    <div className={grid.rowActions}>
      <button
        type="button"
        className={grid.buttonGhost}
        onClick={() => setSelectedId(experiment.id)}
        data-testid={`skill-experiment-view-${experiment.id}`}
      >
        View
      </button>
      {(experiment.status === 'drafting' || experiment.status === 'running') && (
        <button
          type="button"
          className={grid.buttonGhost}
          disabled={action.isPending}
          onClick={() => action.mutate({ id: experiment.id, action: 'cancel' })}
          data-testid={`skill-experiment-cancel-${experiment.id}`}
        >
          Cancel
        </button>
      )}
      {experiment.status === 'approved' && !experiment.pullRequestUrl && (
        <button
          type="button"
          className={grid.buttonGhost}
          disabled={action.isPending}
          onClick={() => action.mutate({ id: experiment.id, action: 'retry-promotion' })}
          data-testid={`skill-experiment-retry-${experiment.id}`}
        >
          Retry pull request
        </button>
      )}
    </div>
  );

  return (
    <section className={styles.panel} data-testid="skill-experiments">
      <h3 className={healthStyles.sectionTitle}>Skill experiments</h3>
      <p className={grid.hint}>
        Replays past PRD or design doc runs with the current Skill and a candidate, on the same inputs, and has the
        judge score both. A candidate that wins goes to an approval Playbook; approval opens a pull request.
      </p>
      <BudgetEditor project={project} />
      {/* data-testid-exempt — the form root carries skill-experiments-start */}
      <StartForm project={project} onStarted={setSelectedId} />
      {error && <p className={styles.error}>{error.message}</p>}
      {action.error && <p className={styles.error}>{action.error.message}</p>}
      {experiments.length > 0 && (
        <div className={grid.tableWrap}>
          <table className={grid.table} data-testid="skill-experiments-table">
            <thead>
              <tr>
                <th>Skill</th>
                <th>Status</th>
                <th>Cases</th>
                <th>Dev change</th>
                <th>Holdout change</th>
                <th>Cost (est.)</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {experiments.map((experiment) => (
                <tr
                  key={experiment.id}
                  className={experiment.id === selected ? healthStyles.selectedRow : undefined}
                  data-testid={`skill-experiment-row-${experiment.id}`}
                >
                  <td className={healthStyles.skillPath}>{skillLabel(experiment.skillPath)}</td>
                  <td>{experimentStatusLabel(experiment.status)}</td>
                  <td>
                    {experiment.cases} ({experiment.runsScored} scored, {experiment.runsFailed} failed)
                  </td>
                  <td>{experiment.result ? scoreChange(experiment.result.dev) : '—'}</td>
                  <td>{experiment.result ? scoreChange(experiment.result.holdout) : '—'}</td>
                  <td>{usd(experiment.spentUsd)}</td>
                  <td>{actions(experiment)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && <ExperimentDetail project={project} id={selected} />}
    </section>
  );
};
