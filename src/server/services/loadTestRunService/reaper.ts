/**
 * Stale-heartbeat reaper for load-test runs (FEAT-007 / A-011 / PBI-009 AC-2).
 * Marks dispatched/running runs with stale heartbeat_at as errored and frees the target lock.
 */
import { and, eq, inArray, lt, or, isNull } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { loadTestRuns } from '../../db/schema';
import type { LoadTestRun } from '../../../shared/types/loadTest';
import { publishRunProgress } from './progressHub';
import { mapRunRow } from './mapRun';
import { tryPromoteNextQueuedRun } from './promote';
import { scheduleRunCompletionActivity } from '../loadTestTraceabilityService';

const DEFAULT_STALE_MS = 5 * 60_000;
const DEFAULT_INTERVAL_MS = 60_000;

let reaperTimer: ReturnType<typeof setInterval> | null = null;

export function resolveHeartbeatStaleMs(): number {
  const parsed = Number(process.env.LT_RUN_HEARTBEAT_STALE_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_MS;
}

export async function reapStaleLoadTestRuns(options?: {
  now?: () => number;
  staleMs?: number;
}): Promise<LoadTestRun[]> {
  const nowMs = (options?.now ?? Date.now)();
  const staleMs = options?.staleMs ?? resolveHeartbeatStaleMs();
  const cutoffIso = new Date(nowMs - staleMs).toISOString();
  const nowIso = new Date(nowMs).toISOString();

  const staleRows = await db
    .select()
    .from(loadTestRuns)
    .where(
      and(
        inArray(loadTestRuns.status, ['dispatched', 'running']),
        or(isNull(loadTestRuns.heartbeatAt), lt(loadTestRuns.heartbeatAt, cutoffIso)),
      ),
    );

  const reaped: LoadTestRun[] = [];

  for (const row of staleRows) {
    // Dispatched cold-start may not have heartbeat yet — use queuedAt/updatedAt as baseline.
    const heartbeatBasis = row.heartbeatAt ?? row.startedAt ?? row.queuedAt;
    if (new Date(heartbeatBasis).getTime() > nowMs - staleMs) {
      continue;
    }

    const updated = await db
      .update(loadTestRuns)
      .set({
        status: 'errored',
        errorDetail: 'Stale heartbeat — run marked errored by reaper',
        completedAt: nowIso,
        updatedAt: nowIso,
      })
      .where(and(eq(loadTestRuns.id, row.id), inArray(loadTestRuns.status, ['dispatched', 'running'])))
      .returning();

    if (updated.length === 0) continue;

    const mapped = mapRunRow(updated[0]);
    reaped.push(mapped);
    publishRunProgress({
      type: 'terminal',
      runId: mapped.id,
      projectId: mapped.projectId,
      status: 'errored',
      at: nowIso,
    });

    if (mapped.targetKey) {
      await tryPromoteNextQueuedRun(mapped.projectId, mapped.targetKey);
    }
    scheduleRunCompletionActivity({ projectId: mapped.projectId, runId: mapped.id });
  }

  return reaped;
}

export function startLoadTestRunReaper(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (reaperTimer) return;
  void reapStaleLoadTestRuns().catch((err) => {
    console.error('[load-test-reaper] Initial reap failed:', err);
  });
  reaperTimer = setInterval(() => {
    void reapStaleLoadTestRuns().catch((err) => {
      console.error('[load-test-reaper] Periodic reap failed:', err);
    });
  }, intervalMs);
}

export function stopLoadTestRunReaper(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}
