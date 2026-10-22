/**
 * Read and insert access for workflow evaluation rows.
 * This module has no update or delete path. Events are append-only.
 */
import { and, asc, desc, eq, gte, inArray, like, lt, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  appUsers,
  workflowEvaluationDefinitions,
  workflowEvaluationEvents,
  workflowEvaluationJobs,
} from '../db/schema';
import type { AiRunBlobRef } from '../../shared/types/aiRunV2';
import type {
  HumanEvaluationEvent,
  WorkflowEvaluationCriteriaScores,
  WorkflowEvaluationDefinition,
  WorkflowEvaluationJob,
  WorkflowEvaluationOutcome,
  WorkflowEvaluationReasonCode,
  WorkflowEvaluationSubjectType,
} from '../../shared/types/workflowEvaluation';
import { WORKFLOW_EVALUATION_DEFINITION_EVALUATOR_KEY } from '../../shared/types/workflowEvaluation';

export type WorkflowEvaluationEventRecord = HumanEvaluationEvent & {
  processKey: string;
  definitionVersion: number;
  reviewerName: string | null;
};

export type InsertWorkflowEvaluationEvent = {
  id: string;
  project: string;
  definitionId: string;
  subjectType: WorkflowEvaluationSubjectType;
  subjectId: string;
  stageKey: string;
  phaseIndex: number | null;
  reviewerUserId: string;
  reviewerRoleKey: string;
  reviewerRoleLabel: string;
  skillPath: string | null;
  skillVersion: string | null;
  model: string | null;
  interviewId: string | null;
  prdId: string | null;
  artifactHash: string;
  criteriaScores: WorkflowEvaluationCriteriaScores;
  outcome: WorkflowEvaluationOutcome;
  reasonCodes: WorkflowEvaluationReasonCode[];
  comment: string | null;
  correctedArtifactBlobRef: AiRunBlobRef | null;
};

type JoinedEventRow = {
  event: typeof workflowEvaluationEvents.$inferSelect;
  processKey: string;
  definitionVersion: number;
  reviewerName: string | null;
};

function toRecord(row: JoinedEventRow): WorkflowEvaluationEventRecord {
  const event = row.event;
  return {
    id: event.id,
    project: event.project,
    definitionId: event.definitionId,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    stageKey: event.stageKey,
    phaseIndex: event.phaseIndex,
    reviewerUserId: event.reviewerUserId,
    reviewerRoleKey: event.reviewerRoleKey,
    reviewerRoleLabel: event.reviewerRoleLabel,
    skillPath: event.skillPath,
    skillVersion: event.skillVersion,
    model: event.model,
    interviewId: event.interviewId,
    prdId: event.prdId,
    artifactHash: event.artifactHash,
    criteriaScores: event.criteriaScores,
    outcome: event.outcome,
    reasonCodes: event.reasonCodes,
    comment: event.comment,
    correctedArtifactText: event.correctedArtifactText,
    correctedArtifactBlobRef: event.correctedArtifactBlobRef,
    createdAt: event.createdAt,
    processKey: row.processKey,
    definitionVersion: row.definitionVersion,
    reviewerName: row.reviewerName,
  };
}

function toDefinition(row: typeof workflowEvaluationDefinitions.$inferSelect): WorkflowEvaluationDefinition {
  return {
    id: row.id,
    processKey: row.processKey,
    stageKey: row.stageKey,
    evaluatorKey: row.evaluatorKey,
    benchmarkKey: row.benchmarkKey,
    version: row.version,
    rubric: row.rubric,
    promptfooSuiteRef: row.promptfooSuiteRef,
    judgeOutputSchema: row.judgeOutputSchema,
    active: row.active,
    createdAt: row.createdAt,
  };
}

const eventJoin = {
  event: workflowEvaluationEvents,
  processKey: workflowEvaluationDefinitions.processKey,
  definitionVersion: workflowEvaluationDefinitions.version,
  reviewerName: appUsers.displayName,
};

export async function getActiveDefinition(stageKey: string): Promise<WorkflowEvaluationDefinition | null> {
  const rows = await db
    .select()
    .from(workflowEvaluationDefinitions)
    .where(and(
      eq(workflowEvaluationDefinitions.stageKey, stageKey),
      eq(workflowEvaluationDefinitions.active, true),
      eq(workflowEvaluationDefinitions.evaluatorKey, WORKFLOW_EVALUATION_DEFINITION_EVALUATOR_KEY),
    ))
    .orderBy(desc(workflowEvaluationDefinitions.version))
    .limit(1);
  return rows[0] ? toDefinition(rows[0]) : null;
}

/** The exact version an event was scored against, active or not. */
export async function getDefinitionById(id: string): Promise<WorkflowEvaluationDefinition | null> {
  const rows = await db
    .select()
    .from(workflowEvaluationDefinitions)
    .where(eq(workflowEvaluationDefinitions.id, id))
    .limit(1);
  return rows[0] ? toDefinition(rows[0]) : null;
}

export async function listActiveDefinitions(stageKey?: string): Promise<WorkflowEvaluationDefinition[]> {
  const filters = [
    eq(workflowEvaluationDefinitions.active, true),
    eq(workflowEvaluationDefinitions.evaluatorKey, WORKFLOW_EVALUATION_DEFINITION_EVALUATOR_KEY),
  ];
  if (stageKey) filters.push(eq(workflowEvaluationDefinitions.stageKey, stageKey));
  const rows = await db
    .select()
    .from(workflowEvaluationDefinitions)
    .where(and(...filters))
    .orderBy(desc(workflowEvaluationDefinitions.version));
  const highest = new Map<string, WorkflowEvaluationDefinition>();
  for (const row of rows) {
    const definition = toDefinition(row);
    const current = highest.get(definition.stageKey);
    if (!current || definition.version > current.version) {
      highest.set(definition.stageKey, definition);
    }
  }
  return [...highest.values()];
}

export async function getReviewerDisplayName(userId: string): Promise<string | null> {
  const rows = await db
    .select({ displayName: appUsers.displayName })
    .from(appUsers)
    .where(eq(appUsers.oid, userId))
    .limit(1);
  return rows[0]?.displayName ?? null;
}

export async function insertEvent(
  input: InsertWorkflowEvaluationEvent,
): Promise<WorkflowEvaluationEventRecord> {
  await db.insert(workflowEvaluationEvents).values({
    id: input.id,
    project: input.project,
    definitionId: input.definitionId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    stageKey: input.stageKey,
    phaseIndex: input.phaseIndex,
    reviewerUserId: input.reviewerUserId,
    reviewerRoleKey: input.reviewerRoleKey,
    reviewerRoleLabel: input.reviewerRoleLabel,
    skillPath: input.skillPath,
    skillVersion: input.skillVersion,
    model: input.model,
    interviewId: input.interviewId,
    prdId: input.prdId,
    artifactHash: input.artifactHash,
    criteriaScores: input.criteriaScores,
    outcome: input.outcome,
    reasonCodes: input.reasonCodes,
    comment: input.comment,
    correctedArtifactText: null,
    correctedArtifactBlobRef: input.correctedArtifactBlobRef,
  });
  const stored = await getEventRecord(input.project, input.id);
  if (!stored) {
    throw new Error('Stored evaluation event could not be read back.');
  }
  return stored;
}

export async function listEventsForSubject(query: {
  project: string;
  subjectType: WorkflowEvaluationSubjectType;
  subjectId: string;
  stageKey?: string;
  artifactHash?: string;
  limit: number;
}): Promise<WorkflowEvaluationEventRecord[]> {
  const filters = [
    eq(workflowEvaluationEvents.project, query.project),
    eq(workflowEvaluationEvents.subjectType, query.subjectType),
    eq(workflowEvaluationEvents.subjectId, query.subjectId),
  ];
  if (query.stageKey) filters.push(eq(workflowEvaluationEvents.stageKey, query.stageKey));
  if (query.artifactHash) filters.push(eq(workflowEvaluationEvents.artifactHash, query.artifactHash));
  const rows = await db
    .select(eventJoin)
    .from(workflowEvaluationEvents)
    .innerJoin(
      workflowEvaluationDefinitions,
      eq(workflowEvaluationEvents.definitionId, workflowEvaluationDefinitions.id),
    )
    .leftJoin(appUsers, eq(workflowEvaluationEvents.reviewerUserId, appUsers.oid))
    .where(and(...filters))
    .orderBy(desc(workflowEvaluationEvents.createdAt), desc(workflowEvaluationEvents.id))
    .limit(query.limit);
  return rows.map(toRecord);
}

export async function getEventWithJobs(
  project: string,
  eventId: string,
): Promise<(WorkflowEvaluationEventRecord & { jobs: WorkflowEvaluationJob[] }) | null> {
  const record = await getEventRecord(project, eventId);
  if (!record) return null;
  const jobs = await db
    .select()
    .from(workflowEvaluationJobs)
    .where(eq(workflowEvaluationJobs.eventId, eventId))
    .orderBy(asc(workflowEvaluationJobs.createdAt));
  return { ...record, jobs: jobs.map(toJob) };
}

function toJob(job: typeof workflowEvaluationJobs.$inferSelect): WorkflowEvaluationJob {
  return {
    id: job.id,
    eventId: job.eventId,
    evaluatorKey: job.evaluatorKey,
    status: job.status,
    runId: job.runId,
    specificationHash: job.specificationHash,
    summary: job.summary,
    resultBlobRefs: job.resultBlobRefs,
    errorDetail: job.errorDetail,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export type ProjectEventFilters = {
  stageKey?: string;
  outcome?: WorkflowEvaluationOutcome;
  reasonCode?: string;
  subjectType?: WorkflowEvaluationSubjectType;
  /** Inclusive lower bound, ISO timestamp. */
  createdFrom?: string;
  /** Exclusive upper bound, ISO timestamp. */
  createdBefore?: string;
  /** Event id prefix or exact subject id. */
  search?: string;
  eventId?: string;
};

export type ProjectEventCursor = { createdAt: string; id: string };

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** Newest first, keyed on (created_at, id) so paging is stable while new events arrive. */
export async function listProjectEvents(query: {
  project: string;
  filters: ProjectEventFilters;
  after?: ProjectEventCursor;
  limit: number;
}): Promise<WorkflowEvaluationEventRecord[]> {
  const { filters, after } = query;
  const events = workflowEvaluationEvents;
  const conditions: SQL[] = [eq(events.project, query.project)];
  if (filters.stageKey) conditions.push(eq(events.stageKey, filters.stageKey));
  if (filters.outcome) conditions.push(eq(events.outcome, filters.outcome));
  if (filters.subjectType) conditions.push(eq(events.subjectType, filters.subjectType));
  if (filters.eventId) conditions.push(eq(events.id, filters.eventId));
  if (filters.reasonCode) {
    conditions.push(sql`${events.reasonCodes} @> ${JSON.stringify([filters.reasonCode])}::jsonb`);
  }
  if (filters.createdFrom) conditions.push(gte(events.createdAt, filters.createdFrom));
  if (filters.createdBefore) conditions.push(lt(events.createdAt, filters.createdBefore));
  if (filters.search) {
    const search = or(
      like(sql`${events.id}::text`, `${escapeLike(filters.search.toLowerCase())}%`),
      eq(events.subjectId, filters.search),
    );
    if (search) conditions.push(search);
  }
  if (after) {
    const page = or(
      lt(events.createdAt, after.createdAt),
      and(eq(events.createdAt, after.createdAt), lt(events.id, after.id)),
    );
    if (page) conditions.push(page);
  }
  const rows = await db
    .select(eventJoin)
    .from(events)
    .innerJoin(
      workflowEvaluationDefinitions,
      eq(events.definitionId, workflowEvaluationDefinitions.id),
    )
    .leftJoin(appUsers, eq(events.reviewerUserId, appUsers.oid))
    .where(and(...conditions))
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(query.limit);
  return rows.map(toRecord);
}

export async function listJobsForEvents(eventIds: readonly string[]): Promise<WorkflowEvaluationJob[]> {
  if (eventIds.length === 0) return [];
  const rows = await db
    .select()
    .from(workflowEvaluationJobs)
    .where(inArray(workflowEvaluationJobs.eventId, [...eventIds]))
    .orderBy(asc(workflowEvaluationJobs.createdAt));
  return rows.map(toJob);
}

async function getEventRecord(
  project: string,
  eventId: string,
): Promise<WorkflowEvaluationEventRecord | null> {
  const rows = await db
    .select(eventJoin)
    .from(workflowEvaluationEvents)
    .innerJoin(
      workflowEvaluationDefinitions,
      eq(workflowEvaluationEvents.definitionId, workflowEvaluationDefinitions.id),
    )
    .leftJoin(appUsers, eq(workflowEvaluationEvents.reviewerUserId, appUsers.oid))
    .where(and(
      eq(workflowEvaluationEvents.project, project),
      eq(workflowEvaluationEvents.id, eventId),
    ))
    .limit(1);
  return rows[0] ? toRecord(rows[0]) : null;
}
