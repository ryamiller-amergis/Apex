/**
 * Skill experiments: replay saved cases with the current SKILL.md and a candidate, score both
 * with the blind judge, and decide whether the candidate is better.
 */
import type { WorkflowEvaluationCriteriaKey } from './workflowEvaluation';

/** Subjects a replay can regenerate. Interview phases are conversations and cannot be replayed. */
export const SKILL_EXPERIMENT_SUBJECT_TYPES = ['prd', 'design_doc'] as const;
export type SkillExperimentSubjectType = (typeof SKILL_EXPERIMENT_SUBJECT_TYPES)[number];

export function isSkillExperimentSubjectType(value: unknown): value is SkillExperimentSubjectType {
  return (SKILL_EXPERIMENT_SUBJECT_TYPES as readonly unknown[]).includes(value);
}

export const SKILL_EXPERIMENT_STATUSES = [
  'drafting',
  'running',
  'completed',
  'awaiting_approval',
  'approved',
  'rejected',
  'promoted',
  'failed',
  'cancelled',
] as const;
export type SkillExperimentStatus = (typeof SKILL_EXPERIMENT_STATUSES)[number];

export type SkillExperimentArm = 'baseline' | 'candidate';
export type SkillExperimentSplit = 'dev' | 'holdout';
/** Failure = a saved regression case; control = output a reviewer scored well, kept to catch regressions. */
export type SkillExperimentCaseKind = 'failure' | 'control';
export type SkillExperimentCandidateSource = 'manual' | 'reflective';

export const SKILL_EXPERIMENT_RUN_STATUSES = [
  'pending',
  'generating',
  'judging',
  'scored',
  'failed',
  'skipped',
] as const;
export type SkillExperimentRunStatus = (typeof SKILL_EXPERIMENT_RUN_STATUSES)[number];

export type SkillExperimentCriteriaScores = Record<WorkflowEvaluationCriteriaKey, number>;

/** What a replay produced, kept on the run so a person can read both versions side by side. */
export type ReplayOutput =
  | { kind: 'prd'; markdown: string; backlog: unknown }
  | { kind: 'design_doc'; designContent: string; techSpecContent: string; assumptionsContent: string };

export interface SkillExperimentInterval {
  low: number;
  high: number;
}

export interface SkillExperimentSplitResult {
  /** Cases where both arms were scored. */
  pairs: number;
  baselineMean: number | null;
  candidateMean: number | null;
  /** Mean of candidate minus baseline, per case. */
  meanDiff: number | null;
  diffInterval: SkillExperimentInterval | null;
  wins: number;
  losses: number;
  ties: number;
}

export interface SkillExperimentCriterionResult {
  key: WorkflowEvaluationCriteriaKey;
  meanDiff: number | null;
}

export type SkillExperimentVerdict = 'promote' | 'keep_current' | 'insufficient_data';

export interface SkillExperimentResult {
  dev: SkillExperimentSplitResult;
  holdout: SkillExperimentSplitResult;
  criteria: SkillExperimentCriterionResult[];
  baselineFailureRate: number | null;
  candidateFailureRate: number | null;
  verdict: SkillExperimentVerdict;
  /** Plain-language reasons for the verdict, in the order they were checked. */
  reasons: string[];
}

export interface SkillExperimentSummary {
  id: string;
  project: string;
  subjectType: SkillExperimentSubjectType;
  skillPath: string;
  baselineSha256: string;
  /** Null while the candidate is being drafted. */
  candidateSha256: string | null;
  candidateSource: SkillExperimentCandidateSource;
  changeNotes: string | null;
  status: SkillExperimentStatus;
  /** Why drafting failed, when it did. */
  error: string | null;
  cases: number;
  runsScored: number;
  runsFailed: number;
  estimatedCostUsd: number;
  spentUsd: number;
  result: SkillExperimentResult | null;
  pullRequestUrl: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillExperimentDetail extends SkillExperimentSummary {
  baselineContent: string;
  candidateContent: string | null;
  runs: SkillExperimentRunView[];
  /** Live documents made with each version; present once the change is promoted. */
  postRelease: SkillPostReleaseReport | null;
}

export interface SkillCandidateFrontierEntry {
  experimentId: string;
  candidateSha256: string;
  candidateSource: SkillExperimentCandidateSource;
  candidateContent: string;
  changeNotes: string | null;
  verdict: SkillExperimentVerdict;
  devMeanDiff: number | null;
  criteria: SkillExperimentCriterionResult[];
  candidateFailureRate: number | null;
  createdAt: string;
}

export type SkillMinedCheckDecision = 'accepted' | 'dismissed';

/** A `## Heading` most reviewer-corrected documents of a stage carry; proposed as a Promptfoo check. */
export interface SkillMinedCheck {
  stageKey: string;
  heading: string;
  /** Corrected documents that carry the heading. */
  support: number;
  /** support / corrections; null for a decided check no longer proposed. */
  share: number | null;
  /** Corrected documents read for the stage. */
  corrections: number;
  status: 'proposed' | SkillMinedCheckDecision;
}

export type SkillSemanticCheckStatus = 'proposed' | SkillMinedCheckDecision;
export type SkillCheckMiningStatus = 'running' | 'completed' | 'failed';

/** A plain-language check suggested from reviewer corrections; once accepted it runs as a Promptfoo llm-rubric test. */
export interface SkillSemanticCheck {
  id: string;
  stageKey: string;
  statement: string;
  rationale: string | null;
  /** Distinct corrections the suggestion cited. */
  support: number;
  status: SkillSemanticCheckStatus;
  createdAt: string;
}

export interface SkillCheckMiningRun {
  id: string;
  stageKey: string;
  status: SkillCheckMiningStatus;
  corrections: number;
  proposals: number | null;
  error: string | null;
  createdAt: string;
}

export interface SkillSemanticChecksView {
  checks: SkillSemanticCheck[];
  /** Newest suggestion run per stage. */
  latestRuns: SkillCheckMiningRun[];
  /** Accepted checks per stage beyond this are not added to the suite. */
  maxAcceptedPerStage: number;
  /** Stages that can have checks suggested. */
  stageKeys: string[];
  estimatedCostUsd: number;
}

export interface SkillPostReleaseArm {
  documents: number;
  averageScore: number | null;
  scoreInterval: SkillExperimentInterval | null;
  acceptanceRate: number | null;
  acceptanceInterval: SkillExperimentInterval | null;
}

/**
 * waiting: no live document uses the new Skill yet (pull request not merged, or no runs).
 * collecting: fewer live documents than needed to judge.
 * holding: the new Skill is not clearly worse.
 * regressed: the new Skill's live score or acceptance range sits wholly below the old one's.
 */
export type SkillPostReleaseStatus = 'waiting' | 'collecting' | 'holding' | 'regressed';

export interface SkillPostReleaseReport {
  status: SkillPostReleaseStatus;
  minimumDocuments: number;
  baseline: SkillPostReleaseArm;
  candidate: SkillPostReleaseArm;
}

export interface SkillExperimentRunView {
  id: string;
  caseKey: string;
  caseKind: SkillExperimentCaseKind;
  split: SkillExperimentSplit;
  arm: SkillExperimentArm;
  status: SkillExperimentRunStatus;
  overallScore: number | null;
  error: string | null;
}

export interface SkillExperimentSkillOption {
  subjectType: SkillExperimentSubjectType;
  skillPath: string;
  runs: number;
  lastRunAt: string;
}

export interface StartSkillExperimentRequest {
  subjectType: SkillExperimentSubjectType;
  skillPath: string;
  /** Omit to have Apex draft a candidate from the failures. */
  candidateContent?: string;
  changeNotes?: string;
  /** Cap on cases; the budget may lower it. */
  maxCases?: number;
}

export interface SkillLearningSettings {
  project: string;
  /** Null means experiments are off for this project. */
  monthlyBudgetUsd: number | null;
  spentThisMonthUsd: number;
  updatedBy: string | null;
  updatedAt: string | null;
}
