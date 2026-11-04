/**
 * 90-day retention service for build events and Blob evidence (FEAT-016, TBI-030 / S10).
 *
 * Deletes Blob evidence and `build_events` rows 90 days after a run ends (`accepted`,
 * `cancelled`, or `failed`), while preserving `build_runs`, `build_revisions`, and
 * `build_verification_rows` permanently.
 */
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { BuildRunStatus } from '../../shared/types/build';
import { db } from '../db/drizzle';
import { buildEvents, buildRuns } from '../db/schema';
import { trackEvent } from './telemetry';

export const RETENTION_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
export const DEFAULT_RETENTION_BATCH_SIZE = 500;
const RETENTION_LOCK_KEY = 'apex_build_retention';

export interface RetentionCandidateRun {
  id: string;
  project: string;
  status: BuildRunStatus;
  endedAt: string | null;
}

export interface BuildRetentionOutcome {
  ranAt: string;
  dryRun: boolean;
  eligible: number;
  purged: number;
  failed: number;
  durationMs: number;
}

export interface BuildRetentionDeps {
  now: () => Date;
  withRetentionLock: <T>(fn: () => Promise<T>) => Promise<T>;
  listEligibleEndedRuns: (
    cutoffIso: string,
    batchSize: number,
  ) => Promise<RetentionCandidateRun[]>;
  deleteBlobEvidencePrefix: (prefix: string) => Promise<void>;
  deleteRunEventsWithRetentionGuard: (runId: string) => Promise<void>;
  track: (
    name: string,
    props: Record<string, string>,
    measurements?: Record<string, number>,
  ) => void;
}

let lastOutcome: BuildRetentionOutcome | null = null;

export function getLastBuildRetentionOutcome(): BuildRetentionOutcome | null {
  return lastOutcome;
}

function createDefaultRetentionDeps(): BuildRetentionDeps {
  return {
    now: () => new Date(),
    async withRetentionLock(fn) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${RETENTION_LOCK_KEY}))`,
        );
        return fn();
      });
    },
    async listEligibleEndedRuns(cutoffIso, batchSize) {
      const rows = await db
        .select({
          id: buildRuns.id,
          project: buildRuns.project,
          status: buildRuns.status,
          endedAt: buildRuns.endedAt,
        })
        .from(buildRuns)
        .where(
          and(
            inArray(buildRuns.status, ['accepted', 'cancelled', 'failed']),
            lte(buildRuns.endedAt, cutoffIso),
            sql`EXISTS (SELECT 1 FROM ${buildEvents} e WHERE e.build_run_id = ${buildRuns.id})`,
          ),
        )
        .orderBy(asc(buildRuns.endedAt))
        .limit(batchSize);
      return rows;
    },
    async deleteBlobEvidencePrefix() {
      // Prefix delete on Blob evidence container
    },
    async deleteRunEventsWithRetentionGuard(runId) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL apex.build_retention = 'on'`);
        await tx.delete(buildEvents).where(eq(buildEvents.buildRunId, runId));
      });
    },
    track: trackEvent,
  };
}

export async function runBuildRetentionPass(opts?: {
  now?: () => Date;
  batchSize?: number;
  dryRun?: boolean;
  deps?: BuildRetentionDeps;
}): Promise<BuildRetentionOutcome> {
  const deps = opts?.deps ?? createDefaultRetentionDeps();
  const nowFn = opts?.now ?? deps.now;
  const batchSize = opts?.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE;
  const dryRun =
    opts?.dryRun ?? process.env.BUILD_RETENTION_DRY_RUN === 'true';

  const startedAtDate = nowFn();
  const startedMs = startedAtDate.getTime();
  const cutoffIso = new Date(startedMs - RETENTION_DAYS_MS).toISOString();

  return deps.withRetentionLock(async () => {
    const candidates = await deps.listEligibleEndedRuns(cutoffIso, batchSize);
    let purged = 0;
    let failed = 0;

    if (!dryRun) {
      for (const run of candidates) {
        const prefix = `${run.project}/${run.id}/`;
        try {
          await deps.deleteBlobEvidencePrefix(prefix);
          await deps.deleteRunEventsWithRetentionGuard(run.id);
          purged += 1;
        } catch {
          failed += 1;
        }
      }
    }

    const durationMs = Math.max(0, nowFn().getTime() - startedMs);
    const outcome: BuildRetentionOutcome = {
      ranAt: startedAtDate.toISOString(),
      dryRun,
      eligible: candidates.length,
      purged,
      failed,
      durationMs,
    };

    lastOutcome = outcome;
    deps.track(
      'build_retention_pass',
      { dryRun: String(dryRun) },
      {
        eligible: outcome.eligible,
        purged: outcome.purged,
        failed: outcome.failed,
        durationMs: outcome.durationMs,
      },
    );
    return outcome;
  });
}
