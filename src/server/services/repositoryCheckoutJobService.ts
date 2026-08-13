/**
 * Postgres claim/lease queue for admin repository checkout jobs.
 * Service Bus (or the in-process poller) only wakes a worker; this table is
 * the source of truth. Global cap is one claimed job with a live lease.
 */
import os from 'os';
import { sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { repositoryCheckoutJobs } from '../db/schema';

export type RepositoryCheckoutJobStatus = 'queued' | 'claimed' | 'succeeded' | 'failed';

export interface RepositoryCheckoutJobRow {
  id: string;
  skillSettingsId: string;
  refresh: boolean;
  status: RepositoryCheckoutJobStatus;
  attempts: number;
  ownerInstance: string | null;
  heartbeatAt: string | null;
  lockExpiresAt: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const INSTANCE_ID = `${os.hostname()}:${process.pid}`;
const LEASE_MS = 2 * 60_000;

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: T[] } | undefined)?.rows;
  return rows ?? [];
}

function asStatus(value: unknown): RepositoryCheckoutJobStatus {
  if (value === 'queued' || value === 'claimed' || value === 'succeeded' || value === 'failed') {
    return value;
  }
  return 'queued';
}

function mapJobRow(row: Record<string, unknown>): RepositoryCheckoutJobRow {
  return {
    id: String(row.id),
    skillSettingsId: String(row.skill_settings_id ?? row.skillSettingsId),
    refresh: Boolean(row.refresh),
    status: asStatus(row.status),
    attempts: Number(row.attempts ?? 0),
    ownerInstance: (row.owner_instance ?? row.ownerInstance ?? null) as string | null,
    heartbeatAt: (row.heartbeat_at ?? row.heartbeatAt ?? null) as string | null,
    lockExpiresAt: (row.lock_expires_at ?? row.lockExpiresAt ?? null) as string | null,
    errorMessage: (row.error_message ?? row.errorMessage ?? null) as string | null,
    startedAt: (row.started_at ?? row.startedAt ?? null) as string | null,
    completedAt: (row.completed_at ?? row.completedAt ?? null) as string | null,
    createdAt: String(row.created_at ?? row.createdAt),
    updatedAt: String(row.updated_at ?? row.updatedAt),
  };
}

export function isRepoCheckoutWorkerInProcess(): boolean {
  return process.env.REPO_CHECKOUT_WORKER_MODE?.trim().toLowerCase() === 'in-process';
}

export async function insertCheckoutJob(input: {
  skillSettingsId: string;
  refresh: boolean;
}): Promise<RepositoryCheckoutJobRow> {
  const [row] = await db
    .insert(repositoryCheckoutJobs)
    .values({
      skillSettingsId: input.skillSettingsId,
      refresh: input.refresh,
      status: 'queued',
    })
    .returning();
  return mapJobRow(row as unknown as Record<string, unknown>);
}

export async function claimNextCheckoutJob(): Promise<RepositoryCheckoutJobRow | null> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const lockExpiresAt = new Date(now.getTime() + LEASE_MS);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('apex_repo_checkout_claim'))`);
    const result = await tx.execute(sql`
      WITH candidate AS (
        SELECT jobs.id
        FROM repository_checkout_jobs jobs
        WHERE jobs.status = 'queued'
          AND (
            SELECT COUNT(*) FROM repository_checkout_jobs claimed
            WHERE claimed.status = 'claimed'
              AND claimed.lock_expires_at > now()
          ) < 1
        ORDER BY jobs.created_at, jobs.id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE repository_checkout_jobs jobs
      SET status = 'claimed',
          owner_instance = ${INSTANCE_ID},
          heartbeat_at = ${now.toISOString()},
          lock_expires_at = ${lockExpiresAt.toISOString()},
          started_at = COALESCE(jobs.started_at, ${now.toISOString()}),
          attempts = jobs.attempts + 1,
          updated_at = ${now.toISOString()}
      FROM candidate
      WHERE jobs.id = candidate.id
        AND jobs.status = 'queued'
      RETURNING jobs.*
    `);
    const row = resultRows<Record<string, unknown>>(result)[0];
    return row ? mapJobRow(row) : null;
  });
}

export async function renewCheckoutJobLease(jobId: string): Promise<boolean> {
  const now = new Date();
  const result = await db.execute(sql`
    UPDATE repository_checkout_jobs
    SET heartbeat_at = ${now.toISOString()},
        lock_expires_at = ${new Date(now.getTime() + LEASE_MS).toISOString()},
        updated_at = ${now.toISOString()}
    WHERE id = ${jobId}::uuid
      AND status = 'claimed'
      AND owner_instance = ${INSTANCE_ID}
    RETURNING id
  `);
  return resultRows(result).length > 0;
}

export async function completeCheckoutJob(
  jobId: string,
  outcome: 'succeeded' | 'failed',
  errorMessage?: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await db.execute(sql`
    UPDATE repository_checkout_jobs
    SET status = ${outcome},
        error_message = ${errorMessage ?? null},
        completed_at = ${now},
        lock_expires_at = NULL,
        updated_at = ${now}
    WHERE id = ${jobId}::uuid
  `);
}

export async function recoverExpiredCheckoutJobs(): Promise<RepositoryCheckoutJobRow[]> {
  const now = new Date().toISOString();
  const result = await db.execute(sql`
    UPDATE repository_checkout_jobs
    SET status = 'queued',
        owner_instance = NULL,
        lock_expires_at = NULL,
        updated_at = ${now}
    WHERE status = 'claimed'
      AND lock_expires_at IS NOT NULL
      AND lock_expires_at < ${now}
    RETURNING *
  `);
  return resultRows<Record<string, unknown>>(result).map(mapJobRow);
}

export function startCheckoutJobHeartbeat(jobId: string): () => void {
  const timer = setInterval(() => {
    void renewCheckoutJobLease(jobId).catch((error: unknown) => {
      console.error(
        '[repo-checkout] lease renewal failed:',
        error instanceof Error ? error.message : String(error),
      );
    });
  }, Math.floor(LEASE_MS / 3));
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
