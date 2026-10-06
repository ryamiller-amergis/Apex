import os from 'os';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { rfpProposalJobs, rfpRequestEvents, rfpRequests } from '../db/schema';
import {
  RFP_PROPOSAL_JOB_ACTIVE_STATUSES,
  rfpTriageLink,
  type RfpDraftKind,
  type RfpGeneratedDraft,
  type RfpVerdict,
} from '../../shared/types/rfpIntake';
import { createNotification } from './notificationService';
import { loadRfpReviewState } from './rfpProposalFingerprint';
import {
  generateRfpDraft,
  type RfpGenerationJob,
  type RfpGenerationPhase,
} from './rfpProposalGenerationService';

export interface ClaimedRfpProposalJob extends RfpGenerationJob {
  attempts: number;
  maxAttempts: number;
}

export type RfpJobCompletion = 'ready' | 'superseded' | 'lost';

export class RfpLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Lost the lease on proposal job ${jobId}`);
    this.name = 'RfpLeaseLostError';
  }
}

const INSTANCE_ID = `${os.hostname()}:${process.pid}:rfp-proposal`;
const LEASE_MS = 10 * 60_000;
const HEARTBEAT_MS = 60_000;
const POLL_INTERVAL_MS = 5_000;
const INSTANCE_LIMIT = 2;
const RETRY_BASE_MS = 30_000;
const ERROR_MESSAGE_LIMIT = 300;

const ACTIVE = [...RFP_PROPOSAL_JOB_ACTIVE_STATUSES];

export function rfpRetryDelayMs(attempt: number): number {
  return RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] } | undefined)?.rows ?? [];
}

function ownedActive(jobId: string) {
  return and(
    eq(rfpProposalJobs.id, jobId),
    eq(rfpProposalJobs.ownerInstance, INSTANCE_ID),
    inArray(rfpProposalJobs.status, ACTIVE),
  );
}

export async function claimNextRfpProposalJob(): Promise<ClaimedRfpProposalJob | null> {
  const now = new Date();
  const lockExpiresAt = new Date(now.getTime() + LEASE_MS);
  const result = await db.execute(sql`
    WITH candidate AS (
      SELECT id FROM rfp_proposal_jobs
      WHERE status = 'queued' AND available_at <= now()
      ORDER BY available_at, created_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE rfp_proposal_jobs jobs
    SET status = CASE WHEN jobs.kind = 'proposal' THEN 'researching-prices' ELSE 'writing' END,
        owner_instance = ${INSTANCE_ID},
        heartbeat_at = ${now.toISOString()},
        lock_expires_at = ${lockExpiresAt.toISOString()},
        started_at = COALESCE(jobs.started_at, ${now.toISOString()}),
        attempts = jobs.attempts + 1,
        error_code = NULL,
        error_message = NULL,
        updated_at = ${now.toISOString()}
    FROM candidate
    WHERE jobs.id = candidate.id AND jobs.status = 'queued'
    RETURNING jobs.id, jobs.rfp_request_id, jobs.kind, jobs.verdict, jobs.input_fingerprint,
      jobs.requested_by, jobs.attempts, jobs.max_attempts
  `);
  const row = resultRows<Record<string, unknown>>(result)[0];
  if (!row) return null;
  return {
    id: String(row.id),
    rfpRequestId: String(row.rfp_request_id),
    kind: row.kind as RfpDraftKind,
    verdict: row.verdict as RfpVerdict,
    inputFingerprint: String(row.input_fingerprint),
    requestedBy: (row.requested_by as string | null) ?? null,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
  };
}

export async function markRfpProposalJobPhase(jobId: string, phase: RfpGenerationPhase): Promise<void> {
  const now = new Date().toISOString();
  const [updated] = await db.update(rfpProposalJobs)
    .set({ status: phase, updatedAt: now })
    .where(ownedActive(jobId))
    .returning({ id: rfpProposalJobs.id });
  if (!updated) throw new RfpLeaseLostError(jobId);
}

export async function renewRfpProposalJobLease(jobId: string): Promise<boolean> {
  const now = new Date();
  const [renewed] = await db.update(rfpProposalJobs)
    .set({
      heartbeatAt: now.toISOString(),
      lockExpiresAt: new Date(now.getTime() + LEASE_MS).toISOString(),
      updatedAt: now.toISOString(),
    })
    .where(ownedActive(jobId))
    .returning({ id: rfpProposalJobs.id });
  return Boolean(renewed);
}

async function notifyFailure(rfpRequestId: string, requestedBy: string | null): Promise<void> {
  if (!requestedBy) return;
  const request = await db.query.rfpRequests.findFirst({
    where: eq(rfpRequests.id, rfpRequestId),
    columns: { title: true },
  });
  try {
    await createNotification(requestedBy, {
      type: 'ai',
      title: 'Proposal generation failed',
      body: request?.title ?? 'An RFP proposal could not be generated. Open the request to retry.',
      link: rfpTriageLink(rfpRequestId),
    });
  } catch {
    // Delivery is best-effort; the failed status stays visible on the request.
  }
}

async function recordFailure(
  rfpRequestId: string,
  jobId: string,
  requestedBy: string | null,
  errorMessage: string,
): Promise<void> {
  await db.insert(rfpRequestEvents).values({
    rfpRequestId,
    eventType: 'proposal-generation-failed',
    actorId: null,
    payload: { jobId, errorMessage },
  });
  await notifyFailure(rfpRequestId, requestedBy);
}

/** Requeues jobs whose worker stopped heartbeating; fails those out of attempts. */
export async function recoverExpiredRfpProposalJobs(): Promise<{ requeued: number; failed: number }> {
  const now = new Date().toISOString();
  const message = 'Proposal generation stopped responding after the maximum attempts.';
  const failedResult = await db.execute(sql`
    UPDATE rfp_proposal_jobs
    SET status = 'failed', error_code = 'LEASE_EXPIRED', error_message = ${message},
        completed_at = ${now}, updated_at = ${now},
        owner_instance = NULL, heartbeat_at = NULL, lock_expires_at = NULL
    WHERE status IN ('researching-prices', 'writing')
      AND lock_expires_at < now()
      AND attempts >= max_attempts
    RETURNING id, rfp_request_id, requested_by
  `);
  const requeuedResult = await db.execute(sql`
    UPDATE rfp_proposal_jobs
    SET status = 'queued', available_at = ${now}, updated_at = ${now},
        owner_instance = NULL, heartbeat_at = NULL, lock_expires_at = NULL
    WHERE status IN ('researching-prices', 'writing')
      AND lock_expires_at < now()
      AND attempts < max_attempts
    RETURNING id
  `);
  const failed = resultRows<{ id: string; rfp_request_id: string; requested_by: string | null }>(failedResult);
  for (const row of failed) {
    await recordFailure(row.rfp_request_id, row.id, row.requested_by, message);
  }
  return { requeued: resultRows(requeuedResult).length, failed: failed.length };
}

/** Stores the draft only if this worker still owns the job and the review has not changed since it was queued. */
export async function completeRfpProposalJob(
  job: ClaimedRfpProposalJob,
  draft: RfpGeneratedDraft,
): Promise<RfpJobCompletion> {
  return db.transaction(async (tx) => {
    const now = new Date().toISOString();
    const state = await loadRfpReviewState(tx, job.rfpRequestId, { lock: true });
    const current = Boolean(
      state
      && state.row.currentProposalJobId === job.id
      && state.fingerprint === job.inputFingerprint,
    );
    const [updated] = await tx.update(rfpProposalJobs)
      .set({
        status: current ? 'ready' : 'superseded',
        draft: current ? draft : null,
        completedAt: now,
        updatedAt: now,
        ownerInstance: null,
        heartbeatAt: null,
        lockExpiresAt: null,
      })
      .where(ownedActive(job.id))
      .returning({ id: rfpProposalJobs.id });
    if (!updated) return 'lost';
    if (!current) return 'superseded';

    await tx.update(rfpRequests)
      .set({ proposalDraft: draft, updatedAt: now })
      .where(eq(rfpRequests.id, job.rfpRequestId));
    await tx.insert(rfpRequestEvents).values({
      rfpRequestId: job.rfpRequestId,
      eventType: job.kind === 'proposal' ? 'proposal-generation-completed' : 'decision-summary-generated',
      actorId: null,
      payload: { jobId: job.id, kind: job.kind },
    });
    return 'ready';
  });
}

function isRetryable(error: unknown): boolean {
  return (error as { retryable?: boolean } | null)?.retryable !== false;
}

function publicErrorMessage(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : 'The proposal could not be generated.';
  return message.slice(0, ERROR_MESSAGE_LIMIT);
}

export async function failOrRetryRfpProposalJob(job: ClaimedRfpProposalJob, error: unknown): Promise<'retry' | 'failed' | 'lost'> {
  const now = new Date();
  const terminal = job.attempts >= job.maxAttempts || !isRetryable(error);
  const errorMessage = publicErrorMessage(error);
  const [updated] = await db.update(rfpProposalJobs)
    .set({
      status: terminal ? 'failed' : 'queued',
      availableAt: terminal ? undefined : new Date(now.getTime() + rfpRetryDelayMs(job.attempts)).toISOString(),
      completedAt: terminal ? now.toISOString() : null,
      errorCode: (error as { code?: string } | null)?.code ?? 'GENERATION_FAILED',
      errorMessage,
      updatedAt: now.toISOString(),
      ownerInstance: null,
      heartbeatAt: null,
      lockExpiresAt: null,
    })
    .where(ownedActive(job.id))
    .returning({ id: rfpProposalJobs.id });
  if (!updated) return 'lost';
  console.error('[rfp-proposal] Generation failed', {
    jobId: job.id,
    attempt: job.attempts,
    maxAttempts: job.maxAttempts,
    terminal,
    error: errorMessage,
  });
  if (terminal) await recordFailure(job.rfpRequestId, job.id, job.requestedBy, errorMessage);
  return terminal ? 'failed' : 'retry';
}

async function recordStarted(job: ClaimedRfpProposalJob): Promise<void> {
  if (job.attempts !== 1) return;
  await db.insert(rfpRequestEvents).values({
    rfpRequestId: job.rfpRequestId,
    eventType: 'proposal-generation-started',
    actorId: null,
    payload: { jobId: job.id, kind: job.kind },
  });
}

export interface RfpProposalJobRunnerDeps {
  generate: (job: RfpGenerationJob, onPhase: (phase: RfpGenerationPhase) => Promise<void>) => Promise<RfpGeneratedDraft>;
  markPhase: (jobId: string, phase: RfpGenerationPhase) => Promise<void>;
  renewLease: (jobId: string) => Promise<boolean>;
  complete: (job: ClaimedRfpProposalJob, draft: RfpGeneratedDraft) => Promise<RfpJobCompletion>;
  failOrRetry: (job: ClaimedRfpProposalJob, error: unknown) => Promise<unknown>;
  recordStarted: (job: ClaimedRfpProposalJob) => Promise<void>;
  heartbeatMs: number;
}

const defaultRunnerDeps: RfpProposalJobRunnerDeps = {
  generate: generateRfpDraft,
  markPhase: markRfpProposalJobPhase,
  renewLease: renewRfpProposalJobLease,
  complete: completeRfpProposalJob,
  failOrRetry: failOrRetryRfpProposalJob,
  recordStarted,
  heartbeatMs: HEARTBEAT_MS,
};

export async function runClaimedRfpProposalJob(
  job: ClaimedRfpProposalJob,
  deps: RfpProposalJobRunnerDeps = defaultRunnerDeps,
): Promise<void> {
  const heartbeat = setInterval(() => {
    void deps.renewLease(job.id).catch((error) => {
      console.error('[rfp-proposal] Lease renewal failed', { jobId: job.id, error: String(error) });
    });
  }, deps.heartbeatMs);
  heartbeat.unref?.();
  try {
    await deps.recordStarted(job);
    const draft = await deps.generate(job, (phase) => deps.markPhase(job.id, phase));
    await deps.complete(job, draft);
  } catch (error) {
    if (error instanceof RfpLeaseLostError) return;
    await deps.failOrRetry(job, error);
  } finally {
    clearInterval(heartbeat);
  }
}

const activeJobs = new Set<string>();
let activeProcessor: Promise<void> | null = null;
let pollTimer: NodeJS.Timeout | undefined;

async function runProcessor(): Promise<void> {
  await recoverExpiredRfpProposalJobs();
  while (activeJobs.size < INSTANCE_LIMIT) {
    const job = await claimNextRfpProposalJob();
    if (!job) break;
    activeJobs.add(job.id);
    void runClaimedRfpProposalJob(job)
      .catch((error) => {
        console.error('[rfp-proposal] Job runner failed', { jobId: job.id, error: String(error) });
      })
      .finally(() => activeJobs.delete(job.id));
  }
}

export function processPendingRfpProposalJobs(): Promise<void> {
  if (activeProcessor) return activeProcessor;
  activeProcessor = runProcessor().finally(() => {
    activeProcessor = null;
  });
  return activeProcessor;
}

export function startRfpProposalWorker(): void {
  if (pollTimer) return;
  const poll = () => {
    void processPendingRfpProposalJobs().catch((error) => {
      console.error('[rfp-proposal] Poller failed', error);
    });
  };
  poll();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  pollTimer.unref?.();
  console.info('[rfp-proposal] Worker started', { instanceId: INSTANCE_ID, leaseMs: LEASE_MS });
}

export function stopRfpProposalWorker(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
}
