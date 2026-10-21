/**
 * Status changes for workflow evaluation jobs. Every update names the status
 * it expects, so two writers racing on one job cannot both win.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  agentRuns,
  workflowEvaluationDefinitions,
  workflowEvaluationEvents,
  workflowEvaluationJobs,
} from '../db/schema';
import {
  WORKFLOW_EVALUATION_JOB_EVALUATORS,
  type WorkflowEvaluationJob,
  type WorkflowEvaluationJobEvaluator,
  type WorkflowEvaluationJobResultBlobRefs,
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

export type FinishedJobFields = Readonly<{
  status: Extract<WorkflowEvaluationJobStatus, 'ready' | 'failed'>;
  summary: Record<string, unknown> | null;
  resultBlobRefs: WorkflowEvaluationJobResultBlobRefs | null;
  errorDetail: string | null;
}>;

/** Records a run's result only while that run still owns the running job. */
export async function finishRunningJob(
  jobId: string,
  runId: string,
  fields: FinishedJobFields,
): Promise<boolean> {
  const rows = await db
    .update(workflowEvaluationJobs)
    .set({ ...fields, updatedAt: sql`now()` })
    .where(and(
      eq(workflowEvaluationJobs.id, jobId),
      eq(workflowEvaluationJobs.runId, runId),
      eq(workflowEvaluationJobs.status, 'running'),
    ))
    .returning({ id: workflowEvaluationJobs.id });
  return rows.length > 0;
}

/** Running jobs whose run row is gone, or whose run finished before `cutoff`. */
export async function listStalledRunningJobs(
  cutoff: string,
  limit: number,
): Promise<WorkflowEvaluationJob[]> {
  const rows = await db
    .select({ job: workflowEvaluationJobs })
    .from(workflowEvaluationJobs)
    .leftJoin(agentRuns, eq(agentRuns.id, workflowEvaluationJobs.runId))
    .where(and(
      eq(workflowEvaluationJobs.status, 'running'),
      lt(workflowEvaluationJobs.updatedAt, cutoff),
      or(
        isNull(workflowEvaluationJobs.runId),
        and(
          inArray(agentRuns.status, ['completed', 'failed', 'cancelled']),
          lt(agentRuns.updatedAt, cutoff),
        ),
      ),
    ))
    .orderBy(asc(workflowEvaluationJobs.updatedAt))
    .limit(limit);
  return rows.map((row) => toJob(row.job));
}

/** Fails a running job only while it still points at the run the sweep saw. */
export async function failStalledRunningJob(
  jobId: string,
  runId: string | null,
  errorDetail: string,
): Promise<boolean> {
  const rows = await db
    .update(workflowEvaluationJobs)
    .set({ status: 'failed', errorDetail, updatedAt: sql`now()` })
    .where(and(
      eq(workflowEvaluationJobs.id, jobId),
      eq(workflowEvaluationJobs.status, 'running'),
      runId === null
        ? isNull(workflowEvaluationJobs.runId)
        : eq(workflowEvaluationJobs.runId, runId),
    ))
    .returning({ id: workflowEvaluationJobs.id });
  return rows.length > 0;
}

export async function getJudgeOutputSchema(eventId: string): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select({ schema: workflowEvaluationDefinitions.judgeOutputSchema })
    .from(workflowEvaluationEvents)
    .innerJoin(
      workflowEvaluationDefinitions,
      eq(workflowEvaluationDefinitions.id, workflowEvaluationEvents.definitionId),
    )
    .where(eq(workflowEvaluationEvents.id, eventId))
    .limit(1);
  return rows[0]?.schema ?? null;
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
  finishRunningJob,
  getJudgeOutputSchema,
  listStalledRunningJobs,
  failStalledRunningJob,
};

export type WorkflowEvaluationJobRepository = typeof workflowEvaluationJobRepository;
