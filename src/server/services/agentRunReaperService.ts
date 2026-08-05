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
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type {
  AgentRunEventStatus,
  AgentRunHealth,
  AgentRunPhase,
  SseHealthEvent,
} from '../../shared/types/chat';
import {
  finalizeReconciledAgentRun,
  nextRunEventSequence,
  notifyRunEvent,
  RUN_EVENT_SOURCE_INSTANCE,
} from './pgNotifyService';
import { getMyWorkSessionContext, logMyWorkSession } from './myWorkSessionLogger';
import { isFeatureEnabled } from './featureFlagService';

const REAP_INTERVAL_MS = 60_000;
export const RETIRE_REAP_INTERVAL_MS = 5 * 60_000;
const LONG_RUNNING_PREFIX = 'Long-running agent run';
const WATCHDOG_SOURCE_INSTANCE = `${RUN_EVENT_SOURCE_INSTANCE}:watchdog`;

let reaperTimer: ReturnType<typeof setInterval> | null = null;
let lastRetireReapAt = 0;

export interface AgentRunHealthConfig {
  heartbeatTimeoutMs: number;
  queuedTimeoutMs: number;
  progressStaleMs: number;
  /** Fail the run after this much time without meaningful progress (must be >= progressStaleMs). */
  progressAbortMs: number;
  /**
   * Hard cap for a single in-flight tool (`… running`). Beyond this, abort even
   * while heartbeat is alive — prevents hung MCP/SDK tools from pinning a local
   * Cursor CLI on the App Service forever (see progress refresh exemption).
   */
  inFlightToolMaxMs: number;
  longRunMs: number;
  hardLimitMs: number;
}

export interface AgentRunHealthSnapshot {
  status: string;
  createdAt: string;
  startedAt: string | null;
  heartbeatAt: string | null;
  progressAt?: string | null;
  /** Last progress detail, e.g. "edit running" / "edit completed". */
  progressLabel?: string | null;
  timeoutAt: string | null;
}

export interface ReaperOptions {
  now?: () => number;
  config?: AgentRunHealthConfig;
  eventDrivenTerminationEnabled?: (threadId: string) => Promise<boolean>;
  retireReconcileDue?: boolean;
}

function positiveDuration(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveAgentRunHardLimitMs(): number {
  return positiveDuration(process.env.AGENT_RUN_HARD_LIMIT_MS, 2 * 60 * 60_000);
}

/**
 * Fast owner-side deadline for the FIRST stream event of an event-driven run.
 * A resumed agent that emits nothing (cold-resume zombie) has no tool_call for
 * the MCP deadline to bound; this bounds that dead-on-arrival window to seconds
 * instead of the coarse ~2h hard limit.
 */
export function resolveAgentFirstEventTimeoutMs(): number {
  return positiveDuration(process.env.AGENT_FIRST_EVENT_TIMEOUT_MS, 45_000);
}

export function resolveAgentRunHealthConfig(): AgentRunHealthConfig {
  const progressStaleMs = positiveDuration(process.env.AGENT_PROGRESS_STALE_MS, 2 * 60_000);
  const progressAbortMs = Math.max(
    progressStaleMs,
    positiveDuration(process.env.AGENT_PROGRESS_ABORT_MS, 5 * 60_000),
  );
  const inFlightToolMaxMs = Math.max(
    progressAbortMs,
    positiveDuration(process.env.AGENT_IN_FLIGHT_TOOL_MAX_MS, 6 * 60_000),
  );
  return {
    heartbeatTimeoutMs: positiveDuration(process.env.AGENT_HEARTBEAT_TIMEOUT_MS, 5 * 60_000),
    queuedTimeoutMs: positiveDuration(process.env.AGENT_QUEUE_TIMEOUT_MS, 90_000),
    progressStaleMs,
    progressAbortMs,
    inFlightToolMaxMs,
    longRunMs: positiveDuration(process.env.AGENT_LONG_RUN_MS, 30 * 60_000),
    hardLimitMs: resolveAgentRunHardLimitMs(),
  };
}

export function shouldRunRetireReconciler(lastRunAt: number, nowMs: number): boolean {
  return nowMs - lastRunAt >= RETIRE_REAP_INTERVAL_MS;
}

export async function isEventDrivenTerminationEnabledForThread(
  threadId: string,
): Promise<boolean> {
  const thread = await db.query.chatThreads.findFirst({
    where: eq(chatThreads.id, threadId),
    columns: { userId: true, kickoff: true },
  });
  const project = thread?.kickoff?.project;
  if (!thread?.userId || !project) return false;
  return isFeatureEnabled('event-driven-run-termination', {
    userId: thread.userId,
    project,
  });
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

/**
 * True when the last progress label indicates a tool is still executing
 * (e.g. "edit running", "Write:path running"). Long file edits can exceed
 * progressAbortMs without further stream events while the worker remains healthy.
 */
export function isInFlightToolProgressLabel(label: string | null | undefined): boolean {
  if (!label) return false;
  return /\brunning$/i.test(label.trim());
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
  const progressAge = ageMs(meaningfulProgressAt, nowMs);
  if (progressAge >= config.progressAbortMs) {
    // Long `edit`/tool calls can exceed progressAbortMs with no stream events.
    // Stay in progress_stale (warn) until inFlightToolMaxMs, then abort — a
    // hung MCP/CLI must not pin the App Service for the full hardLimitMs.
    if (isInFlightToolProgressLabel(run.progressLabel)) {
      if (progressAge >= config.inFlightToolMaxMs) return 'progress_timeout';
      return progressAge >= config.progressStaleMs ? 'progress_stale' : 'healthy';
    }
    return 'progress_timeout';
  }
  if (progressAge >= config.progressStaleMs) return 'progress_stale';
  if (ageMs(runStartedAt, nowMs) >= config.longRunMs) return 'long_running';
  return 'healthy';
}

/**
 * Cross-instance liveness check for a thread's agent run.
 *
 * Unlike in-memory `isThreadIdle`, this reads `agent_runs` and treats a run as
 * alive while any queued/running row is not process-dead (`worker_lost`,
 * `hard_timeout`, `never_claimed`). `progress_timeout` is intentionally NOT
 * treated as dead here: long model-thinking phases keep heartbeats alive while
 * progress may lag, and recover/hydrate must not cancel those runs. The reaper
 * still fails true progress-timeouts; callers should wait for a terminal row.
 */
export async function isThreadRunAlive(
  threadId: string,
  options: ReaperOptions = {},
): Promise<boolean> {
  const config = options.config ?? resolveAgentRunHealthConfig();
  const nowMs = options.now?.() ?? Date.now();
  const eventDrivenTerminationEnabled =
    options.eventDrivenTerminationEnabled ?? isEventDrivenTerminationEnabledForThread;
  const rows = await db.query.agentRuns.findMany({
    where: and(eq(agentRuns.threadId, threadId), inArray(agentRuns.status, ['queued', 'running'])),
  });
  // Prefer the persisted per-row marker (set at claim). Event-driven runs never
  // heartbeat, so a live flag miss must not route them through legacy liveness.
  const rowMarkedEventDriven = rows.some(
    (row) => (row as typeof row & { eventDriven?: boolean }).eventDriven === true,
  );
  const eventDrivenEnabled = rowMarkedEventDriven
    || await eventDrivenTerminationEnabled(threadId).catch(() => false);
  // @feature-flag:event-driven-run-termination start winner=enabled
  if (eventDrivenEnabled) {
    // @feature-flag:event-driven-run-termination enabled-start
    return rows.some((row) => !row.timeoutAt || Date.parse(row.timeoutAt) > nowMs);
    // @feature-flag:event-driven-run-termination enabled-end
  }
  // @feature-flag:event-driven-run-termination disabled-start
  return rows.some((row) => {
    const progressAt = (row as typeof row & { progressAt?: string | null }).progressAt;
    const progressLabel = (row as typeof row & { progressLabel?: string | null }).progressLabel;
    const health = assessAgentRunHealth({ ...row, progressAt, progressLabel }, nowMs, config);
    return health !== 'worker_lost'
      && health !== 'hard_timeout'
      && health !== 'never_claimed';
  });
  // @feature-flag:event-driven-run-termination disabled-end
  // @feature-flag:event-driven-run-termination end
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function isTerminalAgentRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/**
 * How long a non-owner watcher waits after a terminal agent_runs row before
 * taking over finalization. Gives the owning instance a chance to persist
 * output / mark generation_failed; after this, any instance may finalize so
 * docs cannot stay stuck in `generating` forever after a crash/deploy.
 */
export const GENERATION_FAIL_ORPHAN_GRACE_MS = 2 * 60_000;

/**
 * Return the most recent agent_runs row for a thread (by createdAt DESC).
 */
export async function getLatestThreadRun(threadId: string): Promise<{
  status: string;
  ownerInstance: string | null;
  updatedAt: string;
} | null> {
  const row = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.threadId, threadId),
    orderBy: desc(agentRuns.createdAt),
    columns: { status: true, ownerInstance: true, updatedAt: true },
  });
  return row ?? null;
}

export interface CanFailGenerationOptions {
  now?: () => number;
  /** Override orphan grace (tests). Defaults to GENERATION_FAIL_ORPHAN_GRACE_MS. */
  orphanGraceMs?: number;
}

/**
 * Decides whether *this* server instance is allowed to mark a design doc as
 * `generation_failed`. Returns false when:
 * - No agent_runs row exists yet (kickoff still starting — keep polling).
 * - The latest run is non-terminal (still alive — the liveness gate handles it).
 * - The latest run is terminal but owned by a different instance AND still
 *   within the orphan grace window (owner may still be finalizing).
 *
 * Returns true when this instance owned the terminal run, ownerInstance is
 * null (legacy/reaped), or the foreign owner's terminal run is older than the
 * orphan grace (owner crashed/deployed away without finalizing).
 */
export async function canThisInstanceFailGeneration(
  threadId: string,
  options: CanFailGenerationOptions = {},
): Promise<boolean> {
  const latest = await getLatestThreadRun(threadId);
  if (!latest) return false;
  if (!isTerminalAgentRunStatus(latest.status)) return false;
  if (!latest.ownerInstance || latest.ownerInstance === RUN_EVENT_SOURCE_INSTANCE) {
    return true;
  }

  const orphanGraceMs = options.orphanGraceMs ?? GENERATION_FAIL_ORPHAN_GRACE_MS;
  const nowMs = options.now?.() ?? Date.now();
  const updatedMs = Date.parse(latest.updatedAt);
  if (Number.isFinite(updatedMs) && nowMs - updatedMs >= orphanGraceMs) {
    return true;
  }
  return false;
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
    .where(and(eq(agentRuns.id, id), inArray(agentRuns.status, ['queued', 'running'])));
  // Also clear desynced threads where recovery wiped active_run_id while this
  // run was still live (activeRunId null + idle/running).
  await db
    .update(chatThreads)
    .set({ status: 'idle', activeRunId: null, lastError: message, lastActivityAt: updatedAt })
    .where(and(
      eq(chatThreads.id, threadId),
      or(
        eq(chatThreads.activeRunId, id),
        isNull(chatThreads.activeRunId),
      ),
    ));
}

async function publishCancelSignal(threadId: string, runId: string, timestamp: string): Promise<void> {
  await notifyRunEvent({
    eventId: randomUUID(),
    threadId,
    runId,
    sourceInstance: WATCHDOG_SOURCE_INSTANCE,
    sequence: nextRunEventSequence(runId, WATCHDOG_SOURCE_INSTANCE),
    timestamp,
    type: 'cancel',
    phase: 'completion',
    status: 'cancelled',
    detail: 'Run cancelled by watchdog',
    event: { type: 'cancel' },
  }, { persist: true });
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
    const eventDrivenTerminationEnabled =
      options.eventDrivenTerminationEnabled ??
      isEventDrivenTerminationEnabledForThread;

    for (const row of rows) {
      // The persisted marker is authoritative: an event-driven run intentionally
      // never writes a heartbeat, so classifying it via the legacy branch (on a
      // transient flag-eval miss) would mislabel it "Worker lost". Only fall back
      // to the live flag when the row predates the marker column.
      const eventDrivenEnabled =
        (row as typeof row & { eventDriven?: boolean }).eventDriven === true
        || await eventDrivenTerminationEnabled(row.threadId).catch(() => false);
      // @feature-flag:event-driven-run-termination start winner=enabled
      if (eventDrivenEnabled) {
        // @feature-flag:event-driven-run-termination enabled-start
        if (options.retireReconcileDue === false) continue;
        const expired = Boolean(row.timeoutAt && Date.parse(row.timeoutAt) <= nowMs);
        if (expired) {
          const detail = 'Run exceeded configured hard limit';
          const errorEvent = {
            eventId: randomUUID(),
            threadId: row.threadId,
            runId: row.id,
            sourceInstance: WATCHDOG_SOURCE_INSTANCE,
            sequence: nextRunEventSequence(row.id, WATCHDOG_SOURCE_INSTANCE),
            timestamp: updatedAt,
            type: 'error' as const,
            phase: 'completion' as const,
            status: 'failed' as const,
            detail,
            event: { type: 'error' as const, error: detail },
          };
          const cancelEvent = {
            eventId: randomUUID(),
            threadId: row.threadId,
            runId: row.id,
            sourceInstance: WATCHDOG_SOURCE_INSTANCE,
            sequence: nextRunEventSequence(row.id, WATCHDOG_SOURCE_INSTANCE),
            timestamp: updatedAt,
            type: 'cancel' as const,
            phase: 'completion' as const,
            status: 'cancelled' as const,
            detail: 'Run cancelled by timeout reconciler',
            event: { type: 'cancel' as const },
          };
          const won = await finalizeReconciledAgentRun({
            runId: row.id,
            threadId: row.threadId,
            status: 'failed',
            detail,
            events: [errorEvent, cancelEvent],
          });
          if (won) {
            await db
              .update(chatThreads)
              .set({ status: 'idle', activeRunId: null, lastError: detail, lastActivityAt: updatedAt })
              .where(and(
                eq(chatThreads.id, row.threadId),
                or(eq(chatThreads.activeRunId, row.id), isNull(chatThreads.activeRunId)),
              ));
            await logMyWorkHealth(row.threadId, row.id, 'hard_timeout', detail, 'error');
          }
        }
        // @feature-flag:event-driven-run-termination enabled-end
        continue;
      }

      // @feature-flag:event-driven-run-termination disabled-start
      const progressAt = (row as typeof row & { progressAt?: string | null }).progressAt;
      const progressLabel = (row as typeof row & { progressLabel?: string | null }).progressLabel;
      const health = assessAgentRunHealth({ ...row, progressAt, progressLabel }, nowMs, config);

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
        await publishCancelSignal(row.threadId, row.id, updatedAt)
          .catch((err) => console.error('[reaper] Failed to publish cancel after worker-loss:', err));
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
        await publishCancelSignal(row.threadId, row.id, updatedAt)
          .catch((err) => console.error('[reaper] Failed to publish cancel after hard timeout:', err));
        console.log(`[reaper] Reaped timed-out run (id=${row.id}, threadId=${row.threadId})`);
        continue;
      }
      if (health === 'progress_timeout') {
        const detail = `No meaningful progress for more than ${Math.round(config.progressAbortMs / 60_000)} minutes — run aborted`;
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
        }).catch((err) => console.error('[reaper] Failed to publish progress-timeout event:', err));
        await publishCancelSignal(row.threadId, row.id, updatedAt)
          .catch((err) => console.error('[reaper] Failed to publish cancel after progress timeout:', err));
        console.log(`[reaper] Reaped progress-stalled run (id=${row.id}, threadId=${row.threadId})`);
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
      // @feature-flag:event-driven-run-termination disabled-end
      // @feature-flag:event-driven-run-termination end
    }
  } catch (err) {
    console.error('[reaper] Failed to reap orphaned runs:', err);
  }
}

/**
 * Start the reaper: run immediately on startup, then repeat on interval.
 */
export function startReaper(): void {
  lastRetireReapAt = Date.now();
  reapOrphanedRuns({ retireReconcileDue: true }).catch((err) => {
    console.error('[reaper] Initial reap failed:', err);
  });

  reaperTimer = setInterval(() => {
    const nowMs = Date.now();
    const retireReconcileDue = shouldRunRetireReconciler(lastRetireReapAt, nowMs);
    if (retireReconcileDue) lastRetireReapAt = nowMs;
    reapOrphanedRuns({ retireReconcileDue }).catch((err) => {
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
