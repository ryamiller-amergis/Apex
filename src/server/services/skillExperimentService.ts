/**
 * Skill experiments — the closed loop of Skill Learning.
 *
 * 1. Pick cases: saved regression cases (failures) plus documents reviewers scored well (controls),
 *    each tied to the V2 run that produced it. A stable hash puts a fifth of them in a holdout set.
 * 2. Replay every case twice on the document worker, once with the current SKILL.md and once with the
 *    candidate. Only the Skill differs: prompt, inputs, model, effort and pinned commit are the original run's.
 * 3. Score both outputs with the blind judge and compare them case by case.
 * 4. When the candidate clearly wins, start an approval Playbook; after approval, open a pull request
 *    that changes only that SKILL.md.
 *
 * Spend is capped by the project's monthly Skill Learning budget. Costs are estimates per run.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  playbookDefinitions,
  playbookRuns,
  playbookStepRuns,
  skillExperimentRuns,
  skillExperiments,
  skillLearningSettings,
  workflowEvaluationEvents,
} from '../db/schema';
import { SKILL_LEARNING_FLAG } from '../../shared/types/featureFlags';
import {
  WORKFLOW_EVALUATION_CRITERIA_KEYS,
  WORKFLOW_EVALUATION_DESIGN_DOC_STAGE_KEY,
  WORKFLOW_EVALUATION_PRD_STAGE_KEY,
  workflowEvaluationJudgeOutputSchemaV2,
  type WorkflowEvaluationCriteriaKey,
} from '../../shared/types/workflowEvaluation';
import { JUDGE_RESULT_FILE } from '../../shared/types/aiRunV2EvaluationSpec';
import type {
  ReplayOutput,
  SkillExperimentCaseKind,
  SkillExperimentCriteriaScores,
  SkillExperimentDetail,
  SkillExperimentResult,
  SkillExperimentRunStatus,
  SkillExperimentSkillOption,
  SkillExperimentStatus,
  SkillExperimentSubjectType,
  SkillExperimentSummary,
  SkillLearningSettings,
  StartSkillExperimentRequest,
} from '../../shared/types/skillExperiment';
import { buildApprovalPlaybookGraph } from './skillApprovalPlaybook';
import { isFeatureEnabled } from './featureFlagService';
import { createV2AdmissionService } from './aiRunV2/v2AdmissionService';
import { getActiveDefinition, getDefinitionById } from './workflowEvaluationRepository';
import {
  buildJudgeDocumentSpecification,
  packageDesignDoc,
  packagePrd,
} from './workflowEvaluationSpecificationBuilder';
import { getPrdEvaluationInputs } from './prdService';
import { getInterviewEvaluationInputs } from './interviewService';
import { getDesignDocEvaluationInputs } from './designDocService';
import {
  buildReplayGenerationSpec,
  parseReplayThreadId,
  readReplayOutput,
  replayThreadId,
  skillContentSha256,
  workflowClassForSubject,
} from './skillReplaySpec';
import {
  decideExperiment,
  HOLDOUT_SHARE,
  MIN_EXPERIMENT_PAIRS,
  overallFromCriteria,
  splitForCase,
  type ScoredExperimentRun,
} from './skillExperimentStats';
import {
  buildCandidateInput,
  CANDIDATE_INSTRUCTIONS,
  CANDIDATE_OUTPUT_SCHEMA,
  CANDIDATE_SKILL_PATH,
  parseCandidateResult,
  type SkillFailureEvidence,
} from './skillCandidateGenerator';
import { admitSkillLearningRun } from './skillLearningRuns';
import { diffCorrection, formatCorrectionDiff, loadEventCorrections } from './skillCorrections';
import { createNotification } from './notificationService';
import { createDefinition, publishDraft } from './playbookDefinitionService';
import { startRun } from './playbookRunService';
import { openSkillChangePullRequest } from './skillPromotionService';
import { buildPostReleaseReport } from './skillPostRelease';
import { listCandidateFrontier } from './skillCandidateFrontier';
import { judgedSpendSince } from './skillArtifactJudge';
import { checkMiningSpendSince } from './skillSemanticChecks';

/** Per-run cost estimates in USD, used for the budget before real usage is known. */
export const GENERATION_ESTIMATE_USD = 0.75;
export const JUDGE_ESTIMATE_USD = 0.15;
export const CANDIDATE_DRAFT_ESTIMATE_USD = 0.5;
export const CASE_ESTIMATE_USD = 2 * (GENERATION_ESTIMATE_USD + JUDGE_ESTIMATE_USD);

export const DEFAULT_MAX_CASES = 20;
export const MAX_CASES = 60;
/** Replays in flight per experiment, so one experiment cannot take over the document worker. */
export const MAX_IN_FLIGHT = 4;
/** Cases needed so the dev split can reach MIN_EXPERIMENT_PAIRS. */
export const MIN_CASES = Math.ceil(MIN_EXPERIMENT_PAIRS / (1 - HOLDOUT_SHARE));
/** Share of cases drawn from failures; the rest are controls. */
const FAILURE_SHARE = 0.65;
const RUN_DEADLINE_MS = 60 * 60_000;
const QUEUE_ALLOWANCE_MS = 30 * 60_000;
/** A replay still in flight after this long is marked failed by the sweep. */
const STUCK_RUN_MS = 3 * 60 * 60_000;
const CONTROL_MIN_SCORE = 4;

const APPROVAL_PLAYBOOK_NAMES: Record<SkillExperimentSubjectType, string> = {
  prd: 'Skill Improvement Approval (PRD)',
  design_doc: 'Skill Improvement Approval (Design doc)',
};

const STAGE_FOR_SUBJECT: Record<SkillExperimentSubjectType, string> = {
  prd: WORKFLOW_EVALUATION_PRD_STAGE_KEY,
  design_doc: WORKFLOW_EVALUATION_DESIGN_DOC_STAGE_KEY,
};

const SUBJECT_TABLE: Record<SkillExperimentSubjectType, string> = {
  prd: 'prds',
  design_doc: 'design_docs',
};

export type SkillExperimentErrorCode =
  | 'flag_off'
  | 'budget_off'
  | 'budget_exceeded'
  | 'no_baseline'
  | 'not_enough_cases'
  | 'no_definition'
  | 'candidate_invalid'
  | 'not_found'
  | 'invalid_state';

export class SkillExperimentError extends Error {
  constructor(readonly code: SkillExperimentErrorCode, message: string) {
    super(message);
    this.name = 'SkillExperimentError';
  }
}

type ExperimentRow = typeof skillExperiments.$inferSelect;
type RunRow = typeof skillExperimentRuns.$inferSelect;

export function normalizeSkillPath(skillPath: string): string {
  return skillPath.trim().replace(/^\/+/, '').toLowerCase();
}

function money(value: string | number | null | undefined): number {
  const n = typeof value === 'number' ? value : parseFloat(value ?? '0');
  return Number.isFinite(n) ? n : 0;
}

function rows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) ?? [];
}

function monthStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

// ── Budget ────────────────────────────────────────────────────────────────────

async function committedThisMonth(project: string): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM(CASE WHEN ${skillExperiments.status} IN ('drafting', 'running')
        THEN GREATEST(${skillExperiments.estimatedCostUsd}, ${skillExperiments.spentUsd})
        ELSE ${skillExperiments.spentUsd} END), 0)`,
    })
    .from(skillExperiments)
    .where(and(eq(skillExperiments.project, project), sql`${skillExperiments.createdAt} >= ${monthStart()}`));
  return money(row?.total) + await judgedSpendSince(project, monthStart()) + await checkMiningSpendSince(project, monthStart());
}

export async function getSkillLearningSettings(project: string): Promise<SkillLearningSettings> {
  const [row] = await db.select().from(skillLearningSettings).where(eq(skillLearningSettings.project, project)).limit(1);
  return {
    project,
    monthlyBudgetUsd: row?.monthlyBudgetUsd == null ? null : money(row.monthlyBudgetUsd),
    spentThisMonthUsd: await committedThisMonth(project),
    updatedBy: row?.updatedBy ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** Null turns experiments off for the project. */
export async function setSkillLearningBudget(
  project: string,
  monthlyBudgetUsd: number | null,
  userId: string,
): Promise<SkillLearningSettings> {
  if (monthlyBudgetUsd !== null && (!Number.isFinite(monthlyBudgetUsd) || monthlyBudgetUsd < 0)) {
    throw new SkillExperimentError('invalid_state', 'The budget must be zero or more.');
  }
  const value = monthlyBudgetUsd === null ? null : monthlyBudgetUsd.toFixed(2);
  const now = new Date().toISOString();
  await db.insert(skillLearningSettings)
    .values({ project, monthlyBudgetUsd: value, updatedBy: userId, updatedAt: now })
    .onConflictDoUpdate({
      target: skillLearningSettings.project,
      set: { monthlyBudgetUsd: value, updatedBy: userId, updatedAt: now },
    });
  return getSkillLearningSettings(project);
}

/** How many cases the remaining budget pays for, after an optional candidate draft. */
export function affordableCases(remainingUsd: number, drafting: boolean): number {
  const available = remainingUsd - (drafting ? CANDIDATE_DRAFT_ESTIMATE_USD : 0);
  return available <= 0 ? 0 : Math.floor(available / CASE_ESTIMATE_USD);
}

async function addSpend(experimentId: string, usd: number): Promise<void> {
  await db.update(skillExperiments)
    .set({ spentUsd: sql`${skillExperiments.spentUsd} + ${usd.toFixed(2)}::numeric`, updatedAt: new Date().toISOString() })
    .where(eq(skillExperiments.id, experimentId));
}

// ── Baseline and cases ────────────────────────────────────────────────────────

/** The SKILL.md frozen in the project's newest production V2 run for this Skill. */
export async function resolveBaseline(
  project: string,
  subjectType: SkillExperimentSubjectType,
  skillPath: string,
): Promise<{ content: string; sha256: string; runAt: string } | null> {
  const result = await db.execute(sql`
    SELECT r.execution_snapshot->>'skillContent' AS content, r.created_at AS run_at
    FROM agent_runs r
    WHERE r.project_id = ${project}
      AND r.transport_version = 'servicebus-blob-v2'
      AND r.execution_snapshot->>'workflowClass' = ${workflowClassForSubject(subjectType)}
      AND lower(ltrim(r.execution_snapshot->>'skillPath', '/')) = ${normalizeSkillPath(skillPath)}
      AND r.thread_id NOT LIKE 'skill-replay:%'
    ORDER BY r.created_at DESC
    LIMIT 1
  `);
  const [row] = rows<{ content: string | null; run_at: string }>(result);
  if (!row?.content?.trim()) return null;
  return { content: row.content, sha256: skillContentSha256(row.content), runAt: String(row.run_at) };
}

/** Skills with a replayable production run in the last 90 days, newest first. */
export async function listReplayableSkills(project: string): Promise<SkillExperimentSkillOption[]> {
  const result = await db.execute(sql`
    SELECT r.execution_snapshot->>'workflowClass' AS workflow_class,
           lower(ltrim(r.execution_snapshot->>'skillPath', '/')) AS skill_path,
           COUNT(*)::int AS runs,
           MAX(r.created_at) AS last_run_at
    FROM agent_runs r
    WHERE r.project_id = ${project}
      AND r.transport_version = 'servicebus-blob-v2'
      AND r.execution_snapshot->>'workflowClass' IN ('prd', 'design-doc')
      AND r.thread_id NOT LIKE 'skill-replay:%'
      AND r.created_at >= now() - interval '90 days'
    GROUP BY 1, 2
    ORDER BY MAX(r.created_at) DESC
  `);
  return rows<{ workflow_class: string; skill_path: string | null; runs: number; last_run_at: string }>(result)
    .filter((row) => row.skill_path)
    .map((row) => ({
      subjectType: row.workflow_class === 'prd' ? 'prd' : 'design_doc',
      skillPath: row.skill_path as string,
      runs: Number(row.runs),
      lastRunAt: String(row.last_run_at),
    }));
}

export interface ExperimentCase {
  caseKey: string;
  caseKind: SkillExperimentCaseKind;
  subjectId: string;
  sourceRunId: string;
  eventId: string;
}

async function selectCasesOfKind(
  project: string,
  subjectType: SkillExperimentSubjectType,
  skillPath: string,
  kind: SkillExperimentCaseKind,
  limit: number,
  excludeSubjects: readonly string[],
): Promise<ExperimentCase[]> {
  if (limit <= 0) return [];
  const table = sql.raw(SUBJECT_TABLE[subjectType]);
  const workflowClass = workflowClassForSubject(subjectType);
  const norm = normalizeSkillPath(skillPath);
  const exclude = excludeSubjects.length > 0
    ? sql`AND picked.subject_id NOT IN (${sql.join(excludeSubjects.map((id) => sql`${id}::uuid`), sql`, `)})`
    : sql``;
  const picked = kind === 'failure'
    ? sql`
      SELECT DISTINCT ON (c.subject_id) 'regression:' || c.id AS case_key, c.subject_id, c.event_id, c.created_at
      FROM skill_regression_cases c
      WHERE c.project = ${project} AND c.subject_type = ${subjectType} AND c.status = 'active'
        AND lower(ltrim(COALESCE(c.skill_path, ''), '/')) = ${norm}
      ORDER BY c.subject_id, c.created_at DESC`
    : sql`
      SELECT DISTINCT ON (e.subject_id) 'control:' || e.id AS case_key, e.subject_id, e.id AS event_id, e.created_at
      FROM workflow_evaluation_events e
      WHERE e.project = ${project} AND e.subject_type = ${subjectType}
        AND lower(ltrim(COALESCE(e.skill_path, ''), '/')) = ${norm}
        AND (
          SELECT AVG(value::text::numeric) FROM jsonb_each(e.criteria_scores) WHERE jsonb_typeof(value) = 'number'
        ) >= ${CONTROL_MIN_SCORE}
        AND NOT EXISTS (
          SELECT 1 FROM skill_regression_cases c WHERE c.subject_id = e.subject_id AND c.status = 'active'
        )
      ORDER BY e.subject_id, e.created_at DESC`;
  const result = await db.execute(sql`
    SELECT picked.case_key, picked.subject_id, picked.event_id, src.id AS source_run_id
    FROM (${picked}) picked
    JOIN ${table} doc ON doc.id = picked.subject_id
    JOIN LATERAL (
      SELECT r.id FROM agent_runs r
      WHERE r.thread_id = doc.chat_thread_id::text
        AND r.transport_version = 'servicebus-blob-v2'
        AND r.status = 'completed'
        AND r.execution_snapshot->>'workflowClass' = ${workflowClass}
      ORDER BY r.created_at DESC
      LIMIT 1
    ) src ON TRUE
    WHERE TRUE ${exclude}
    ORDER BY picked.created_at DESC
    LIMIT ${limit}
  `);
  return rows<{ case_key: string; subject_id: string; event_id: string; source_run_id: string }>(result).map((row) => ({
    caseKey: row.case_key,
    caseKind: kind,
    subjectId: row.subject_id,
    sourceRunId: row.source_run_id,
    eventId: row.event_id,
  }));
}

export async function selectExperimentCases(
  project: string,
  subjectType: SkillExperimentSubjectType,
  skillPath: string,
  limit: number,
): Promise<ExperimentCase[]> {
  const failures = await selectCasesOfKind(project, subjectType, skillPath, 'failure', Math.ceil(limit * FAILURE_SHARE), []);
  const controls = await selectCasesOfKind(
    project, subjectType, skillPath, 'control', limit - failures.length, failures.map((c) => c.subjectId),
  );
  return [...failures, ...controls];
}

/** Reviewer evidence for dev failures only; holdout cases never reach the candidate drafter. */
async function failureEvidence(cases: readonly ExperimentCase[]): Promise<SkillFailureEvidence[]> {
  const dev = cases.filter((c) => c.caseKind === 'failure' && splitForCase(c.caseKey) === 'dev');
  if (dev.length === 0) return [];
  const events = await db.select({
    id: workflowEvaluationEvents.id,
    criteriaScores: workflowEvaluationEvents.criteriaScores,
    comment: workflowEvaluationEvents.comment,
    reasonCodes: workflowEvaluationEvents.reasonCodes,
  }).from(workflowEvaluationEvents).where(inArray(workflowEvaluationEvents.id, dev.map((c) => c.eventId)));
  const byId = new Map(events.map((e) => [e.id, e]));
  const corrections = await loadEventCorrections(dev.map((c) => c.eventId));
  return dev.flatMap((c) => {
    const event = byId.get(c.eventId);
    if (!event) return [];
    const scores = event.criteriaScores as Partial<Record<WorkflowEvaluationCriteriaKey, number | null>>;
    const correction = corrections.get(c.eventId);
    const changes = correction?.original != null
      ? formatCorrectionDiff(diffCorrection(correction.original, correction.corrected))
      : null;
    return [{
      caseKey: c.caseKey,
      lowCriteria: WORKFLOW_EVALUATION_CRITERIA_KEYS.filter((key) => typeof scores[key] === 'number' && (scores[key] ?? 5) <= 2),
      reviewerComment: event.comment ?? null,
      reasonCodes: (event.reasonCodes ?? []).map(String),
      correctionChanges: changes,
      correctedExcerpt: changes ? null : correction?.corrected ?? null,
    }];
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────

async function requireFlag(project: string, userId: string): Promise<void> {
  // @feature-flag:skill-learning start winner=enabled
  if (!await isFeatureEnabled(SKILL_LEARNING_FLAG, { userId, project })) {
    // @feature-flag:skill-learning disabled-start
    throw new SkillExperimentError('flag_off', 'Skill Learning is turned off for this project.');
    // @feature-flag:skill-learning disabled-end
  }
  // @feature-flag:skill-learning end
}

export async function startSkillExperiment(
  project: string,
  userId: string,
  request: StartSkillExperimentRequest,
): Promise<SkillExperimentSummary> {
  await requireFlag(project, userId);
  const settings = await getSkillLearningSettings(project);
  if (settings.monthlyBudgetUsd === null) {
    throw new SkillExperimentError('budget_off', 'Set a monthly Skill Learning budget for this project before running experiments.');
  }

  const baseline = await resolveBaseline(project, request.subjectType, request.skillPath);
  if (!baseline) {
    throw new SkillExperimentError('no_baseline', 'No recent run of this Skill on the new document worker was found to replay.');
  }

  const drafting = !request.candidateContent?.trim();
  const remaining = settings.monthlyBudgetUsd - settings.spentThisMonthUsd;
  const requested = Math.min(Math.max(request.maxCases ?? DEFAULT_MAX_CASES, MIN_CASES), MAX_CASES);
  const limit = Math.min(requested, affordableCases(remaining, drafting));
  if (limit < MIN_CASES) {
    throw new SkillExperimentError(
      'budget_exceeded',
      `This month's budget has $${Math.max(0, remaining).toFixed(2)} left; an experiment needs at least $${(MIN_CASES * CASE_ESTIMATE_USD + (drafting ? CANDIDATE_DRAFT_ESTIMATE_USD : 0)).toFixed(2)}.`,
    );
  }

  const cases = await selectExperimentCases(project, request.subjectType, request.skillPath, limit);
  if (cases.length < MIN_CASES) {
    throw new SkillExperimentError(
      'not_enough_cases',
      `Found ${cases.length} replayable cases; at least ${MIN_CASES} are needed. Cases come from reviewed documents generated on the new document worker.`,
    );
  }

  const definition = await getActiveDefinition(STAGE_FOR_SUBJECT[request.subjectType]);
  if (!definition) throw new SkillExperimentError('no_definition', 'No active judge definition for this document type.');

  const candidateContent = drafting ? null : request.candidateContent?.replace(/\r\n/g, '\n') ?? null;
  const candidateSha256 = candidateContent === null ? null : skillContentSha256(candidateContent);
  if (candidateSha256 === baseline.sha256) {
    throw new SkillExperimentError('candidate_invalid', 'The candidate is the same as the current Skill.');
  }
  let draftInput: Record<string, unknown> | null = null;
  if (drafting) {
    try {
      draftInput = buildCandidateInput({
        skillPath: request.skillPath,
        baselineContent: baseline.content,
        evidence: await failureEvidence(cases),
        priorAttempts: (await listCandidateFrontier(project, request.skillPath)).map((entry) => ({
          changeNotes: entry.changeNotes,
          devMeanDiff: entry.devMeanDiff,
          promoted: entry.verdict === 'promote',
        })),
      });
    } catch (error) {
      throw new SkillExperimentError('candidate_invalid', error instanceof Error ? error.message : String(error));
    }
  }

  const experimentId = await db.transaction(async (tx) => {
    const [experiment] = await tx.insert(skillExperiments).values({
      project,
      subjectType: request.subjectType,
      skillPath: request.skillPath,
      baselineContent: baseline.content,
      baselineSha256: baseline.sha256,
      candidateContent,
      candidateSha256,
      candidateSource: drafting ? 'reflective' : 'manual',
      changeNotes: drafting ? null : request.changeNotes?.trim() || null,
      status: drafting ? 'drafting' : 'running',
      definitionId: definition.id,
      estimatedCostUsd: (cases.length * CASE_ESTIMATE_USD + (drafting ? CANDIDATE_DRAFT_ESTIMATE_USD : 0)).toFixed(2),
      spentUsd: (drafting ? CANDIDATE_DRAFT_ESTIMATE_USD : 0).toFixed(2),
      createdBy: userId,
    }).returning({ id: skillExperiments.id });
    await tx.insert(skillExperimentRuns).values(cases.flatMap((c) => (['baseline', 'candidate'] as const).map((arm) => ({
      experimentId: experiment.id,
      caseKey: c.caseKey,
      caseKind: c.caseKind,
      split: splitForCase(c.caseKey),
      arm,
      subjectId: c.subjectId,
      sourceRunId: c.sourceRunId,
    }))));
    return experiment.id;
  });

  console.log(`[skill-experiment] started id=${experimentId} project=${project} cases=${cases.length} source=${drafting ? 'reflective' : 'manual'}`);
  if (draftInput) await dispatchDraft(experimentId, project, draftInput);
  else advanceExperimentLater(experimentId);
  const summary = await getSkillExperiment(project, experimentId);
  if (!summary) throw new SkillExperimentError('not_found', 'The experiment was not saved.');
  return summary;
}

// ── Dispatch and progress ─────────────────────────────────────────────────────

const IN_FLIGHT: SkillExperimentRunStatus[] = ['generating', 'judging'];
const TERMINAL_RUN: SkillExperimentRunStatus[] = ['scored', 'failed', 'skipped'];

async function failRun(runId: string, error: string): Promise<void> {
  await db.update(skillExperimentRuns)
    .set({ status: 'failed', error: error.slice(0, 2000), updatedAt: new Date().toISOString() })
    .where(and(eq(skillExperimentRuns.id, runId), sql`${skillExperimentRuns.status} NOT IN ('scored', 'failed', 'skipped')`));
}

async function admitDocumentRun(project: string, specification: { threadId: string; deadlineMs: number }): Promise<string> {
  const admitted = await createV2AdmissionService().admit({
    threadId: specification.threadId,
    projectId: project,
    workloadLane: 'document',
    capacityClass: 'batch',
    timeoutAt: new Date(Date.now() + QUEUE_ALLOWANCE_MS + Math.min(specification.deadlineMs, RUN_DEADLINE_MS)).toISOString(),
    specification: specification as unknown as Record<string, unknown>,
    executionSnapshot: specification as unknown as Record<string, unknown>,
  });
  if (admitted.status !== 'dispatched') {
    throw new Error(`Run ${admitted.existingRunId} is still active on this replay's thread.`);
  }
  return admitted.runId;
}

async function failDraft(experimentId: string, error: string): Promise<void> {
  await db.update(skillExperiments)
    .set({ status: 'failed', error: error.slice(0, 2000), updatedAt: new Date().toISOString() })
    .where(and(eq(skillExperiments.id, experimentId), eq(skillExperiments.status, 'drafting')));
  await db.update(skillExperimentRuns)
    .set({ status: 'skipped', updatedAt: new Date().toISOString() })
    .where(and(eq(skillExperimentRuns.experimentId, experimentId), eq(skillExperimentRuns.status, 'pending')));
}

async function dispatchDraft(experimentId: string, project: string, input: Record<string, unknown>): Promise<void> {
  try {
    const draftRunId = await admitSkillLearningRun({
      project,
      task: 'candidate',
      subjectKey: experimentId,
      skillPath: CANDIDATE_SKILL_PATH,
      instructions: CANDIDATE_INSTRUCTIONS,
      input,
      outputSchema: CANDIDATE_OUTPUT_SCHEMA,
    });
    await db.update(skillExperiments)
      .set({ draftRunId, updatedAt: new Date().toISOString() })
      .where(eq(skillExperiments.id, experimentId));
  } catch (error) {
    await failDraft(experimentId, `The candidate draft could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Called by the document harvest when the candidate draft run finishes. */
export async function applyCandidateDrafted(experimentId: string, result: unknown): Promise<void> {
  const experiment = await db.query.skillExperiments.findFirst({ where: eq(skillExperiments.id, experimentId) });
  if (!experiment || experiment.status !== 'drafting') return;
  let draft: { skillContent: string; changeNotes: string };
  try {
    draft = parseCandidateResult(result, experiment.baselineContent);
  } catch (error) {
    await failDraft(experimentId, error instanceof Error ? error.message : String(error));
    return;
  }
  const candidateSha256 = skillContentSha256(draft.skillContent);
  if (candidateSha256 === experiment.baselineSha256) {
    await failDraft(experimentId, 'The draft is the same as the current Skill.');
    return;
  }
  await db.update(skillExperiments)
    .set({
      candidateContent: draft.skillContent,
      candidateSha256,
      changeNotes: draft.changeNotes,
      status: 'running',
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(skillExperiments.id, experimentId), eq(skillExperiments.status, 'drafting')));
  advanceExperimentLater(experimentId);
}

export async function applyCandidateDraftFailed(experimentId: string, reason: string): Promise<void> {
  await failDraft(experimentId, `The candidate draft failed: ${reason}`);
}

async function dispatchGeneration(experiment: ExperimentRow, run: RunRow): Promise<void> {
  const claimed = await db.update(skillExperimentRuns)
    .set({ status: 'generating', updatedAt: new Date().toISOString() })
    .where(and(eq(skillExperimentRuns.id, run.id), eq(skillExperimentRuns.status, 'pending')))
    .returning({ id: skillExperimentRuns.id });
  if (claimed.length === 0) return;
  try {
    if (experiment.candidateContent === null) throw new Error('The experiment has no candidate yet.');
    const result = await db.execute(sql`SELECT execution_snapshot FROM agent_runs WHERE id = ${run.sourceRunId} LIMIT 1`);
    const [source] = rows<{ execution_snapshot: unknown }>(result);
    const specification = buildReplayGenerationSpec(source?.execution_snapshot, {
      subjectType: experiment.subjectType,
      skillContent: run.arm === 'baseline' ? experiment.baselineContent : experiment.candidateContent,
      threadId: replayThreadId(run.id, 'generate'),
    });
    const agentRunId = await admitDocumentRun(experiment.project, specification);
    await db.update(skillExperimentRuns)
      .set({ generationRunId: agentRunId, updatedAt: new Date().toISOString() })
      .where(eq(skillExperimentRuns.id, run.id));
    await addSpend(experiment.id, GENERATION_ESTIMATE_USD);
  } catch (error) {
    await failRun(run.id, `Replay could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Dispatches pending replays up to the in-flight limit, and finishes the experiment when every run is done. */
export async function advanceExperiment(experimentId: string): Promise<void> {
  const experiment = await db.query.skillExperiments.findFirst({ where: eq(skillExperiments.id, experimentId) });
  if (!experiment || experiment.status !== 'running') return;
  const runs = await db.select().from(skillExperimentRuns).where(eq(skillExperimentRuns.experimentId, experimentId));
  const inFlight = runs.filter((r) => IN_FLIGHT.includes(r.status)).length;
  const pending = runs.filter((r) => r.status === 'pending');
  for (const run of pending.slice(0, Math.max(0, MAX_IN_FLIGHT - inFlight))) {
    await dispatchGeneration(experiment, run);
  }
  const fresh = await db.select({ status: skillExperimentRuns.status })
    .from(skillExperimentRuns).where(eq(skillExperimentRuns.experimentId, experimentId));
  if (fresh.every((r) => TERMINAL_RUN.includes(r.status))) await finishExperiment(experimentId);
}

export function advanceExperimentLater(experimentId: string): void {
  advanceExperiment(experimentId).catch((error: unknown) => {
    console.error(`[skill-experiment] advance failed (id=${experimentId})`, error);
  });
}

// ── Harvest hooks ─────────────────────────────────────────────────────────────

export function ownsReplayThread(threadId: string): boolean {
  return parseReplayThreadId(threadId) !== null;
}

async function loadRunContext(runId: string): Promise<{ run: RunRow; experiment: ExperimentRow } | null> {
  const run = await db.query.skillExperimentRuns.findFirst({ where: eq(skillExperimentRuns.id, runId) });
  if (!run) return null;
  const experiment = await db.query.skillExperiments.findFirst({ where: eq(skillExperiments.id, run.experimentId) });
  return experiment ? { run, experiment } : null;
}

async function judgePackage(experiment: ExperimentRow, run: RunRow, output: ReplayOutput) {
  switch (output.kind) {
    case 'prd': {
      const prd = await getPrdEvaluationInputs(run.subjectId);
      const interview = prd?.interviewId ? await getInterviewEvaluationInputs(prd.interviewId) : null;
      return packagePrd(output.markdown, output.backlog, interview ? interview.phases.flatMap((p) => p.messages) : null);
    }
    case 'design_doc': {
      const doc = await getDesignDocEvaluationInputs(run.subjectId);
      const prd = doc?.prdId ? await getPrdEvaluationInputs(doc.prdId) : null;
      return packageDesignDoc(output, prd && prd.project === experiment.project ? prd.content : null);
    }
    default: {
      const unhandled: never = output;
      throw new Error(`Unsupported replay output: ${String(unhandled)}`);
    }
  }
}

async function onGenerated(experiment: ExperimentRow, run: RunRow, outputDir: string): Promise<void> {
  const output = await readReplayOutput(experiment.subjectType, outputDir);
  if (!output) {
    await failRun(run.id, 'The replay finished without writing a document.');
    return;
  }
  const moved = await db.update(skillExperimentRuns)
    .set({ status: 'judging', output, updatedAt: new Date().toISOString() })
    .where(and(eq(skillExperimentRuns.id, run.id), eq(skillExperimentRuns.status, 'generating')))
    .returning({ id: skillExperimentRuns.id });
  if (moved.length === 0) return;
  try {
    const definition = await getDefinitionById(experiment.definitionId);
    if (!definition) throw new Error('The judge definition is missing.');
    const artifactPackage = await judgePackage(experiment, run, output);
    const specification = await buildJudgeDocumentSpecification({
      project: experiment.project,
      threadId: replayThreadId(run.id, 'judge'),
      identity: {
        eventId: run.id,
        jobId: run.id,
        stageKey: definition.stageKey,
        rubricVersion: definition.version,
        artifactHash: createHash('sha256').update(JSON.stringify(artifactPackage)).digest('hex'),
      },
      definition,
      artifactPackage,
    });
    const judgeRunId = await admitDocumentRun(experiment.project, specification);
    await db.update(skillExperimentRuns)
      .set({ judgeRunId, updatedAt: new Date().toISOString() })
      .where(eq(skillExperimentRuns.id, run.id));
    await addSpend(experiment.id, JUDGE_ESTIMATE_USD);
  } catch (error) {
    await failRun(run.id, `Judge could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function judgeSummary(parsed: { missedRequirements: unknown[]; inventedRequirements: unknown[]; recommendedImprovements: Array<{ text?: string }> }): string {
  const tips = parsed.recommendedImprovements.map((r) => r.text).filter(Boolean).slice(0, 3).join(' · ');
  return `${parsed.missedRequirements.length} missed, ${parsed.inventedRequirements.length} invented${tips ? ` — ${tips}` : ''}`;
}

async function onJudged(run: RunRow, outputDir: string): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(outputDir, JUDGE_RESULT_FILE), 'utf8');
  } catch {
    await failRun(run.id, 'The judge finished without writing a result.');
    return;
  }
  const parsed = workflowEvaluationJudgeOutputSchemaV2.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    await failRun(run.id, 'The judge result did not match the scoring schema.');
    return;
  }
  const criteriaScores = parsed.data.criteriaScores as SkillExperimentCriteriaScores;
  await db.update(skillExperimentRuns)
    .set({
      status: 'scored',
      criteriaScores,
      overallScore: overallFromCriteria(criteriaScores).toFixed(2),
      judgeSummary: judgeSummary(parsed.data).slice(0, 2000),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(skillExperimentRuns.id, run.id), eq(skillExperimentRuns.status, 'judging')));
}

/** Called by the document harvest for replay threads. */
export async function applyReplayCompleted(input: { threadId: string; outputDir: string }): Promise<void> {
  const parsed = parseReplayThreadId(input.threadId);
  if (!parsed) return;
  const context = await loadRunContext(parsed.runId);
  if (!context) return;
  if (parsed.stage === 'generate') await onGenerated(context.experiment, context.run, input.outputDir);
  else await onJudged(context.run, input.outputDir);
  advanceExperimentLater(context.experiment.id);
}

export async function applyReplayFailed(input: { threadId: string; reason: string }): Promise<void> {
  const parsed = parseReplayThreadId(input.threadId);
  if (!parsed) return;
  const context = await loadRunContext(parsed.runId);
  if (!context) return;
  await failRun(context.run.id, `${parsed.stage === 'generate' ? 'Replay' : 'Judge'} failed: ${input.reason}`);
  advanceExperimentLater(context.experiment.id);
}

// ── Finish, approval and promotion ────────────────────────────────────────────

function toScored(run: RunRow): ScoredExperimentRun {
  return {
    caseKey: run.caseKey,
    split: run.split,
    arm: run.arm,
    overallScore: run.overallScore == null ? null : money(run.overallScore),
    criteriaScores: run.criteriaScores ?? null,
    failed: run.status === 'failed',
  };
}

async function finishExperiment(experimentId: string): Promise<void> {
  const runs = await db.select().from(skillExperimentRuns).where(eq(skillExperimentRuns.experimentId, experimentId));
  const result = decideExperiment(runs.map(toScored));
  const [experiment] = await db.update(skillExperiments)
    .set({ status: 'completed', result, updatedAt: new Date().toISOString() })
    .where(and(eq(skillExperiments.id, experimentId), eq(skillExperiments.status, 'running')))
    .returning();
  if (!experiment) return;
  console.log(`[skill-experiment] finished id=${experimentId} verdict=${result.verdict}`);
  if (result.verdict === 'promote') {
    await requestApproval(experiment, result).catch(async (error: unknown) => {
      console.error(`[skill-experiment] approval could not start (id=${experimentId})`, error);
      await db.update(skillExperiments)
        .set({ promotionError: `Approval could not start: ${error instanceof Error ? error.message : String(error)}` })
        .where(eq(skillExperiments.id, experimentId));
    });
  }
  await createNotification(experiment.createdBy, {
    type: 'ai',
    title: result.verdict === 'promote' ? 'Skill change beat the current Skill' : 'Skill experiment finished',
    body: result.reasons[0],
    link: `/platform-admin/skill-health?experiment=${experimentId}`,
  }, { dedupeKey: `skill-experiment-finished:${experimentId}` }).catch(() => undefined);
}

async function ensureApprovalDefinition(project: string, subjectType: SkillExperimentSubjectType, userId: string): Promise<string> {
  const name = APPROVAL_PLAYBOOK_NAMES[subjectType];
  const existing = await db.query.playbookDefinitions.findFirst({
    where: and(eq(playbookDefinitions.project, project), eq(playbookDefinitions.name, name)),
  });
  if (existing) return existing.id;
  const created = await createDefinition({
    project,
    name,
    description: 'Approve a Skill change that beat the current Skill on replayed cases. Approval opens a pull request.',
    graph: buildApprovalPlaybookGraph(subjectType),
    createdByUserId: userId,
  });
  await publishDraft({
    project,
    definitionId: created.definition.id,
    publishedByUserId: userId,
    expectedDraftUpdatedAt: created.draft.updatedAt,
  });
  return created.definition.id;
}

async function requestApproval(experiment: ExperimentRow, result: SkillExperimentResult): Promise<void> {
  const definitionId = await ensureApprovalDefinition(experiment.project, experiment.subjectType, experiment.createdBy);
  const skillName = experiment.skillPath.split('/').slice(-2, -1)[0] ?? experiment.skillPath;
  const started = await startRun({
    project: experiment.project,
    definitionId,
    initiatorUserId: experiment.createdBy,
    runInput: {
      experimentId: experiment.id,
      creatorUserId: experiment.createdBy,
      subject: `Approve the ${skillName} Skill change`,
      summary: result.reasons.join(' '),
      link: `/platform-admin/skill-health?experiment=${experiment.id}`,
    },
  });
  await db.update(skillExperiments)
    .set({ status: 'awaiting_approval', approvalPlaybookRunId: started.runId, updatedAt: new Date().toISOString() })
    .where(and(eq(skillExperiments.id, experiment.id), eq(skillExperiments.status, 'completed')));
}

/** Reads the approval gate's decision once its Playbook run has ended. */
async function checkApproval(experiment: ExperimentRow): Promise<void> {
  if (!experiment.approvalPlaybookRunId) return;
  const run = await db.query.playbookRuns.findFirst({ where: eq(playbookRuns.id, experiment.approvalPlaybookRunId) });
  if (!run || run.status === 'running' || run.status === 'suspended') return;
  const gate = await db.query.playbookStepRuns.findFirst({
    where: and(eq(playbookStepRuns.runId, run.id), eq(playbookStepRuns.stepId, 'approve')),
  });
  const output = (gate?.outputInline ?? null) as { decision?: string; decidedBy?: string } | null;
  const approved = run.status === 'completed' && output?.decision === 'approved';
  const [moved] = await db.update(skillExperiments)
    .set({
      status: approved ? 'approved' : 'rejected',
      decidedBy: output?.decidedBy ?? null,
      decidedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(approved || output?.decision === 'rejected'
        ? {}
        : { promotionError: `The approval Playbook ended as ${run.status} without a decision.` }),
    })
    .where(and(eq(skillExperiments.id, experiment.id), eq(skillExperiments.status, 'awaiting_approval')))
    .returning();
  if (moved && approved) await promoteExperiment(moved);
}

async function promoteExperiment(experiment: ExperimentRow): Promise<void> {
  if (experiment.candidateContent === null) throw new Error(`Experiment ${experiment.id} has no candidate to promote.`);
  const opened = await openSkillChangePullRequest({
    project: experiment.project,
    experimentId: experiment.id,
    skillPath: experiment.skillPath,
    baselineContent: experiment.baselineContent,
    candidateContent: experiment.candidateContent,
    changeNotes: experiment.changeNotes,
    result: experiment.result,
  });
  await db.update(skillExperiments)
    .set(opened.ok
      ? { status: 'promoted', pullRequestUrl: opened.url, branchName: opened.branchName, promotionError: null, updatedAt: new Date().toISOString() }
      : { promotionError: opened.error, updatedAt: new Date().toISOString() })
    .where(eq(skillExperiments.id, experiment.id));
  await createNotification(experiment.createdBy, {
    type: 'ai',
    title: opened.ok ? 'Skill change pull request opened' : 'Skill change approved, but the pull request failed',
    body: opened.ok ? opened.url : opened.error,
    link: `/platform-admin/skill-health?experiment=${experiment.id}`,
  }, { dedupeKey: `skill-experiment-promoted:${experiment.id}` }).catch(() => undefined);
}

/** Retries a failed pull request on an approved experiment. */
export async function retryPromotion(project: string, experimentId: string): Promise<SkillExperimentSummary> {
  const experiment = await db.query.skillExperiments.findFirst({
    where: and(eq(skillExperiments.id, experimentId), eq(skillExperiments.project, project)),
  });
  if (!experiment) throw new SkillExperimentError('not_found', 'Experiment not found.');
  if (experiment.status !== 'approved') {
    throw new SkillExperimentError('invalid_state', 'Only an approved experiment without a pull request can be retried.');
  }
  await promoteExperiment(experiment);
  const summary = await getSkillExperiment(project, experimentId);
  if (!summary) throw new SkillExperimentError('not_found', 'Experiment not found.');
  return summary;
}

export async function cancelSkillExperiment(project: string, experimentId: string): Promise<SkillExperimentSummary> {
  const [moved] = await db.update(skillExperiments)
    .set({ status: 'cancelled', updatedAt: new Date().toISOString() })
    .where(and(
      eq(skillExperiments.id, experimentId),
      eq(skillExperiments.project, project),
      inArray(skillExperiments.status, ['drafting', 'running'] satisfies SkillExperimentStatus[]),
    ))
    .returning({ id: skillExperiments.id });
  if (!moved) throw new SkillExperimentError('invalid_state', 'Only a drafting or running experiment can be cancelled.');
  await db.update(skillExperimentRuns)
    .set({ status: 'skipped', updatedAt: new Date().toISOString() })
    .where(and(eq(skillExperimentRuns.experimentId, experimentId), eq(skillExperimentRuns.status, 'pending')));
  const summary = await getSkillExperiment(project, experimentId);
  if (!summary) throw new SkillExperimentError('not_found', 'Experiment not found.');
  return summary;
}

/** Periodic recovery: fail replays stuck in flight, keep running experiments moving, read approvals. */
export async function sweepSkillExperiments(now = Date.now()): Promise<void> {
  const cutoff = new Date(now - STUCK_RUN_MS).toISOString();
  await db.update(skillExperimentRuns)
    .set({ status: 'failed', error: 'The replay did not finish in time.', updatedAt: new Date(now).toISOString() })
    .where(and(inArray(skillExperimentRuns.status, IN_FLIGHT), lt(skillExperimentRuns.updatedAt, cutoff)));
  const stuckDrafts = await db.select({ id: skillExperiments.id }).from(skillExperiments)
    .where(and(eq(skillExperiments.status, 'drafting'), lt(skillExperiments.updatedAt, cutoff)));
  for (const draft of stuckDrafts) await failDraft(draft.id, 'The candidate draft did not finish in time.');
  const open = await db.select().from(skillExperiments)
    .where(inArray(skillExperiments.status, ['running', 'awaiting_approval'] satisfies SkillExperimentStatus[]));
  for (const experiment of open) {
    if (experiment.status === 'running') await advanceExperiment(experiment.id);
    else await checkApproval(experiment);
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────

function toSummary(experiment: ExperimentRow, runs: readonly Pick<RunRow, 'status' | 'caseKey'>[]): SkillExperimentSummary {
  return {
    id: experiment.id,
    project: experiment.project,
    subjectType: experiment.subjectType,
    skillPath: experiment.skillPath,
    baselineSha256: experiment.baselineSha256,
    candidateSha256: experiment.candidateSha256,
    candidateSource: experiment.candidateSource,
    changeNotes: experiment.changeNotes,
    status: experiment.status,
    error: experiment.error,
    cases: new Set(runs.map((r) => r.caseKey)).size,
    runsScored: runs.filter((r) => r.status === 'scored').length,
    runsFailed: runs.filter((r) => r.status === 'failed').length,
    estimatedCostUsd: money(experiment.estimatedCostUsd),
    spentUsd: money(experiment.spentUsd),
    result: experiment.result ?? null,
    pullRequestUrl: experiment.pullRequestUrl,
    createdBy: experiment.createdBy,
    createdAt: experiment.createdAt,
    updatedAt: experiment.updatedAt,
  };
}

export async function listSkillExperiments(project: string, limit = 25): Promise<SkillExperimentSummary[]> {
  const experiments = await db.select().from(skillExperiments)
    .where(eq(skillExperiments.project, project))
    .orderBy(desc(skillExperiments.createdAt))
    .limit(limit);
  if (experiments.length === 0) return [];
  const runs = await db.select({
    experimentId: skillExperimentRuns.experimentId,
    status: skillExperimentRuns.status,
    caseKey: skillExperimentRuns.caseKey,
  }).from(skillExperimentRuns).where(inArray(skillExperimentRuns.experimentId, experiments.map((e) => e.id)));
  return experiments.map((e) => toSummary(e, runs.filter((r) => r.experimentId === e.id)));
}

export async function getSkillExperiment(project: string, experimentId: string): Promise<SkillExperimentDetail | null> {
  const experiment = await db.query.skillExperiments.findFirst({
    where: and(eq(skillExperiments.id, experimentId), eq(skillExperiments.project, project)),
  });
  if (!experiment) return null;
  const runs = await db.select().from(skillExperimentRuns).where(eq(skillExperimentRuns.experimentId, experimentId));
  return {
    ...toSummary(experiment, runs),
    baselineContent: experiment.baselineContent,
    candidateContent: experiment.candidateContent,
    runs: runs.map((r) => ({
      id: r.id,
      caseKey: r.caseKey,
      caseKind: r.caseKind,
      split: r.split,
      arm: r.arm,
      status: r.status,
      overallScore: r.overallScore == null ? null : money(r.overallScore),
      error: r.error,
    })),
    postRelease: experiment.status === 'promoted' && experiment.pullRequestUrl && experiment.candidateContent !== null
      ? await buildPostReleaseReport({ ...experiment, candidateContent: experiment.candidateContent })
      : null,
  };
}
