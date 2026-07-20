/**
 * Agent Run Reaper Service
 *
 * Marks orphaned agent runs as failed and surfaces progress SLA warnings.
 * Worker heartbeat and meaningful progress are deliberately evaluated as
 * separate clocks: an alive worker can be stale, and a recently productive
 * run can still be abandoned when its worker heartbeat stops.
 */
import { db } from '../db/drizzle';
import { agentRuns, chatThreads } from '../db/schema';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type {
  AgentRunEventStatus,
  AgentRunHealth,
  AgentRunPhase,
  SseHealthEvent,
} from '../../shared/types/chat';
import {
  nextRunEventSequence,
  notifyRunEvent,
  RUN_EVENT_SOURCE_INSTANCE,
} from './pgNotifyService';
import { getMyWorkSessionContext, logMyWorkSession } from './myWorkSessionLogger';

const REAP_INTERVAL_MS = 60_000;
const LONG_RUNNING_PREFIX = 'Long-running agent run';
const WATCHDOG_SOURCE_INSTANCE = `${RUN_EVENT_SOURCE_INSTANCE}:watchdog`;

let reaperTimer: ReturnType<typeof setInterval> | null = null;

export interface AgentRunHealthConfig {
  heartbeatTimeoutMs: number;
  queuedTimeoutMs: number;
  progressStaleMs: number;
  longRunMs: number;
  hardLimitMs: number;
}

export interface AgentRunHealthSnapshot {
  status: string;
  createdAt: string;
  startedAt: string | null;
  heartbeatAt: string | null;
  progressAt?: string | null;
  timeoutAt: string | null;
}

export interface ReaperOptions {
  now?: () => number;
  config?: AgentRunHealthConfig;
}

function positiveDuration(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveAgentRunHealthConfig(): AgentRunHealthConfig {
  return {
    heartbeatTimeoutMs: positiveDuration(process.env.AGENT_HEARTBEAT_TIMEOUT_MS, 5 * 60_000),
    queuedTimeoutMs: positiveDuration(process.env.AGENT_QUEUE_TIMEOUT_MS, 90_000),
    progressStaleMs: positiveDuration(process.env.AGENT_PROGRESS_STALE_MS, 2 * 60_000),
    longRunMs: positiveDuration(process.env.AGENT_LONG_RUN_MS, 30 * 60_000),
    hardLimitMs: positiveDuration(process.env.AGENT_RUN_HARD_LIMIT_MS, 2 * 60 * 60_000),
  };
}

async function publishHealthEvent(input: {
  runId: string;
  threadId: string;
  health: AgentRunHealth;
  detail: string;
  timestamp: string;
  phase?: AgentRunPhase | null;
  status: AgentRunEventStatus;
}): Promise<void> {
  const event: SseHealthEvent = {
    type: 'health',
    health: input.health,
    detail: input.detail.replace(/\s+/g, ' ').trim().slice(0, 500),
    runId: input.runId,
    eventTimestamp: input.timestamp,
  };
  await notifyRunEvent({
    eventId: randomUUID(),
    threadId: input.threadId,
    runId: input.runId,
    sourceInstance: WATCHDOG_SOURCE_INSTANCE,
    sequence: nextRunEventSequence(input.runId, WATCHDOG_SOURCE_INSTANCE),
    timestamp: input.timestamp,
    type: 'health',
    phase: input.phase ?? 'completion',
    status: input.status,
    detail: event.detail,
    event,
  }, { persist: true });
}

function ageMs(timestamp: string | null | undefined, nowMs: number): number {
  if (!timestamp) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? nowMs - parsed : Number.POSITIVE_INFINITY;
}

export function assessAgentRunHealth(
  run: AgentRunHealthSnapshot,
  nowMs: number,
  config: AgentRunHealthConfig,
): AgentRunHealth {
  if (run.status === 'queued') {
    return ageMs(run.createdAt, nowMs) >= config.queuedTimeoutMs ? 'never_claimed' : 'healthy';
  }
  if (run.status !== 'running') return 'healthy';

  const runStartedAt = run.startedAt ?? run.createdAt;
  const configuredTimeoutReached = ageMs(runStartedAt, nowMs) >= config.hardLimitMs;
  const rowTimeoutReached = Boolean(run.timeoutAt && Date.parse(run.timeoutAt) <= nowMs);
  if (configuredTimeoutReached || rowTimeoutReached) return 'hard_timeout';
  if (ageMs(run.heartbeatAt, nowMs) >= config.heartbeatTimeoutMs) return 'worker_lost';

  // progressAt is intentionally independent of heartbeatAt. The fallback keeps
  // pre-migration rows bounded until the progress_at column is populated.
  const meaningfulProgressAt = run.progressAt ?? run.startedAt ?? run.createdAt;
  if (ageMs(meaningfulProgressAt, nowMs) >= config.progressStaleMs) return 'progress_stale';
  if (ageMs(runStartedAt, nowMs) >= config.longRunMs) return 'long_running';
  return 'healthy';
}

/**
 * Cross-instance liveness check for a thread's agent run.
 *
 * Unlike in-memory `isThreadIdle`, this reads `agent_runs` and treats a run as
 * alive while any queued/running row is not terminal (`worker_lost`,
 * `hard_timeout`, `never_claimed`). Use this before failing generation so
 * non-owner instances do not discard work still owned by another worker.
 */
export async function isThreadRunAlive(
  threadId: string,
  options: ReaperOptions = {},
): Promise<boolean> {
  const config = options.config ?? resolveAgentRunHealthConfig();
  const nowMs = options.now?.() ?? Date.now();
  const rows = await db.query.agentRuns.findMany({
    where: and(eq(agentRuns.threadId, threadId), inArray(agentRuns.status, ['queued', 'running'])),
  });
  return rows.some((row) => {
    const progressAt = (row as typeof row & { progressAt?: string | null }).progressAt;
    const health = assessAgentRunHealth({ ...row, progressAt }, nowMs, config);
    return health !== 'worker_lost' && health !== 'hard_timeout' && health !== 'never_claimed';
  });
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function isTerminalAgentRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/**
 * Return the most recent agent_runs row for a thread (by createdAt DESC).
 */
export async function getLatestThreadRun(threadId: string): Promise<{
  status: string;
  ownerInstance: string | null;
} | null> {
  const row = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.threadId, threadId),
    orderBy: desc(agentRuns.createdAt),
    columns: { status: true, ownerInstance: true },
  });
  return row ?? null;
}

/**
 * Decides whether *this* server instance is allowed to mark a design doc as
 * `generation_failed`. Returns false when:
 * - No agent_runs row exists yet (kickoff still starting — keep polling).
 * - The latest run is non-terminal (still alive — the liveness gate handles it).
 * - The latest run is terminal but owned by a different instance (that instance
 *   is responsible for finalization).
 *
 * Returns true when this instance owned the terminal run (or ownerInstance is
 * null — legacy/reaped rows where no owner was recorded).
 */
export async function canThisInstanceFailGeneration(threadId: string): Promise<boolean> {
  const latest = await getLatestThreadRun(threadId);
  if (!latest) return false;
  if (!isTerminalAgentRunStatus(latest.status)) return false;
  if (latest.ownerInstance && latest.ownerInstance !== RUN_EVENT_SOURCE_INSTANCE) return false;
  return true;
}

function warningFor(health: AgentRunHealth, config: AgentRunHealthConfig): string | null {
  if (health === 'progress_stale') {
    return `No meaningful progress for more than ${Math.round(config.progressStaleMs / 60_000)} minutes`;
  }
  if (health === 'long_running') {
    return `${LONG_RUNNING_PREFIX} (${Math.round(config.longRunMs / 60_000)}+ minutes); recent progress is still being received`;
  }
  return null;
}

function isWatchdogWarning(lastError: string | null | undefined): boolean {
  return Boolean(
    lastError
    && (lastError.startsWith('No meaningful progress for more than ') || lastError.startsWith(LONG_RUNNING_PREFIX)),
  );
}

async function logMyWorkHealth(
  threadId: string,
  runId: string,
  health: AgentRunHealth,
  detail: string,
  level: 'info' | 'warn' | 'error',
): Promise<void> {
  const context = await getMyWorkSessionContext(threadId).catch(() => null);
  if (!context) return;
  logMyWorkSession('run.health_changed', {
    ...context,
    runId,
    health,
    detail,
  }, level);
}

async function failRun(
  id: string,
  threadId: string,
  message: string,
  updatedAt: string,
): Promise<void> {
  await db
    .update(agentRuns)
    .set({ status: 'failed', lastError: message, updatedAt })
    .where(and(eq(agentRuns.id, id), eq(agentRuns.status, 'running')));
  await db
    .update(chatThreads)
    .set({ status: 'idle', activeRunId: null, lastError: message, lastActivityAt: updatedAt })
    .where(and(
      eq(chatThreads.id, threadId),
      eq(chatThreads.activeRunId, id),
      eq(chatThreads.status, 'running'),
    ));
}

/**
 * Reap failed runs and persist non-terminal progress warnings.
 */
export async function reapOrphanedRuns(options: ReaperOptions = {}): Promise<void> {
  try {
    const config = options.config ?? resolveAgentRunHealthConfig();
    const nowMs = options.now?.() ?? Date.now();
    const updatedAt = new Date(nowMs).toISOString();
    const rows = await db.query.agentRuns.findMany({
      where: inArray(agentRuns.status, ['queued', 'running']),
    });

    for (const row of rows) {
      const progressAt = (row as typeof row & { progressAt?: string | null }).progressAt;
      const health = assessAgentRunHealth({ ...row, progressAt }, nowMs, config);

      if (health === 'worker_lost') {
        const detail = 'Worker lost (heartbeat expired)';
        await failRun(row.id, row.threadId, detail, updatedAt);
        await logMyWorkHealth(row.threadId, row.id, health, detail, 'error');
        await publishHealthEvent({
          runId: row.id,
          threadId: row.threadId,
          health,
          detail,
          timestamp: updatedAt,
          phase: row.progressPhase,
          status: 'failed',
        }).catch((err) => console.error('[reaper] Failed to publish worker-loss event:', err));
        console.log(`[reaper] Reaped orphaned run (id=${row.id}, threadId=${row.threadId}) — heartbeat expired`);
        continue;
      }
      if (health === 'hard_timeout') {
        const detail = 'Run exceeded configured hard limit';
        await failRun(row.id, row.threadId, detail, updatedAt);
        await logMyWorkHealth(row.threadId, row.id, health, detail, 'error');
        await publishHealthEvent({
          runId: row.id,
          threadId: row.threadId,
          health,
          detail,
          timestamp: updatedAt,
          phase: row.progressPhase,
          status: 'failed',
        }).catch((err) => console.error('[reaper] Failed to publish timeout event:', err));
        console.log(`[reaper] Reaped timed-out run (id=${row.id}, threadId=${row.threadId})`);
        continue;
      }
      if (health === 'never_claimed') {
        await db
          .update(agentRuns)
          .set({
            status: 'failed',
            lastError: 'Never claimed (worker lost before lease)',
            updatedAt,
          })
          .where(and(eq(agentRuns.id, row.id), eq(agentRuns.status, 'queued')));
        await logMyWorkHealth(
          row.threadId,
          row.id,
          health,
          'Never claimed (worker lost before lease)',
          'error',
        );
        await publishHealthEvent({
          runId: row.id,
          threadId: row.threadId,
          health,
          detail: 'Never claimed (worker lost before lease)',
          timestamp: updatedAt,
          phase: row.progressPhase,
          status: 'failed',
        }).catch((err) => console.error('[reaper] Failed to publish unclaimed-run event:', err));
        console.log(`[reaper] Reaped stale queued run (id=${row.id}, threadId=${row.threadId})`);
        continue;
      }

      const warning = warningFor(health, config);
      if (warning && row.lastError !== warning) {
        await db
          .update(agentRuns)
          .set({ lastError: warning, updatedAt })
          .where(and(eq(agentRuns.id, row.id), eq(agentRuns.status, 'running')));
        await logMyWorkHealth(row.threadId, row.id, health, warning, 'warn');
        await publishHealthEvent({
          runId: row.id,
          threadId: row.threadId,
          health,
          detail: warning,
          timestamp: updatedAt,
          phase: row.progressPhase,
          status: 'running',
        }).catch((err) => console.error('[reaper] Failed to publish watchdog warning:', err));
        console.warn(`[reaper] ${warning} (id=${row.id}, threadId=${row.threadId})`);
      } else if (!warning && isWatchdogWarning(row.lastError)) {
        await db
          .update(agentRuns)
          .set({ lastError: null, updatedAt })
          .where(and(eq(agentRuns.id, row.id), eq(agentRuns.status, 'running')));
        await logMyWorkHealth(row.threadId, row.id, 'healthy', 'Meaningful progress resumed', 'info');
        await publishHealthEvent({
          runId: row.id,
          threadId: row.threadId,
          health: 'healthy',
          detail: 'Meaningful progress resumed',
          timestamp: updatedAt,
          phase: row.progressPhase,
          status: 'running',
        }).catch((err) => console.error('[reaper] Failed to publish recovery event:', err));
      }
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
