/**
 * Agent Run Reaper Service
 *
 * Marks orphaned agent runs as failed when their heartbeat expires.
 * Handles two cases:
 *   1. Heartbeat expiry: status='running' AND heartbeat_at < now() - 90s
 *   2. Hard timeout: status='running' AND now() > timeout_at
 *
 * ## Wiring into server startup
 *
 * In `src/server/index.ts`, after the existing `startRecoveryLoop()` call, add:
 *
 *   import { startReaper } from './services/agentRunReaperService';
 *   startReaper();
 */
import { db } from '../db/drizzle';
import { agentRuns } from '../db/schema';
import { sql, and, eq, lt } from 'drizzle-orm';

const REAP_INTERVAL_MS = 60_000;

let reaperTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Reap runs where the worker died (heartbeat expired) or the run timed out.
 */
async function reapOrphanedRuns(): Promise<void> {
  try {
    // 1. Heartbeat-expired runs
    const heartbeatResult = await db.update(agentRuns)
      .set({
        status: 'failed',
        lastError: 'Worker lost (heartbeat expired)',
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(agentRuns.status, 'running'),
          lt(agentRuns.heartbeatAt, sql`now() - interval '90 seconds'`),
        ),
      )
      .returning({ id: agentRuns.id, threadId: agentRuns.threadId });

    for (const row of heartbeatResult) {
      console.log(`[reaper] Reaped orphaned run (id=${row.id}, threadId=${row.threadId}) — heartbeat expired`);
    }

    // 2. Hard-timeout runs
    const timeoutResult = await db.update(agentRuns)
      .set({
        status: 'failed',
        lastError: 'Run timed out',
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(agentRuns.status, 'running'),
          lt(agentRuns.timeoutAt, sql`now()`),
        ),
      )
      .returning({ id: agentRuns.id, threadId: agentRuns.threadId });

    for (const row of timeoutResult) {
      console.log(`[reaper] Reaped timed-out run (id=${row.id}, threadId=${row.threadId})`);
    }

    // 3. Stale queued runs — inserted but never claimed (worker crashed before claim)
    const staleQueuedResult = await db.update(agentRuns)
      .set({
        status: 'failed',
        lastError: 'Never claimed (worker lost before lease)',
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(agentRuns.status, 'queued'),
          lt(agentRuns.createdAt, sql`now() - interval '90 seconds'`),
        ),
      )
      .returning({ id: agentRuns.id, threadId: agentRuns.threadId });

    for (const row of staleQueuedResult) {
      console.log(`[reaper] Reaped stale queued run (id=${row.id}, threadId=${row.threadId})`);
    }
  } catch (err) {
    console.error('[reaper] Failed to reap orphaned runs:', err);
  }
}

/**
 * Start the reaper: run immediately on startup, then repeat on interval.
 */
export function startReaper(): void {
  reapOrphanedRuns().catch((err) => {
    console.error('[reaper] Initial reap failed:', err);
  });

  reaperTimer = setInterval(() => {
    reapOrphanedRuns().catch((err) => {
      console.error('[reaper] Periodic reap failed:', err);
    });
  }, REAP_INTERVAL_MS);
}

/**
 * Stop the reaper interval (for graceful shutdown).
 */
export function stopReaper(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}
