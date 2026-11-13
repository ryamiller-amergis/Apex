/**
 * Skill Health — read-only quality metrics per generating Skill.
 *
 * v0 covers the two artifact kinds Apex already scores (PRDs and design docs). A Skill is
 * identified by its project and the path that project's settings row points at today. A version is the
 * SHA-256 of the SKILL.md content that produced a document; documents saved before that was recorded have
 * no version.
 */

import type {
  WorkflowEvaluationCriteriaKey,
  WorkflowEvaluationOutcome,
  WorkflowEvaluationSubjectType,
} from './workflowEvaluation';
import type { SkillLearningSurface, SkillSignalKind } from '../constants/skillLearningSurfaces';

export type SkillHealthArtifactKind = 'prd' | 'design_doc';

export type SkillHealthStatus = 'good' | 'fair' | 'poor' | 'insufficient_data';

/** How a document was tied to a Skill path. */
export type SkillAttributionSource = 'document-settings' | 'project-default' | 'unattributed';

export const SKILL_HEALTH_PERIOD_OPTIONS = [30, 90, 180] as const;
export type SkillHealthPeriodDays = (typeof SKILL_HEALTH_PERIOD_OPTIONS)[number];

/** Fewer scored documents than this and the status is `insufficient_data`. */
export const SKILL_HEALTH_MIN_SCORED_DOCUMENTS = 5;

/** The project whose Skills are the Apex foundation; its work items go to the Apex Backlog. */
export const SKILL_HEALTH_FOUNDATION_PROJECT = 'Apex';

/** Where a Skill Health work item is filed. */
export type SkillHealthWorkItemDestination = 'apex-backlog' | 'project-ado';

/** Apex Skills file to the Apex Backlog; every other project files to its own Azure DevOps project. */
export function defaultWorkItemDestination(project: string): SkillHealthWorkItemDestination {
  return project === SKILL_HEALTH_FOUNDATION_PROJECT ? 'apex-backlog' : 'project-ado';
}

/** Apex has no project ADO target; other projects may also send a shared-Skill finding to the Apex Backlog. */
export function allowedWorkItemDestinations(project: string): SkillHealthWorkItemDestination[] {
  return project === SKILL_HEALTH_FOUNDATION_PROJECT ? ['apex-backlog'] : ['project-ado', 'apex-backlog'];
}

export const SKILL_HEALTH_WORK_ITEM_TITLE_MAX = 255;
export const SKILL_HEALTH_WORK_ITEM_DESCRIPTION_MAX = 20000;

export interface SkillHealthTrendPoint {
  /** ISO date (YYYY-MM-DD) of the Monday starting the week. */
  weekStart: string;
  documents: number;
  averageScore: number | null;
}

/** Review comments left on one section of this Skill's documents. */
export interface SkillHealthSectionCell {
  sectionKey: string;
  commentCount: number;
}

/** A validation gap section that recurs across this Skill's documents. */
export interface SkillHealthRecurringGap {
  section: string;
  occurrences: number;
  documentCount: number;
  /** Up to three gap descriptions, verbatim from the judge, as evidence. */
  sampleDescriptions: string[];
  exampleDocumentIds: string[];
}

/** One SKILL.md version's results within a Skill. */
export interface SkillHealthVersion {
  /** SHA-256 of the SKILL.md content, or null for documents saved before versions were recorded. */
  skillSha256: string | null;
  documents: number;
  scoredDocuments: number;
  averageScore: number | null;
  passRate: number | null;
  acceptanceRate: number | null;
  /** createdAt of the oldest and newest document produced by this version. */
  firstSeen: string;
  lastSeen: string;
  /** Human feedback events on documents from this version (PRD Skills, evaluation flag on). */
  humanEvents: number;
  /** Mean of the five 1–5 criteria across those events. */
  humanAverageScore: number | null;
  /** 95% range of the mean validation score (Student t). */
  scoreInterval: SkillHealthInterval | null;
  /** 95% Wilson range of the pass rate. */
  passRateInterval: SkillHealthInterval | null;
  /** True once the version has enough scored documents to compare with another version. */
  sufficientSample: boolean;
}

/** Documents generated with one model and effort setting. */
export interface SkillHealthModelBreakdown {
  model: string | null;
  effort: string | null;
  documents: number;
  averageScore: number | null;
  acceptanceRate: number | null;
  costPerDocument: number | null;
}

/** How much work each accepted document took. Review rounds count only decisions recorded since signals began. */
export interface SkillHealthEfficiency {
  accepted: number;
  /** Median hours from creation to the review that approved it. */
  medianHoursToApproval: number | null;
  /** 1 + revision requests, averaged over accepted documents with recorded review decisions. */
  reviewRoundsPerAccepted: number | null;
  /** All AI cost on the Skill's documents divided by accepted documents. */
  costPerAccepted: number | null;
  /** Assistant regenerations and rejections per accepted document. */
  assistantRetriesPerAccepted: number | null;
}

/** Human feedback count per outcome. */
export type SkillHealthOutcomeCounts = Record<WorkflowEvaluationOutcome, number>;

/** Diagnostic job states for one evaluator. For Promptfoo, `ready` is a pass and `failed` a fail or error. */
export interface SkillHealthJobCounts {
  pending: number;
  running: number;
  ready: number;
  failed: number;
}

export interface SkillHealthEvaluationStage {
  stageKey: string;
  subjectType: WorkflowEvaluationSubjectType;
  events: number;
  outcomes: SkillHealthOutcomeCounts;
}

/** A recent regenerate or reject outcome. */
export interface SkillHealthFlaggedEvent {
  eventId: string;
  stageKey: string;
  subjectType: WorkflowEvaluationSubjectType;
  subjectId: string;
  outcome: Extract<WorkflowEvaluationOutcome, 'regenerate' | 'reject'>;
  skillPath: string | null;
  /** First 160 characters of the reviewer comment. */
  commentExcerpt: string | null;
  createdAt: string;
}

export interface SkillHealthJudgeRecommendation {
  eventId: string;
  stageKey: string;
  text: string;
  criterion: string | null;
  createdAt: string;
}

/**
 * How far the blind judge can be trusted, from its agreement with people:
 * `gate` (weighted kappa >= 0.6), `advisory` (0.4–0.6), `untrusted` (< 0.4),
 * or `insufficient_data` before enough paired reviews exist.
 */
export type SkillLearningTrustBand = 'gate' | 'advisory' | 'untrusted' | 'insufficient_data';

export interface SkillHealthCriterionAgreement {
  pairs: number;
  kappa: number | null;
}

/** Judge–human agreement on reviews where the judge scored without seeing the person's scores. */
export interface SkillHealthJudgeAgreement {
  /** Reviews with both a human score and a blind judge score. */
  reviews: number;
  /** Quadratic weighted kappa over every criterion pair. */
  kappa: number | null;
  band: SkillLearningTrustBand;
  criteria: Record<WorkflowEvaluationCriteriaKey, SkillHealthCriterionAgreement>;
  drift: SkillHealthJudgeDrift;
  /** Reviews where the judge was unsure or far from the person, newest first; worth a second human look. */
  recheck: SkillHealthJudgeRecheck[];
}

/** Agreement in the last JUDGE_DRIFT_WINDOW_DAYS against the time before. */
export interface SkillHealthJudgeDrift {
  recentReviews: number;
  recentKappa: number | null;
  earlierReviews: number;
  earlierKappa: number | null;
  /** True when both windows have enough reviews and recent agreement fell clearly. */
  drifting: boolean;
}

export type SkillHealthJudgeRecheckReason = 'low_confidence' | 'disagreement';

export interface SkillHealthJudgeRecheck {
  eventId: string;
  stageKey: string;
  subjectType: WorkflowEvaluationSubjectType;
  subjectId: string;
  reason: SkillHealthJudgeRecheckReason;
  /** Largest gap between the person's and the judge's score on one criterion. */
  largestGap: number;
  createdAt: string;
}

/** Human feedback and diagnostics for one Skill path within a project. */
export interface SkillHealthEvaluationSkill {
  /** Stable key: `${project}:${subjectType}:${skillPath}`. */
  key: string;
  skillPath: string | null;
  subjectType: WorkflowEvaluationSubjectType;
  events: number;
  criteriaAverages: Record<WorkflowEvaluationCriteriaKey, number | null>;
  /** Mean of the five criteria across all events. */
  averageScore: number | null;
  outcomes: SkillHealthOutcomeCounts;
  promptfoo: SkillHealthJobCounts;
  judge: SkillHealthJobCounts;
  judgeAgreement: SkillHealthJudgeAgreement;
  /** Newest first, at most five. */
  recommendations: SkillHealthJudgeRecommendation[];
}

/** One project's human workflow evaluation results. */
export interface SkillHealthProjectEvaluation {
  events: number;
  stages: SkillHealthEvaluationStage[];
  /** Newest first, at most ten. */
  flagged: SkillHealthFlaggedEvent[];
  skills: SkillHealthEvaluationSkill[];
}

export interface SkillHealthSkill {
  /** Stable key: `${project}:${artifactKind}:${skillPath}`. */
  key: string;
  project: string;
  artifactKind: SkillHealthArtifactKind;
  /** Normalized path inside the project's Skill repo, or null when the project uses the app default. */
  skillPath: string | null;
  status: SkillHealthStatus;
  documents: number;
  scoredDocuments: number;
  averageScore: number | null;
  /** Share of scored documents at or above their project's threshold. */
  passRate: number | null;
  /** approved / (approved + revision_requested), from current status. */
  acceptanceRate: number | null;
  revisionRequested: number;
  /** Documents whose validation gate was overridden by a person. */
  overrides: number;
  generationFailures: number;
  reviewComments: number;
  commentsPerDocument: number | null;
  costUsd: number;
  costPerDocument: number | null;
  attribution: Record<SkillAttributionSource, number>;
  trend: SkillHealthTrendPoint[];
  sections: SkillHealthSectionCell[];
  recurringGaps: SkillHealthRecurringGap[];
  /** Newest version first; unversioned documents last. */
  versions: SkillHealthVersion[];
  /** Most documents first. */
  models: SkillHealthModelBreakdown[];
  efficiency: SkillHealthEfficiency;
}

export interface SkillHealthInterval {
  low: number;
  high: number;
}

/** Signals for one Skill version on one surface. `skillSha256` is null when the run recorded none. */
export interface SkillHealthSignalVersion {
  skillSha256: string | null;
  decisions: number;
  acceptanceRate: number | null;
  acceptanceInterval: SkillHealthInterval | null;
  /** False until the version has `MIN_VERSION_SAMPLE` decisions; compare versions only when both are true. */
  sufficientSample: boolean;
}

/** What people did with one surface's AI output during the period. */
export interface SkillHealthSignalSurface {
  surface: SkillLearningSurface;
  label: string;
  /** True when the surface is also scored against a rubric. */
  rubricEvaluated: boolean;
  signals: number;
  counts: Partial<Record<SkillSignalKind, number>>;
  /** accepted + rejected. */
  decisions: number;
  acceptanceRate: number | null;
  acceptanceInterval: SkillHealthInterval | null;
  /** Share of accepted output a person edited first. */
  editedBeforeAcceptRate: number | null;
  ratings: number;
  /** Mean rating on a −1 to 1 scale. */
  ratingScore: number | null;
  regenerationsPerAccepted: number | null;
  /** Failed runs and handoffs over all finished ones. */
  failureRate: number | null;
  sufficientSample: boolean;
  /** Sampled artifact judge scores this period. */
  judged: number;
  /** Mean sampled-judge score, 1–5. */
  judgedScore: number | null;
  /** Most decisions first. */
  versions: SkillHealthSignalVersion[];
}

export interface SkillHealthProjectSignals {
  surfaces: SkillHealthSignalSurface[];
  /** Surfaces with at least one signal this period, out of every surface Apex can learn from. */
  coverage: { active: number; total: number };
}

/** One project's Skills. The same path in two projects is two Skills: each lives in its own repo. */
export interface SkillHealthProject {
  project: string;
  /** Repo of the project's default Skill settings row, or null when the project has none. */
  skillRepo: string | null;
  isFoundation: boolean;
  skills: SkillHealthSkill[];
  /** Null when the `skill-learning` flag is off for this project. */
  evaluation: SkillHealthProjectEvaluation | null;
  /** Null when the `skill-learning` flag is off for this project. */
  signals: SkillHealthProjectSignals | null;
}

export interface SkillHealthOverview {
  periodDays: number;
  periodFrom: string;
  generatedAt: string;
  /** Foundation project first, then alphabetical. */
  projects: SkillHealthProject[];
  /** Plain-language limits of this data, shown with the results. */
  caveats: string[];
}

/** Kinds of Skill a work item can be about: the two scored artifacts, or an Interview Skill. */
export type SkillHealthWorkItemSkillKind = SkillHealthArtifactKind | 'interview' | 'test_cases';

/** The Skill a work item is about. A `SkillHealthSkill` satisfies it. */
export interface SkillHealthWorkItemTarget {
  project: string;
  artifactKind: SkillHealthWorkItemSkillKind;
  skillPath: string | null;
}

export interface CreateSkillHealthWorkItemRequest {
  /** Project whose Skill the finding is about. */
  project: string;
  destination: SkillHealthWorkItemDestination;
  artifactKind: SkillHealthWorkItemSkillKind;
  skillPath: string | null;
  title: string;
  description: string;
}

export interface SkillHealthWorkItemResult {
  destination: SkillHealthWorkItemDestination;
  /** Project the item was filed in: the foundation project for the Apex Backlog, else the ADO project. */
  project: string;
  id: string;
  /** ADO work item URL; null for Apex Backlog items. */
  url: string | null;
}
