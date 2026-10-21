/**
 * Status changes for workflow evaluation jobs. Every update names the status
 * it expects, so two writers racing on one job cannot both win.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { agentRuns, workflowEvaluationJobs } from '../db/schema';
import {
  WORKFLOW_EVALUATION_JOB_EVALUATORS,
  type WorkflowEvaluationJob,
  type WorkflowEvaluationJobEvaluator,
  type WorkflowEvaluationJobStatus,
} from '../../shared/types/workflowEvaluation';

type JobRow = typeof workflowEvaluationJobs.$inferSelect;

function toJob(row: JobRow): WorkflowEvaluationJob {
  return {
    id: row.id,
    eventId: row.eventId,
    evaluatorKey: row.evaluatorKey,
    status: row.status,
    runId: row.runId,
    specificationHash: row.specificationHash,
    summary: row.summary,
    resultBlobRefs: row.resultBlobRefs,
    errorDetail: row.errorDetail,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Inserts the pair for an event; a repeat call adds nothing and returns the existing rows. */
export async function createPendingJobs(eventId: string): Promise<WorkflowEvaluationJob[]> {
  await db
    .insert(workflowEvaluationJobs)
    .values(WORKFLOW_EVALUATION_JOB_EVALUATORS.map((evaluatorKey) => ({ eventId, evaluatorKey })))
    .onConflictDoNothing({
      target: [workflowEvaluationJobs.eventId, workflowEvaluationJobs.evaluatorKey],
    });
  const rows = await db
    .select()
    .from(workflowEvaluationJobs)
    .where(eq(workflowEvaluationJobs.eventId, eventId))
    .orderBy(asc(workflowEvaluationJobs.evaluatorKey));
  return rows.map(toJob);
}

export async function getJob(
  eventId: string,
  evaluatorKey: WorkflowEvaluationJobEvaluator,
): Promise<WorkflowEvaluationJob | null> {
  const rows = await db
    .select()
    .from(workflowEvaluationJobs)
    .where(and(
      eq(workflowEvaluationJobs.eventId, eventId),
      eq(workflowEvaluationJobs.evaluatorKey, evaluatorKey),
    ))
    .limit(1);
  return rows[0] ? toJob(rows[0]) : null;
}

/**
 * Claims a pending job for enqueue by storing its specification hash. Only one
 * caller can claim it, because the hash must still be empty.
 */
export async function claimPendingJob(jobId: string, specificationHash: string): Promise<boolean> {
  const rows = await db
    .update(workflowEvaluationJobs)
    .set({ specificationHash, updatedAt: sql`now()` })
    .where(and(
      eq(workflowEvaluationJobs.id, jobId),
      eq(workflowEvaluationJobs.status, 'pending'),
      isNull(workflowEvaluationJobs.specificationHash),
    ))
    .returning({ id: workflowEvaluationJobs.id });
  return rows.length > 0;
}

/** The run id is written after admission, because `run_id` references `agent_runs`. */
export async function markJobRunning(jobId: string, runId: string): Promise<boolean> {
  const rows = await db
    .update(workflowEvaluationJobs)
    .set({ status: 'running', runId, errorDetail: null, updatedAt: sql`now()` })
    .where(and(
      eq(workflowEvaluationJobs.id, jobId),
      eq(workflowEvaluationJobs.status, 'pending'),
    ))
    .returning({ id: workflowEvaluationJobs.id });
  return rows.length > 0;
}

export async function failJob(
  jobId: string,
  errorDetail: string,
  fromStatuses: readonly WorkflowEvaluationJobStatus[],
): Promise<boolean> {
  const rows = await db
    .update(workflowEvaluationJobs)
    .set({ status: 'failed', errorDetail, updatedAt: sql`now()` })
    .where(and(
      eq(workflowEvaluationJobs.id, jobId),
      inArray(workflowEvaluationJobs.status, [...fromStatuses]),
    ))
    .returning({ id: workflowEvaluationJobs.id });
  return rows.length > 0;
}

/** Fails a pending job only if nothing has touched it since `cutoff`, so a fresh retry is safe. */
export async function failStalePendingJob(
  jobId: string,
  cutoff: string,
  errorDetail: string,
): Promise<boolean> {
  const rows = await db
    .update(workflowEvaluationJobs)
    .set({ status: 'failed', errorDetail, updatedAt: sql`now()` })
    .where(and(
      eq(workflowEvaluationJobs.id, jobId),
      eq(workflowEvaluationJobs.status, 'pending'),
      lt(workflowEvaluationJobs.updatedAt, cutoff),
    ))
    .returning({ id: workflowEvaluationJobs.id });
  return rows.length > 0;
}

export async function listStalePendingJobs(
  cutoff: string,
  limit: number,
): Promise<WorkflowEvaluationJob[]> {
  const rows = await db
    .select()
    .from(workflowEvaluationJobs)
    .where(and(
      eq(workflowEvaluationJobs.status, 'pending'),
      lt(workflowEvaluationJobs.updatedAt, cutoff),
    ))
    .orderBy(asc(workflowEvaluationJobs.updatedAt))
    .limit(limit);
  return rows.map(toJob);
}

/** Latest run on a job's thread created at or after `since`, if admission got that far. */
export async function findRunOnThreadSince(threadId: string, since: string): Promise<string | null> {
  const rows = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.threadId, threadId), gte(agentRuns.createdAt, since)))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Moves a failed job back to pending and clears the previous attempt, so a
 * late result from the old run cannot be applied to it.
 */
export async function claimFailedJobForRetry(
  eventId: string,
  evaluatorKey: WorkflowEvaluationJobEvaluator,
): Promise<WorkflowEvaluationJob | null> {
  const rows = await db
    .update(workflowEvaluationJobs)
    .set({
      status: 'pending',
      runId: null,
      specificationHash: null,
      summary: null,
      resultBlobRefs: null,
      errorDetail: null,
      updatedAt: sql`now()`,
    })
    .where(and(
      eq(workflowEvaluationJobs.eventId, eventId),
      eq(workflowEvaluationJobs.evaluatorKey, evaluatorKey),
      eq(workflowEvaluationJobs.status, 'failed'),
    ))
    .returning();
  return rows[0] ? toJob(rows[0]) : null;
}

export const workflowEvaluationJobRepository = {
  createPendingJobs,
  getJob,
  claimPendingJob,
  markJobRunning,
  failJob,
  failStalePendingJob,
  listStalePendingJobs,
  findRunOnThreadSince,
  claimFailedJobForRetry,
};

export type WorkflowEvaluationJobRepository = typeof workflowEvaluationJobRepository;
