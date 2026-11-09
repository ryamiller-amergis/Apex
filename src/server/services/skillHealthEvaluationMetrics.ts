/**
 * Skill Health evaluation metrics — pure aggregation of human workflow evaluation events and
 * their diagnostic jobs (Promptfoo, LLM judge) for one project. Free of database access.
 */

import {
  WORKFLOW_EVALUATION_CRITERIA_KEYS,
  WORKFLOW_EVALUATION_OUTCOMES,
  WORKFLOW_EVALUATION_STAGE_KEYS,
  workflowEvaluationJudgeOutputSchema,
  workflowEvaluationJudgeOutputSchemaV2,
  type WorkflowEvaluationCriteriaKey,
  type WorkflowEvaluationJudgeOutputV2,
  type WorkflowEvaluationJobEvaluator,
  type WorkflowEvaluationJobStatus,
  type WorkflowEvaluationOutcome,
  type WorkflowEvaluationSubjectType,
} from '../../shared/types/workflowEvaluation';
import type {
  SkillHealthEvaluationSkill,
  SkillHealthEvaluationStage,
  SkillHealthFlaggedEvent,
  SkillHealthJobCounts,
  SkillHealthJudgeAgreement,
  SkillHealthJudgeDrift,
  SkillHealthJudgeRecheck,
  SkillHealthJudgeRecommendation,
  SkillHealthOutcomeCounts,
  SkillHealthProjectEvaluation,
} from '../../shared/types/skillHealth';
import { quadraticWeightedKappa, trustBand } from './skillLearningStats';

export interface SkillHealthEvaluationEventInput {
  id: string;
  project: string;
  subjectType: WorkflowEvaluationSubjectType;
  subjectId: string;
  stageKey: string;
  skillPath: string | null;
  skillVersion: string | null;
  criteriaScores: Partial<Record<WorkflowEvaluationCriteriaKey, number>>;
  outcome: WorkflowEvaluationOutcome;
  comment: string | null;
  createdAt: string;
}

export interface SkillHealthEvaluationJobInput {
  eventId: string;
  evaluatorKey: WorkflowEvaluationJobEvaluator;
  status: WorkflowEvaluationJobStatus;
  summary: unknown;
}

const FLAGGED_LIMIT = 10;
const RECOMMENDATION_LIMIT = 5;
const COMMENT_EXCERPT_LENGTH = 160;

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10) / 10;
}

function emptyOutcomes(): SkillHealthOutcomeCounts {
  return Object.fromEntries(WORKFLOW_EVALUATION_OUTCOMES.map((o) => [o, 0])) as SkillHealthOutcomeCounts;
}

function emptyJobCounts(): SkillHealthJobCounts {
  return { pending: 0, running: 0, ready: 0, failed: 0 };
}

function normalizePath(path: string | null): string | null {
  const trimmed = path?.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  return trimmed ? trimmed : null;
}

/** Mean of the five 1–5 criteria on one event; null when none are present. */
export function eventScore(event: SkillHealthEvaluationEventInput): number | null {
  const values = WORKFLOW_EVALUATION_CRITERIA_KEYS.flatMap((key) => {
    const value = event.criteriaScores[key];
    return typeof value === 'number' ? [value] : [];
  });
  return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Human feedback count and mean score, for events on one Skill version. */
export function humanStats(events: SkillHealthEvaluationEventInput[]): { humanEvents: number; humanAverageScore: number | null } {
  const scores = events.flatMap((e) => {
    const score = eventScore(e);
    return score === null ? [] : [score];
  });
  return { humanEvents: events.length, humanAverageScore: mean(scores) };
}

export function evaluationSkillPathKey(path: string | null): string {
  return (normalizePath(path) ?? '').toLowerCase();
}

function stageOrder(stageKey: string): number {
  const index = (WORKFLOW_EVALUATION_STAGE_KEYS as readonly string[]).indexOf(stageKey);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function buildStages(events: SkillHealthEvaluationEventInput[]): SkillHealthEvaluationStage[] {
  const byStage = new Map<string, SkillHealthEvaluationStage>();
  for (const event of events) {
    const stage = byStage.get(event.stageKey) ?? {
      stageKey: event.stageKey,
      subjectType: event.subjectType,
      events: 0,
      outcomes: emptyOutcomes(),
    };
    stage.events += 1;
    stage.outcomes[event.outcome] += 1;
    byStage.set(event.stageKey, stage);
  }
  return [...byStage.values()].sort(
    (a, b) => stageOrder(a.stageKey) - stageOrder(b.stageKey) || a.stageKey.localeCompare(b.stageKey),
  );
}

function buildFlagged(events: SkillHealthEvaluationEventInput[]): SkillHealthFlaggedEvent[] {
  return events
    .flatMap((event): SkillHealthFlaggedEvent[] => {
      if (event.outcome !== 'regenerate' && event.outcome !== 'reject') return [];
      const comment = event.comment?.trim();
      return [
        {
          eventId: event.id,
          stageKey: event.stageKey,
          subjectType: event.subjectType,
          subjectId: event.subjectId,
          outcome: event.outcome,
          skillPath: normalizePath(event.skillPath),
          commentExcerpt: comment ? comment.slice(0, COMMENT_EXCERPT_LENGTH) : null,
          createdAt: event.createdAt,
        },
      ];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, FLAGGED_LIMIT);
}

function recommendationsFrom(
  event: SkillHealthEvaluationEventInput,
  judgeJob: SkillHealthEvaluationJobInput | undefined,
): SkillHealthJudgeRecommendation[] {
  if (!judgeJob || judgeJob.status !== 'ready') return [];
  const parsed = workflowEvaluationJudgeOutputSchema.safeParse(judgeJob.summary);
  if (!parsed.success) return [];
  return parsed.data.recommendedImprovements.map((improvement) => ({
    eventId: event.id,
    stageKey: event.stageKey,
    text: improvement.text,
    criterion: improvement.criterion ?? null,
    createdAt: event.createdAt,
  }));
}

export const JUDGE_DRIFT_WINDOW_DAYS = 30;
/** Reviews each window needs before a drop counts as drift. */
export const JUDGE_DRIFT_MIN_REVIEWS = 10;
/** Kappa drop between windows that counts as drift. */
export const JUDGE_DRIFT_KAPPA_DROP = 0.15;
/** A gap this large on one criterion puts the review on the recheck list. */
const RECHECK_GAP = 2;
const RECHECK_LIMIT = 10;

/** Blind judge output, or null when the job predates definition version 2. */
function blindJudge(jobs: SkillHealthEvaluationJobInput[] | undefined): WorkflowEvaluationJudgeOutputV2 | null {
  const judgeJob = jobs?.find((job) => job.evaluatorKey === 'llm_judge' && job.status === 'ready');
  if (!judgeJob) return null;
  const parsed = workflowEvaluationJudgeOutputSchemaV2.safeParse(judgeJob.summary);
  return parsed.success ? parsed.data : null;
}

interface PairedReview {
  event: SkillHealthEvaluationEventInput;
  pairs: Array<[WorkflowEvaluationCriteriaKey, number, number]>;
  confidence: WorkflowEvaluationJudgeOutputV2['confidence'];
}

function pairedReviews(
  events: SkillHealthEvaluationEventInput[],
  jobsByEvent: Map<string, SkillHealthEvaluationJobInput[]>,
): PairedReview[] {
  return events.flatMap((event): PairedReview[] => {
    const judge = blindJudge(jobsByEvent.get(event.id));
    if (!judge) return [];
    const pairs = WORKFLOW_EVALUATION_CRITERIA_KEYS.flatMap((criterion): PairedReview['pairs'] => {
      const human = event.criteriaScores[criterion];
      return typeof human === 'number' ? [[criterion, human, judge.criteriaScores[criterion]]] : [];
    });
    return pairs.length ? [{ event, pairs, confidence: judge.confidence }] : [];
  });
}

function kappaOf(reviews: readonly PairedReview[]): number | null {
  return quadraticWeightedKappa(reviews.flatMap((r) => r.pairs.map(([, h, j]) => [h, j] as [number, number])));
}

export function buildJudgeDrift(reviews: readonly PairedReview[], now: number): SkillHealthJudgeDrift {
  const cutoff = new Date(now - JUDGE_DRIFT_WINDOW_DAYS * 24 * 60 * 60_000).toISOString();
  const recent = reviews.filter((r) => r.event.createdAt >= cutoff);
  const earlier = reviews.filter((r) => r.event.createdAt < cutoff);
  const recentKappa = kappaOf(recent);
  const earlierKappa = kappaOf(earlier);
  const drifting = recent.length >= JUDGE_DRIFT_MIN_REVIEWS
    && earlier.length >= JUDGE_DRIFT_MIN_REVIEWS
    && recentKappa !== null
    && earlierKappa !== null
    && earlierKappa - recentKappa >= JUDGE_DRIFT_KAPPA_DROP;
  return { recentReviews: recent.length, recentKappa, earlierReviews: earlier.length, earlierKappa, drifting };
}

function buildRecheck(reviews: readonly PairedReview[]): SkillHealthJudgeRecheck[] {
  return reviews
    .flatMap((review): SkillHealthJudgeRecheck[] => {
      const largestGap = Math.max(...review.pairs.map(([, h, j]) => Math.abs(h - j)));
      const reason = largestGap >= RECHECK_GAP ? 'disagreement' : review.confidence === 'low' ? 'low_confidence' : null;
      if (!reason) return [];
      const { event } = review;
      return [{
        eventId: event.id,
        stageKey: event.stageKey,
        subjectType: event.subjectType,
        subjectId: event.subjectId,
        reason,
        largestGap,
        createdAt: event.createdAt,
      }];
    })
    .sort((a, b) => b.largestGap - a.largestGap || b.createdAt.localeCompare(a.createdAt))
    .slice(0, RECHECK_LIMIT);
}

export function buildJudgeAgreement(
  events: SkillHealthEvaluationEventInput[],
  jobsByEvent: Map<string, SkillHealthEvaluationJobInput[]>,
  now = Date.now(),
): SkillHealthJudgeAgreement {
  const reviews = pairedReviews(events, jobsByEvent);
  const kappa = kappaOf(reviews);
  const criteria = Object.fromEntries(
    WORKFLOW_EVALUATION_CRITERIA_KEYS.map((criterion) => {
      const pairs = reviews.flatMap((r) => r.pairs.filter(([c]) => c === criterion).map(([, h, j]) => [h, j] as [number, number]));
      return [criterion, { pairs: pairs.length, kappa: quadraticWeightedKappa(pairs) }];
    }),
  ) as SkillHealthJudgeAgreement['criteria'];
  return {
    reviews: reviews.length,
    kappa,
    band: trustBand(kappa, reviews.length),
    criteria,
    drift: buildJudgeDrift(reviews, now),
    recheck: buildRecheck(reviews),
  };
}

function buildSkills(
  project: string,
  events: SkillHealthEvaluationEventInput[],
  jobsByEvent: Map<string, SkillHealthEvaluationJobInput[]>,
): SkillHealthEvaluationSkill[] {
  const bySkill = new Map<string, { skillPath: string | null; subjectType: WorkflowEvaluationSubjectType; events: SkillHealthEvaluationEventInput[] }>();
  for (const event of events) {
    const key = `${project}:${event.subjectType}:${evaluationSkillPathKey(event.skillPath)}`;
    const bucket = bySkill.get(key) ?? { skillPath: normalizePath(event.skillPath), subjectType: event.subjectType, events: [] };
    bucket.events.push(event);
    bySkill.set(key, bucket);
  }

  return [...bySkill.entries()]
    .map(([key, bucket]): SkillHealthEvaluationSkill => {
      const outcomes = emptyOutcomes();
      const promptfoo = emptyJobCounts();
      const judge = emptyJobCounts();
      const recommendations: SkillHealthJudgeRecommendation[] = [];
      for (const event of bucket.events) {
        outcomes[event.outcome] += 1;
        const jobs = jobsByEvent.get(event.id) ?? [];
        for (const job of jobs) {
          const counts = job.evaluatorKey === 'promptfoo' ? promptfoo : judge;
          counts[job.status] += 1;
        }
        recommendations.push(...recommendationsFrom(event, jobs.find((j) => j.evaluatorKey === 'llm_judge')));
      }
      const judgeAgreement = buildJudgeAgreement(bucket.events, jobsByEvent);
      const criteriaAverages = Object.fromEntries(
        WORKFLOW_EVALUATION_CRITERIA_KEYS.map((criterion) => [
          criterion,
          mean(bucket.events.flatMap((e) => {
            const value = e.criteriaScores[criterion];
            return typeof value === 'number' ? [value] : [];
          })),
        ]),
      ) as Record<WorkflowEvaluationCriteriaKey, number | null>;

      return {
        key,
        skillPath: bucket.skillPath,
        subjectType: bucket.subjectType,
        events: bucket.events.length,
        criteriaAverages,
        averageScore: humanStats(bucket.events).humanAverageScore,
        outcomes,
        promptfoo,
        judge,
        judgeAgreement,
        recommendations: recommendations
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, RECOMMENDATION_LIMIT),
      };
    })
    .sort((a, b) => b.events - a.events);
}

/** Evaluation results for one project's events and their jobs. */
export function buildProjectEvaluation(
  project: string,
  events: SkillHealthEvaluationEventInput[],
  jobs: SkillHealthEvaluationJobInput[],
): SkillHealthProjectEvaluation {
  const jobsByEvent = new Map<string, SkillHealthEvaluationJobInput[]>();
  for (const job of jobs) {
    const list = jobsByEvent.get(job.eventId);
    if (list) list.push(job);
    else jobsByEvent.set(job.eventId, [job]);
  }
  return {
    events: events.length,
    stages: buildStages(events),
    flagged: buildFlagged(events),
    skills: buildSkills(project, events, jobsByEvent),
  };
}
