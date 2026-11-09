/**
 * Paired comparison of a candidate SKILL.md against the current one, and the promote / keep decision.
 * Pure: the experiment service passes scored runs in.
 */
import { createHash } from 'node:crypto';
import {
  WORKFLOW_EVALUATION_CRITERIA_KEYS,
  type WorkflowEvaluationCriteriaKey,
} from '../../shared/types/workflowEvaluation';
import type {
  SkillExperimentArm,
  SkillExperimentCriteriaScores,
  SkillExperimentResult,
  SkillExperimentSplit,
  SkillExperimentSplitResult,
} from '../../shared/types/skillExperiment';
import { meanInterval } from './skillLearningStats';

/** Share of cases held out from the candidate generator and checked separately. */
export const HOLDOUT_SHARE = 0.2;
/** Fewest scored dev pairs before any verdict other than insufficient_data. */
export const MIN_EXPERIMENT_PAIRS = 6;
/** Holdout may drop by at most this much on the 1–5 scale. */
export const MAX_HOLDOUT_DROP = 0.25;
/** No single criterion may drop by more than this. */
export const MAX_CRITERION_DROP = 0.5;
/** A difference smaller than this on the 1–5 scale counts as a tie. */
const TIE_MARGIN = 0.1;

export interface ScoredExperimentRun {
  caseKey: string;
  split: SkillExperimentSplit;
  arm: SkillExperimentArm;
  /** Null when the run failed before scoring. */
  overallScore: number | null;
  criteriaScores: SkillExperimentCriteriaScores | null;
  failed: boolean;
}

/** Stable split: the same case always lands in the same split, whoever starts the experiment. */
export function splitForCase(caseKey: string): SkillExperimentSplit {
  const bucket = parseInt(createHash('sha256').update(caseKey).digest('hex').slice(0, 8), 16) / 0xffffffff;
  return bucket < HOLDOUT_SHARE ? 'holdout' : 'dev';
}

/** Mean of the judge's criterion scores. */
export function overallFromCriteria(scores: SkillExperimentCriteriaScores): number {
  const values = WORKFLOW_EVALUATION_CRITERIA_KEYS.map((key) => scores[key]);
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function mean(values: readonly number[]): number | null {
  return values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

interface Pair {
  baseline: ScoredExperimentRun;
  candidate: ScoredExperimentRun;
}

function scoredPairs(runs: readonly ScoredExperimentRun[], split: SkillExperimentSplit): Pair[] {
  const byCase = new Map<string, Partial<Record<SkillExperimentArm, ScoredExperimentRun>>>();
  for (const run of runs) {
    if (run.split !== split || run.overallScore === null) continue;
    const entry = byCase.get(run.caseKey) ?? {};
    entry[run.arm] = run;
    byCase.set(run.caseKey, entry);
  }
  return [...byCase.values()].flatMap((entry) =>
    entry.baseline && entry.candidate ? [{ baseline: entry.baseline, candidate: entry.candidate }] : []);
}

export function splitResult(runs: readonly ScoredExperimentRun[], split: SkillExperimentSplit): SkillExperimentSplitResult {
  const pairs = scoredPairs(runs, split);
  const diffs = pairs.map((pair) => (pair.candidate.overallScore ?? 0) - (pair.baseline.overallScore ?? 0));
  return {
    pairs: pairs.length,
    baselineMean: mean(pairs.map((pair) => pair.baseline.overallScore ?? 0)),
    candidateMean: mean(pairs.map((pair) => pair.candidate.overallScore ?? 0)),
    meanDiff: mean(diffs),
    diffInterval: meanInterval(diffs),
    wins: diffs.filter((d) => d > TIE_MARGIN).length,
    losses: diffs.filter((d) => d < -TIE_MARGIN).length,
    ties: diffs.filter((d) => Math.abs(d) <= TIE_MARGIN).length,
  };
}

function criterionDiff(pairs: readonly Pair[], key: WorkflowEvaluationCriteriaKey): number | null {
  const diffs = pairs.flatMap((pair) =>
    pair.baseline.criteriaScores && pair.candidate.criteriaScores
      ? [pair.candidate.criteriaScores[key] - pair.baseline.criteriaScores[key]]
      : []);
  return mean(diffs);
}

function failureRate(runs: readonly ScoredExperimentRun[], arm: SkillExperimentArm): number | null {
  const armRuns = runs.filter((run) => run.arm === arm);
  if (armRuns.length === 0) return null;
  return armRuns.filter((run) => run.failed).length / armRuns.length;
}

const fmt = (value: number) => (value >= 0 ? `+${value.toFixed(2)}` : value.toFixed(2));

export function decideExperiment(runs: readonly ScoredExperimentRun[]): SkillExperimentResult {
  const dev = splitResult(runs, 'dev');
  const holdout = splitResult(runs, 'holdout');
  const allPairs = [...scoredPairs(runs, 'dev'), ...scoredPairs(runs, 'holdout')];
  const criteria = WORKFLOW_EVALUATION_CRITERIA_KEYS.map((key) => ({ key, meanDiff: criterionDiff(allPairs, key) }));
  const baselineFailureRate = failureRate(runs, 'baseline');
  const candidateFailureRate = failureRate(runs, 'candidate');
  const base = { dev, holdout, criteria, baselineFailureRate, candidateFailureRate };

  if (dev.pairs < MIN_EXPERIMENT_PAIRS || dev.meanDiff === null || dev.diffInterval === null) {
    return {
      ...base,
      verdict: 'insufficient_data',
      reasons: [`Only ${dev.pairs} dev cases were scored on both versions; ${MIN_EXPERIMENT_PAIRS} are needed.`],
    };
  }

  const reasons: string[] = [];
  let promote = true;
  if (dev.diffInterval.low > 0) {
    reasons.push(`Dev cases improved by ${fmt(dev.meanDiff)} (95% range ${fmt(dev.diffInterval.low)} to ${fmt(dev.diffInterval.high)}).`);
  } else {
    promote = false;
    reasons.push(dev.meanDiff > 0
      ? `Dev cases improved by ${fmt(dev.meanDiff)}, but the 95% range (${fmt(dev.diffInterval.low)} to ${fmt(dev.diffInterval.high)}) includes no change.`
      : `Dev cases did not improve (${fmt(dev.meanDiff)}).`);
  }

  if (holdout.meanDiff === null) {
    reasons.push('No holdout cases were scored on both versions, so the result could not be checked on unseen cases.');
  } else if (holdout.meanDiff < -MAX_HOLDOUT_DROP) {
    promote = false;
    reasons.push(`Holdout cases dropped by ${fmt(holdout.meanDiff)}: the change may only fit the cases it was written for.`);
  } else {
    reasons.push(`Holdout cases held up (${fmt(holdout.meanDiff)} over ${holdout.pairs}).`);
  }

  const dropped = criteria.filter((c) => c.meanDiff !== null && c.meanDiff < -MAX_CRITERION_DROP);
  if (dropped.length > 0) {
    promote = false;
    reasons.push(`Some criteria got worse: ${dropped.map((c) => `${c.key} ${fmt(c.meanDiff ?? 0)}`).join(', ')}.`);
  }

  if (candidateFailureRate !== null && baselineFailureRate !== null && candidateFailureRate > baselineFailureRate) {
    promote = false;
    reasons.push(`More runs failed with the candidate (${Math.round(candidateFailureRate * 100)}% vs ${Math.round(baselineFailureRate * 100)}%).`);
  }

  return { ...base, verdict: promote ? 'promote' : 'keep_current', reasons };
}
