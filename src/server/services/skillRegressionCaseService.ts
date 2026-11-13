/**
 * Regression cases for monthly skill improvement. A case is saved for each
 * review that scored a criterion at or below the rubric's low-score threshold,
 * or accepted the artifact after edits with corrected text. The case keeps a
 * full copy of the reviewed document when it still matches the review's hash.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/drizzle';
import {
  appUsers,
  skillRegressionCases,
  workflowEvaluationDefinitions,
  workflowEvaluationEvents,
} from '../db/schema';
import type { AiRunBlobRef } from '../../shared/types/aiRunV2';
import {
  SKILL_REGRESSION_CASE_STATUSES,
  SKILL_REGRESSION_STATUS_REASON_MAX,
  type SkillRegressionBackfillResult,
  type SkillRegressionCase,
  type SkillRegressionCaseFilters,
  type SkillRegressionCaseListResponse,
  type SkillRegressionCaseReason,
  type SkillRegressionCaseStatus,
  type SkillRegressionSnapshotStatus,
  type UpdateSkillRegressionCaseRequest,
} from '../../shared/types/skillRegressionCase';
import type {
  WorkflowEvaluationEvent,
  WorkflowEvaluationOutcome,
  WorkflowEvaluationSubjectType,
} from '../../shared/types/workflowEvaluation';
import { resolveCurrentArtifactBinding } from './artifactBindingResolver';
import { writeRegressionSnapshot } from './workflowEvaluationArtifactStore';
import { WorkflowEvaluationError } from './workflowEvaluationError';
import { getDefinitionById } from './workflowEvaluationRepository';
import { registerEventStoredListener } from './workflowEvaluationService';

const LIST_LIMIT = 200;
const BACKFILL_SNAPSHOT_LIMIT = 100;
const SKILL_PATH_MAX = 500;
const OPEN_SNAPSHOT_STATUSES: SkillRegressionSnapshotStatus[] = ['pending', 'failed'];

const reviewer = alias(appUsers, 'regression_case_reviewer');
const statusChanger = alias(appUsers, 'regression_case_status_changer');

export class SkillRegressionCaseRequestError extends Error {}

export function lowScoreCriteria(criteria: Record<string, number>, threshold: number): string[] {
  return Object.entries(criteria)
    .filter(([, score]) => score <= threshold)
    .map(([key]) => key)
    .sort();
}

export function regressionReason(input: {
  outcome: WorkflowEvaluationOutcome;
  hasCorrectedArtifact: boolean;
  criteria: Record<string, number>;
  lowScoreThreshold: number;
}): SkillRegressionCaseReason | null {
  const corrected = input.outcome === 'accept_after_edits' && input.hasCorrectedArtifact;
  const low = lowScoreCriteria(input.criteria, input.lowScoreThreshold).length > 0;
  if (corrected && low) return 'both';
  if (corrected) return 'corrected_text';
  if (low) return 'low_score';
  return null;
}

type CaseSeed = {
  project: string;
  eventId: string;
  subjectType: WorkflowEvaluationSubjectType;
  subjectId: string;
  phaseIndex: number | null;
  skillPath: string | null;
  skillVersion: string | null;
  artifactHash: string;
  reason: SkillRegressionCaseReason;
};

type SnapshotTarget = Pick<
  CaseSeed,
  'project' | 'eventId' | 'subjectType' | 'subjectId' | 'phaseIndex' | 'artifactHash'
> & { id: string };

const snapshotTargetColumns = {
  id: skillRegressionCases.id,
  project: skillRegressionCases.project,
  eventId: skillRegressionCases.eventId,
  subjectType: skillRegressionCases.subjectType,
  subjectId: skillRegressionCases.subjectId,
  phaseIndex: skillRegressionCases.phaseIndex,
  artifactHash: skillRegressionCases.artifactHash,
};

async function insertCase(seed: CaseSeed): Promise<SnapshotTarget | null> {
  const [row] = await db
    .insert(skillRegressionCases)
    .values(seed)
    .onConflictDoNothing({ target: skillRegressionCases.eventId })
    .returning(snapshotTargetColumns);
  return row ?? null;
}

async function setSnapshot(
  id: string,
  status: Exclude<SkillRegressionSnapshotStatus, 'pending'>,
  blobRef: AiRunBlobRef | null,
): Promise<SkillRegressionSnapshotStatus> {
  await db
    .update(skillRegressionCases)
    .set({ snapshotStatus: status, originalBlobRef: blobRef, updatedAt: sql`now()` })
    .where(and(
      eq(skillRegressionCases.id, id),
      inArray(skillRegressionCases.snapshotStatus, OPEN_SNAPSHOT_STATUSES),
    ));
  return status;
}

/** Copies the document only when it still hashes to what the reviewer saw. */
export async function captureSnapshot(target: SnapshotTarget): Promise<SkillRegressionSnapshotStatus> {
  let binding: Awaited<ReturnType<typeof resolveCurrentArtifactBinding>>;
  try {
    binding = await resolveCurrentArtifactBinding({
      project: target.project,
      subjectType: target.subjectType,
      subjectId: target.subjectId,
      phaseIndex: target.phaseIndex,
    });
  } catch (err) {
    if (err instanceof WorkflowEvaluationError) return setSnapshot(target.id, 'artifact_changed', null);
    console.error(`[skill-regression] document lookup failed (caseId=${target.id})`, err);
    return setSnapshot(target.id, 'failed', null);
  }
  if (binding.artifactHash !== target.artifactHash) {
    return setSnapshot(target.id, 'artifact_changed', null);
  }
  let blobRef: AiRunBlobRef;
  try {
    blobRef = await writeRegressionSnapshot(target.project, {
      version: 1,
      eventId: target.eventId,
      artifactHash: target.artifactHash,
      capturedAt: new Date().toISOString(),
      artifact: binding.artifact,
    });
  } catch (err) {
    console.error(`[skill-regression] snapshot write failed (caseId=${target.id})`, err);
    return setSnapshot(target.id, 'failed', null);
  }
  return setSnapshot(target.id, 'stored', blobRef);
}

/** Runs inside the submit request, so it only inserts the row; the copy happens after the response. */
export async function onEvaluationEventStored(event: WorkflowEvaluationEvent): Promise<void> {
  const definition = await getDefinitionById(event.definitionId);
  if (!definition) return;
  const reason = regressionReason({
    outcome: event.outcome,
    hasCorrectedArtifact: event.hasCorrectedArtifact,
    criteria: event.criteria,
    lowScoreThreshold: definition.rubric.lowScoreThreshold,
  });
  if (!reason) return;
  const created = await insertCase({
    project: event.projectId,
    eventId: event.id,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    phaseIndex: event.phaseIndex,
    skillPath: event.lineage.skillPath,
    skillVersion: event.lineage.skillVersion,
    artifactHash: event.artifactContentHash,
    reason,
  });
  if (!created) return;
  void captureSnapshot(created).catch((err: unknown) => {
    console.error(`[skill-regression] snapshot failed (caseId=${created.id})`, err);
  });
}

export function registerSkillRegressionCaseListener(): void {
  registerEventStoredListener(onEvaluationEventStored);
}

export function parseRegressionCaseFilters(query: Record<string, unknown>): SkillRegressionCaseFilters {
  const filters: SkillRegressionCaseFilters = {};
  const { status, skillPath } = query;
  if (status !== undefined && status !== '') {
    if (typeof status !== 'string' || !(SKILL_REGRESSION_CASE_STATUSES as readonly string[]).includes(status)) {
      throw new SkillRegressionCaseRequestError(`status must be one of ${SKILL_REGRESSION_CASE_STATUSES.join(', ')}`);
    }
    filters.status = status as SkillRegressionCaseStatus;
  }
  if (skillPath !== undefined && skillPath !== '') {
    if (typeof skillPath !== 'string' || skillPath.length > SKILL_PATH_MAX) {
      throw new SkillRegressionCaseRequestError('skillPath must be a string');
    }
    filters.skillPath = skillPath;
  }
  return filters;
}

export function parseRegressionCaseUpdate(body: unknown): UpdateSkillRegressionCaseRequest {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new SkillRegressionCaseRequestError('Request body must be an object.');
  }
  const { status, reason } = body as Record<string, unknown>;
  if (typeof status !== 'string' || !(SKILL_REGRESSION_CASE_STATUSES as readonly string[]).includes(status)) {
    throw new SkillRegressionCaseRequestError(`status must be one of ${SKILL_REGRESSION_CASE_STATUSES.join(', ')}`);
  }
  if (status === 'active') return { status: 'active' };
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (!trimmed) {
    throw new SkillRegressionCaseRequestError('Retiring a case needs a reason.');
  }
  if (trimmed.length > SKILL_REGRESSION_STATUS_REASON_MAX) {
    throw new SkillRegressionCaseRequestError(
      `The reason must be ${SKILL_REGRESSION_STATUS_REASON_MAX} characters or fewer.`,
    );
  }
  return { status: 'retired', reason: trimmed };
}

async function selectCases(where: SQL | undefined, limit: number): Promise<SkillRegressionCase[]> {
  const cases = skillRegressionCases;
  const events = workflowEvaluationEvents;
  const rows = await db
    .select({
      id: cases.id,
      eventId: cases.eventId,
      subjectType: cases.subjectType,
      subjectId: cases.subjectId,
      phaseIndex: cases.phaseIndex,
      stageKey: events.stageKey,
      skillPath: cases.skillPath,
      skillVersion: cases.skillVersion,
      reason: cases.reason,
      outcome: events.outcome,
      criteria: events.criteriaScores,
      rubric: workflowEvaluationDefinitions.rubric,
      comment: events.comment,
      reviewerName: reviewer.displayName,
      snapshotStatus: cases.snapshotStatus,
      status: cases.status,
      statusReason: cases.statusReason,
      statusChangedByName: statusChanger.displayName,
      statusChangedAt: cases.statusChangedAt,
      createdAt: cases.createdAt,
    })
    .from(cases)
    .innerJoin(events, eq(events.id, cases.eventId))
    .innerJoin(workflowEvaluationDefinitions, eq(workflowEvaluationDefinitions.id, events.definitionId))
    .leftJoin(reviewer, eq(reviewer.oid, events.reviewerUserId))
    .leftJoin(statusChanger, eq(statusChanger.oid, cases.statusChangedBy))
    .where(where)
    .orderBy(desc(cases.createdAt))
    .limit(limit);
  return rows.map(({ criteria, rubric, ...row }) => ({
    ...row,
    lowCriteria: lowScoreCriteria(criteria, rubric.lowScoreThreshold),
  }));
}

export async function listRegressionCases(
  project: string,
  filters: SkillRegressionCaseFilters,
): Promise<SkillRegressionCaseListResponse> {
  const cases = skillRegressionCases;
  const conditions = [eq(cases.project, project)];
  if (filters.status) conditions.push(eq(cases.status, filters.status));
  if (filters.skillPath) conditions.push(eq(cases.skillPath, filters.skillPath));
  const [rows, skillPaths] = await Promise.all([
    selectCases(and(...conditions), LIST_LIMIT),
    db
      .selectDistinct({ skillPath: cases.skillPath })
      .from(cases)
      .where(and(eq(cases.project, project), isNotNull(cases.skillPath)))
      .orderBy(asc(cases.skillPath)),
  ]);
  return {
    cases: rows,
    skillPaths: skillPaths.flatMap((row) => (row.skillPath ? [row.skillPath] : [])),
    limit: LIST_LIMIT,
  };
}

export async function updateRegressionCaseStatus(
  project: string,
  caseId: string,
  update: UpdateSkillRegressionCaseRequest,
  userId: string,
): Promise<SkillRegressionCase | null> {
  const cases = skillRegressionCases;
  const [row] = await db
    .update(cases)
    .set({
      status: update.status,
      statusReason: update.status === 'retired' ? update.reason ?? null : null,
      statusChangedBy: userId,
      statusChangedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(cases.id, caseId), eq(cases.project, project)))
    .returning({ id: cases.id });
  if (!row) return null;
  const [updated] = await selectCases(eq(cases.id, row.id), 1);
  return updated ?? null;
}

/**
 * Adds cases for reviews saved before this feature, then retries document
 * copies still pending or failed. Copies run one at a time, capped per call.
 */
export async function backfillRegressionCases(project: string): Promise<SkillRegressionBackfillResult> {
  const cases = skillRegressionCases;
  const events = workflowEvaluationEvents;
  const uncovered = await db
    .select({
      eventId: events.id,
      subjectType: events.subjectType,
      subjectId: events.subjectId,
      phaseIndex: events.phaseIndex,
      skillPath: events.skillPath,
      skillVersion: events.skillVersion,
      artifactHash: events.artifactHash,
      outcome: events.outcome,
      criteria: events.criteriaScores,
      correctedText: events.correctedArtifactText,
      correctedBlobRef: events.correctedArtifactBlobRef,
      rubric: workflowEvaluationDefinitions.rubric,
    })
    .from(events)
    .innerJoin(workflowEvaluationDefinitions, eq(workflowEvaluationDefinitions.id, events.definitionId))
    .leftJoin(cases, eq(cases.eventId, events.id))
    .where(and(eq(events.project, project), isNull(cases.id)))
    .orderBy(asc(events.createdAt));

  let created = 0;
  for (const { outcome, criteria, correctedText, correctedBlobRef, rubric, ...event } of uncovered) {
    const reason = regressionReason({
      outcome,
      hasCorrectedArtifact: correctedText != null || correctedBlobRef != null,
      criteria,
      lowScoreThreshold: rubric.lowScoreThreshold,
    });
    if (!reason) continue;
    if (await insertCase({ ...event, project, reason })) created += 1;
  }

  const open = await db
    .select(snapshotTargetColumns)
    .from(cases)
    .where(and(eq(cases.project, project), inArray(cases.snapshotStatus, OPEN_SNAPSHOT_STATUSES)))
    .orderBy(asc(cases.createdAt))
    .limit(BACKFILL_SNAPSHOT_LIMIT);

  const tally: Record<SkillRegressionSnapshotStatus, number> = {
    pending: 0,
    stored: 0,
    artifact_changed: 0,
    failed: 0,
  };
  for (const target of open) {
    tally[await captureSnapshot(target)] += 1;
  }

  const [remaining] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(cases)
    .where(and(eq(cases.project, project), inArray(cases.snapshotStatus, OPEN_SNAPSHOT_STATUSES)));

  return {
    created,
    stored: tally.stored,
    artifactChanged: tally.artifact_changed,
    failed: tally.failed,
    remaining: Math.max(0, (remaining?.count ?? 0) - tally.failed),
  };
}
