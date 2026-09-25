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
  AgentRunEventEnvelope,
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
import {
  markTerminal,
  shouldApplyWorkerLifecycle,
} from './agentRunLifecycleService';
import {
  recoverStaleDispatchedRuns,
  resolveBackgroundDispatchTtlMs,
} from './admissionGovernorService';
import { workerTierTelemetry } from './workerTierTelemetry';
import { INTERACTIVE_LANE } from '../../shared/types/interactiveWorkflow';
import {
  NonblockingRepoCacheLeaseUnavailableError,
  RepoCacheLeaseLostError,
  withRepoCacheLease,
} from './repoCacheLeaseService';
import { isDocumentHarvestPendingForRun } from './aiRunV2/finishedAttemptReader';

const REAP_INTERVAL_MS = 60_000;
export const RETIRE_REAP_INTERVAL_MS = 5 * 60_000;
const LONG_RUNNING_PREFIX = 'Long-running agent run';
const WATCHDOG_SOURCE_INSTANCE = `${RUN_EVENT_SOURCE_INSTANCE}:watchdog`;
const REAPER_SWEEP_LEASE_KEY = 'agent-run-reaper:sweep';
const REAPER_SWEEP_LEASE_MS = 55_000;
const REAPER_SWEEP_HEARTBEAT_MS = 15_000;
const RETIRE_RECONCILER_SWEEP_LEASE_KEY = 'agent-run-retire-reconciler:sweep';
const RETIRE_RECONCILER_SWEEP_LEASE_MS = RETIRE_REAP_INTERVAL_MS - 5_000;
const DEFAULT_WORKER_HEARTBEAT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_DISPATCH_COLD_START_MS = 5 * 60_000;
const DEFAULT_WORKER_PROGRESS_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CANCEL_GRACE_MS = 60_000;

let reaperTimer: ReturnType<typeof setInterval> | null = null;
let reaperCyclePromise: Promise<void> | null = null;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new RepoCacheLeaseLostError();
  }
}

function isExpectedSweepStop(error: unknown): boolean {
  return error instanceof NonblockingRepoCacheLeaseUnavailableError
    || error instanceof RepoCacheLeaseLostError;
}

async function tryRunRetireReconcileDue(signal: AbortSignal): Promise<boolean> {
  throwIfAborted(signal);
  try {
    await withRepoCacheLease(
      RETIRE_RECONCILER_SWEEP_LEASE_KEY,
      async () => undefined,
      {
        leaseMs: RETIRE_RECONCILER_SWEEP_LEASE_MS,
        heartbeatMs: REAPER_SWEEP_HEARTBEAT_MS,
        waitMs: 0,
        releaseOnComplete: false,
      },
    );
    return true;
  } catch (error) {
    if (error instanceof NonblockingRepoCacheLeaseUnavailableError) {
      return false;
    }
    throw error;
  }
}

async function runReaperCycle(errorLabel: string): Promise<void> {
  if (reaperCyclePromise) {
    await reaperCyclePromise;
    return;
  }

  const cycle = (async () => {
    try {
      await withRepoCacheLease(
        REAPER_SWEEP_LEASE_KEY,
        async (lease) => {
          throwIfAborted(lease.signal);
          const retireReconcileDue = await tryRunRetireReconcileDue(lease.signal);
          await reapOrphanedRuns({ retireReconcileDue, signal: lease.signal });
        },
        {
          leaseMs: REAPER_SWEEP_LEASE_MS,
          heartbeatMs: REAPER_SWEEP_HEARTBEAT_MS,
          waitMs: 0,
          releaseOnComplete: false,
        },
      );
    } catch (error) {
      if (!isExpectedSweepStop(error)) {
        console.error(errorLabel, error);
      }
    }
  })();
  reaperCyclePromise = cycle;
  try {
    await cycle;
  } finally {
    if (reaperCyclePromise === cycle) {
      reaperCyclePromise = null;
    }
  }
}

export interface AgentRunHealthConfig {
  heartbeatTimeoutMs: number;
  queuedTimeoutMs: number;
  /** Fail background worker runs that remain queued beyond this starvation backstop. */
  backgroundQueueTtlMs?: number;
  /** Background-worker heartbeat clock; never applied to legacy in-process rows. */
  workerHeartbeatTimeoutMs?: number;
  /** Admit-to-worker-start clock before the current fenced dispatch is republished. */
  dispatchColdStartMs?: number;
  /**
   * Backstop for a dispatch the worker never picks up or never reports on.
   * Beyond this the run is failed, which is the only exit from `dispatched` —
   * republishing alone cannot reach a terminal state.
   */
  dispatchTtlMs?: number;
  /** Background-worker meaningful-progress clock. */
  workerProgressTimeoutMs?: number;
  /** Maximum cooperative-cancellation acknowledgement grace. */
  cancelGraceMs?: number;
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
  signal?: AbortSignal;
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
    backgroundQueueTtlMs: positiveDuration(
      process.env.AI_RUNS_BACKGROUND_QUEUE_TTL_MS,
      30 * 60_000,
    ),
    workerHeartbeatTimeoutMs: positiveDuration(
      process.env.AI_RUN_WORKER_HEARTBEAT_TIMEOUT_MS,
      DEFAULT_WORKER_HEARTBEAT_TIMEOUT_MS,
    ),
    dispatchColdStartMs: positiveDuration(
      process.env.AI_RUN_DISPATCH_COLDSTART_MS,
      DEFAULT_DISPATCH_COLD_START_MS,
    ),
    dispatchTtlMs: resolveBackgroundDispatchTtlMs(),
    workerProgressTimeoutMs: positiveDuration(
      process.env.AI_RUN_PROGRESS_TIMEOUT_MS,
      DEFAULT_WORKER_PROGRESS_TIMEOUT_MS,
    ),
    cancelGraceMs: positiveDuration(
      process.env.AI_RUN_CANCEL_GRACE_MS,
      DEFAULT_CANCEL_GRACE_MS,
    ),
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

function workerTelemetryContext(row: {
  id: string;
  projectId?: string | null;
  lane?: string | null;
  dispatchMessageId?: string | null;
}): {
  runId: string;
  project?: string;
  lane?: string;
  dispatchMessageId?: string;
} {
  return {
    runId: row.id,
    ...(row.projectId ? { project: row.projectId } : {}),
    ...(row.lane ? { lane: row.lane } : {}),
    ...(row.dispatchMessageId
      ? { dispatchMessageId: row.dispatchMessageId }
      : {}),
  };
}

function emitWorkerTelemetry(emit: () => void): void {
  try {
    emit();
  } catch {
    // Telemetry must never alter watchdog lifecycle outcomes.
  }
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
  // `dispatched` must be listed here. The reaper's own scan covers it, and a
  // status this query omits reads as neither alive nor terminal — waiters then
  // conclude the agent finished while no terminal row will ever arrive.
  const rows = await db.query.agentRuns.findMany({
    where: and(
      eq(agentRuns.threadId, threadId),
      inArray(agentRuns.status, ['queued', 'running', 'dispatched']),
    ),
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
    return rows.some(
      (row) => shouldApplyWorkerLifecycle(row)
        || !row.timeoutAt
        || Date.parse(row.timeoutAt) > nowMs,
    );
    // @feature-flag:event-driven-run-termination enabled-end
  }
  // @feature-flag:event-driven-run-termination disabled-start
  return rows.some((row) => {
    if (shouldApplyWorkerLifecycle(row)) return true;
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

type ThreadRunSnapshotRow = {
  id?: string;
  status: string;
  ownerInstance: string | null;
  updatedAt: string;
  timeoutAt: string | null;
  createdAt: string;
  startedAt: string | null;
  heartbeatAt: string | null;
  progressAt?: string | null;
  progressLabel?: string | null;
  eventDriven?: boolean | null;
  lane?: string | null;
  dispatchMessageId?: string | null;
  transportVersion?: string;
};

export interface ThreadRunStateSnapshot {
  latestRun: {
    status: string;
    ownerInstance: string | null;
    updatedAt: string;
    timeoutAt: string | null;
  } | null;
  shouldChargeWorkBudget: boolean;
  isAlive: boolean;
  canFailGeneration: boolean;
}

function isAliveThreadRunSnapshotRow(
  row: ThreadRunSnapshotRow,
  nowMs: number,
  config: AgentRunHealthConfig,
  eventDrivenEnabled: boolean,
): boolean {
  if (!['queued', 'running', 'dispatched'].includes(row.status)) {
    return false;
  }
  if (eventDrivenEnabled) {
    return shouldApplyWorkerLifecycle(row)
      || !row.timeoutAt
      || Date.parse(row.timeoutAt) > nowMs;
  }
  if (shouldApplyWorkerLifecycle(row)) {
    return true;
  }
  const health = assessAgentRunHealth({
    status: row.status,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    heartbeatAt: row.heartbeatAt,
    progressAt: row.progressAt ?? null,
    progressLabel: row.progressLabel ?? null,
    timeoutAt: row.timeoutAt,
  }, nowMs, config);
  return health !== 'worker_lost'
    && health !== 'hard_timeout'
    && health !== 'never_claimed';
}

function canThisInstanceFailLatestRun(
  latest: Pick<ThreadRunSnapshotRow, 'status' | 'ownerInstance' | 'updatedAt' | 'timeoutAt'> | null,
  nowMs: number,
  orphanGraceMs: number,
): boolean {
  if (!latest) return false;
  if (
    !isTerminalAgentRunStatus(latest.status)
    && !isRunPastDeadline(latest, nowMs)
  ) {
    return false;
  }
  if (!latest.ownerInstance || latest.ownerInstance === RUN_EVENT_SOURCE_INSTANCE) {
    return true;
  }

  const updatedMs = Date.parse(latest.updatedAt);
  return Number.isFinite(updatedMs) && nowMs - updatedMs >= orphanGraceMs;
}

async function hasPendingDocumentHarvest(
  latest: Pick<
    ThreadRunSnapshotRow,
    'id' | 'status' | 'transportVersion'
  > | null,
): Promise<boolean> {
  if (
    !latest?.id
    || latest.transportVersion !== 'servicebus-blob-v2'
    || !isTerminalAgentRunStatus(latest.status)
  ) {
    return false;
  }
  return isDocumentHarvestPendingForRun(latest.id).catch(() => true);
}

/**
 * How long a non-owner watcher waits after a terminal agent_runs row before
 * taking over finalization. Gives the owning instance a chance to persist
 * output / mark generation_failed; after this, any instance may finalize so
 * docs cannot stay stuck in `generating` forever after a crash/deploy.
 */
export const GENERATION_FAIL_ORPHAN_GRACE_MS = 2 * 60_000;

export async function getThreadRunStateSnapshot(
  threadId: string,
  options: ReaperOptions & CanFailGenerationOptions = {},
): Promise<ThreadRunStateSnapshot> {
  const config = options.config ?? resolveAgentRunHealthConfig();
  const nowMs = options.now?.() ?? Date.now();
  const orphanGraceMs = options.orphanGraceMs ?? GENERATION_FAIL_ORPHAN_GRACE_MS;
  const eventDrivenTerminationEnabled =
    options.eventDrivenTerminationEnabled ?? isEventDrivenTerminationEnabledForThread;
  const rows = await db.query.agentRuns.findMany({
    where: eq(agentRuns.threadId, threadId),
    orderBy: [desc(agentRuns.createdAt)],
    columns: {
      id: true,
      status: true,
      ownerInstance: true,
      updatedAt: true,
      timeoutAt: true,
      createdAt: true,
      startedAt: true,
      heartbeatAt: true,
      progressAt: true,
      progressLabel: true,
      eventDriven: true,
      lane: true,
      dispatchMessageId: true,
      transportVersion: true,
    },
  });

  const latest = rows[0] ?? null;
  const activeRows = rows.filter((row) => ['queued', 'running', 'dispatched'].includes(row.status));
  const hasWorkerLifecycleRows = activeRows.some((row) => shouldApplyWorkerLifecycle(row));
  const rowMarkedEventDriven = activeRows.some((row) => row.eventDriven === true);
  const eventDrivenEnabled = rowMarkedEventDriven
    || (
      activeRows.length > 0
      && !hasWorkerLifecycleRows
      && await eventDrivenTerminationEnabled(threadId).catch(() => false)
    );
  const mayFailGeneration = canThisInstanceFailLatestRun(
    latest,
    nowMs,
    orphanGraceMs,
  );
  const pendingDocumentHarvest =
    mayFailGeneration && await hasPendingDocumentHarvest(latest);

  return {
    latestRun: latest
      ? {
          status: latest.status,
          ownerInstance: latest.ownerInstance ?? null,
          updatedAt: latest.updatedAt,
          timeoutAt: latest.timeoutAt ?? null,
        }
      : null,
    shouldChargeWorkBudget: !latest || !['queued', 'dispatched'].includes(latest.status),
    isAlive: activeRows.some((row) =>
      isAliveThreadRunSnapshotRow(row, nowMs, config, eventDrivenEnabled),
    ),
    canFailGeneration: mayFailGeneration && !pendingDocumentHarvest,
  };
}

/**
 * Return the most recent agent_runs row for a thread (by createdAt DESC).
 */
export async function getLatestThreadRun(threadId: string): Promise<{
  id?: string;
  status: string;
  ownerInstance: string | null;
  updatedAt: string;
  timeoutAt: string | null;
  transportVersion?: string;
} | null> {
  const row = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.threadId, threadId),
    orderBy: desc(agentRuns.createdAt),
    columns: {
      id: true,
      status: true,
      ownerInstance: true,
      updatedAt: true,
      timeoutAt: true,
      transportVersion: true,
    },
  });
  return row ?? null;
}

/** A run past its own deadline can no longer succeed, whatever its status says. */
function isRunPastDeadline(
  run: { timeoutAt: string | null },
  nowMs: number,
): boolean {
  if (!run.timeoutAt) return false;
  const timeoutMs = Date.parse(run.timeoutAt);
  return Number.isFinite(timeoutMs) && nowMs >= timeoutMs;
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
 * - The latest run is non-terminal and still inside its deadline (the liveness
 *   gate handles it).
 * - The latest run is finished but owned by a different instance AND still
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
  const nowMs = options.now?.() ?? Date.now();
  const orphanGraceMs = options.orphanGraceMs ?? GENERATION_FAIL_ORPHAN_GRACE_MS;
  const latest = await getLatestThreadRun(threadId);
  const mayFail = canThisInstanceFailLatestRun(latest, nowMs, orphanGraceMs);
  if (!mayFail) return false;
  return !(await hasPendingDocumentHarvest(latest));
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

function workerHealthEvent(input: {
  runId: string;
  threadId: string;
  health: Extract<AgentRunHealth, 'worker_lost' | 'progress_timeout'>;
  detail: string;
  timestamp: string;
  phase?: AgentRunPhase | null;
}): AgentRunEventEnvelope {
  const event: SseHealthEvent = {
    type: 'health',
    health: input.health,
    detail: input.detail,
    runId: input.runId,
    eventTimestamp: input.timestamp,
  };
  return {
    eventId: randomUUID(),
    threadId: input.threadId,
    runId: input.runId,
    sourceInstance: WATCHDOG_SOURCE_INSTANCE,
    sequence: nextRunEventSequence(input.runId, WATCHDOG_SOURCE_INSTANCE),
    timestamp: input.timestamp,
    type: 'health',
    phase: input.phase ?? 'completion',
    status: 'failed',
    detail: input.detail,
    event,
  };
}

function workerCancelEvent(input: {
  runId: string;
  threadId: string;
  detail: string;
  timestamp: string;
}): AgentRunEventEnvelope {
  return {
    eventId: randomUUID(),
    threadId: input.threadId,
    runId: input.runId,
    sourceInstance: WATCHDOG_SOURCE_INSTANCE,
    sequence: nextRunEventSequence(input.runId, WATCHDOG_SOURCE_INSTANCE),
    timestamp: input.timestamp,
    type: 'cancel',
    phase: 'completion',
    status: 'cancelled',
    detail: input.detail,
    event: { type: 'cancel' },
  };
}

/**
 * Reap failed runs and persist non-terminal progress warnings.
 */
export async function reapOrphanedRuns(options: ReaperOptions = {}): Promise<void> {
  const { signal } = options;
  try {
    throwIfAborted(signal);
    const config = options.config ?? resolveAgentRunHealthConfig();
    const workerHeartbeatTimeoutMs =
      config.workerHeartbeatTimeoutMs ?? DEFAULT_WORKER_HEARTBEAT_TIMEOUT_MS;
    const dispatchColdStartMs =
      config.dispatchColdStartMs ?? DEFAULT_DISPATCH_COLD_START_MS;
    const dispatchTtlMs =
      config.dispatchTtlMs ?? resolveBackgroundDispatchTtlMs();
    const workerProgressTimeoutMs =
      config.workerProgressTimeoutMs ?? DEFAULT_WORKER_PROGRESS_TIMEOUT_MS;
    const cancelGraceMs = config.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    const nowMs = options.now?.() ?? Date.now();
    const updatedAt = new Date(nowMs).toISOString();
    throwIfAborted(signal);
    const rows = await db.query.agentRuns.findMany({
      where: inArray(agentRuns.status, ['queued', 'running', 'dispatched']),
    });
    const eventDrivenTerminationEnabled =
      options.eventDrivenTerminationEnabled ??
      isEventDrivenTerminationEnabledForThread;
    let recoverColdStarts = false;

    for (const row of rows) {
      throwIfAborted(signal);
      // A V2 run's real lifecycle is its `ai_run_attempts` row, swept by the
      // orchestrator's reconciler. Terminating the header from here would leave
      // that attempt active with nothing to finalize it.
      if (row.transportVersion === 'servicebus-blob-v2') {
        continue;
      }

      // Interactive dispatch is acknowledged before the Dapr actor invocation
      // finishes. A process crash can therefore bypass the host's rejection
      // handler and leave the fenced row dispatched forever. Unlike background
      // work, this lane has nothing to republish, so terminate it after the
      // cold-start budget and let the user retry.
      if (row.lane === INTERACTIVE_LANE && row.status === 'dispatched') {
        if (
          row.dispatchMessageId
          && ageMs(row.dispatchedAt, nowMs) >= dispatchColdStartMs
        ) {
          const detail = 'Interactive agent did not start. Please retry.';
          throwIfAborted(signal);
          const terminal = await markTerminal(row.id, {
            status: 'failed',
            terminalReason: 'worker_lost',
            dispatchMessageId: row.dispatchMessageId,
            detail,
            events: [workerHealthEvent({
              runId: row.id,
              threadId: row.threadId,
              health: 'worker_lost',
              detail,
              timestamp: updatedAt,
              phase: row.progressPhase,
            })],
          });
          throwIfAborted(signal);
          console.log(
            `[reaper] Reaped interactive dispatch (id=${row.id}, threadId=${row.threadId}) — actor did not start`,
          );
          if (terminal.ok) {
            emitWorkerTelemetry(() => {
              workerTierTelemetry.reaperAction(
                workerTelemetryContext(row),
              );
            });
          }
        }
        continue;
      }

      // Worker-lane rows are governed only by lifecycle/fence-aware clocks.
      // They must never fall through to the legacy AGENT_* watchdog behavior.
      if (shouldApplyWorkerLifecycle(row)) {
        if (row.status === 'queued') {
          const queuedAt = row.queuedAt ?? row.createdAt;
          const backgroundQueueTtlMs = config.backgroundQueueTtlMs ?? 30 * 60_000;
          if (ageMs(queuedAt, nowMs) >= backgroundQueueTtlMs) {
            const detail = 'Background run exceeded the configured queue TTL';
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
            throwIfAborted(signal);
            const won = await finalizeReconciledAgentRun({
              runId: row.id,
              threadId: row.threadId,
              status: 'failed',
              terminalReason: 'queue_ttl',
              detail,
              events: [errorEvent],
            });
            throwIfAborted(signal);
            if (won) {
              throwIfAborted(signal);
              await db
                .update(chatThreads)
                .set({
                  status: 'idle',
                  activeRunId: null,
                  lastError: detail,
                  lastActivityAt: updatedAt,
                })
                .where(and(
                  eq(chatThreads.id, row.threadId),
                  or(eq(chatThreads.activeRunId, row.id), isNull(chatThreads.activeRunId)),
                ));
              console.log(
                `[reaper] Reaped queued background run (id=${row.id}, threadId=${row.threadId}) — queue TTL expired`,
              );
              emitWorkerTelemetry(() => {
                workerTierTelemetry.reaperAction(
                  workerTelemetryContext(row),
                );
              });
              emitWorkerTelemetry(() => {
                workerTierTelemetry.terminalReason(
                  workerTelemetryContext(row),
                  'queue_ttl',
                );
              });
            }
          }
          continue;
        }

        // A current dispatch fence is required before the reaper can terminate
        // or republish a dispatched/running worker row.
        if (
          (row.status !== 'dispatched' && row.status !== 'running')
          || !row.dispatchMessageId
        ) {
          continue;
        }

        if (
          row.cancelRequested
          && row.cancelState === 'requested'
          && ageMs(row.updatedAt, nowMs) >= cancelGraceMs
        ) {
          const detail = 'Background worker cancellation grace expired';
          throwIfAborted(signal);
          const terminal = await markTerminal(row.id, {
            status: 'cancelled',
            terminalReason: 'forced_cancel',
            dispatchMessageId: row.dispatchMessageId,
            detail,
            events: [workerCancelEvent({
              runId: row.id,
              threadId: row.threadId,
              detail,
              timestamp: updatedAt,
            })],
          });
          throwIfAborted(signal);
          console.log(
            `[reaper] Forced background cancellation (id=${row.id}, threadId=${row.threadId})`,
          );
          if (terminal.ok) {
            emitWorkerTelemetry(() => {
              workerTierTelemetry.reaperAction(
                workerTelemetryContext(row),
              );
            });
          }
          continue;
        }

        if (row.status === 'dispatched') {
          const dispatchAgeMs = ageMs(row.dispatchedAt, nowMs);

          // Republish is a recovery for a worker that has not started yet, not
          // a terminal path. A worker that dies before its first callback never
          // advances the row, so without this TTL the run stays `dispatched`
          // forever: waiters block on a run that reads neither alive nor
          // terminal, and every sweep re-enqueues it.
          if (dispatchAgeMs >= dispatchTtlMs) {
            const detail = 'Background worker never started. Please retry.';
            throwIfAborted(signal);
            const terminal = await markTerminal(row.id, {
              status: 'failed',
              terminalReason: 'dispatch_ttl',
              dispatchMessageId: row.dispatchMessageId,
              detail,
              events: [workerHealthEvent({
                runId: row.id,
                threadId: row.threadId,
                health: 'worker_lost',
                detail,
                timestamp: updatedAt,
                phase: row.progressPhase,
              })],
            });
            throwIfAborted(signal);
            console.warn(
              `[reaper] Reaped background run (id=${row.id}, threadId=${row.threadId}) — dispatch TTL expired`,
            );
            if (terminal.ok) {
              emitWorkerTelemetry(() => {
                workerTierTelemetry.reaperAction(
                  workerTelemetryContext(row),
                );
              });
              emitWorkerTelemetry(() => {
                workerTierTelemetry.terminalReason(
                  workerTelemetryContext(row),
                  'dispatch_ttl',
                );
              });
            }
            continue;
          }

          if (dispatchAgeMs >= dispatchColdStartMs) {
            recoverColdStarts = true;
          }
          continue;
        }

        if (ageMs(row.heartbeatAt, nowMs) >= workerHeartbeatTimeoutMs) {
          const detail = 'Background worker heartbeat expired';
          throwIfAborted(signal);
          const terminal = await markTerminal(row.id, {
            status: 'failed',
            terminalReason: 'worker_lost',
            dispatchMessageId: row.dispatchMessageId,
            detail,
            events: [workerHealthEvent({
              runId: row.id,
              threadId: row.threadId,
              health: 'worker_lost',
              detail,
              timestamp: updatedAt,
              phase: row.progressPhase,
            })],
          });
          throwIfAborted(signal);
          console.log(
            `[reaper] Reaped background run (id=${row.id}, threadId=${row.threadId}) — heartbeat expired`,
          );
          if (terminal.ok) {
            emitWorkerTelemetry(() => {
              workerTierTelemetry.reaperAction(
                workerTelemetryContext(row),
              );
            });
          }
          continue;
        }

        const meaningfulProgressAt =
          row.progressAt ?? row.startedAt ?? row.dispatchedAt ?? row.createdAt;
        if (
          ageMs(meaningfulProgressAt, nowMs)
          >= workerProgressTimeoutMs
        ) {
          const detail = 'Background worker progress expired';
          throwIfAborted(signal);
          const terminal = await markTerminal(row.id, {
            status: 'failed',
            terminalReason: 'progress_timeout',
            dispatchMessageId: row.dispatchMessageId,
            detail,
            events: [workerHealthEvent({
              runId: row.id,
              threadId: row.threadId,
              health: 'progress_timeout',
              detail,
              timestamp: updatedAt,
              phase: row.progressPhase,
            })],
          });
          throwIfAborted(signal);
          console.log(
            `[reaper] Reaped background run (id=${row.id}, threadId=${row.threadId}) — progress expired`,
          );
          if (terminal.ok) {
            emitWorkerTelemetry(() => {
              workerTierTelemetry.reaperAction(
                workerTelemetryContext(row),
              );
            });
          }
        }
        continue;
      }

      // Legacy in-process path never uses `dispatched`.
      if (row.status === 'dispatched') {
        continue;
      }

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
          throwIfAborted(signal);
          const won = await finalizeReconciledAgentRun({
            runId: row.id,
            threadId: row.threadId,
            status: 'failed',
            detail,
            events: [errorEvent, cancelEvent],
          });
          throwIfAborted(signal);
          if (won) {
            throwIfAborted(signal);
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
        throwIfAborted(signal);
        await failRun(row.id, row.threadId, detail, updatedAt);
        throwIfAborted(signal);
        await logMyWorkHealth(row.threadId, row.id, health, detail, 'error');
        throwIfAborted(signal);
        await publishHealthEvent({
          runId: row.id,
          threadId: row.threadId,
          health,
          detail,
          timestamp: updatedAt,
          phase: row.progressPhase,
          status: 'failed',
        }).catch((err) => console.error('[reaper] Failed to publish worker-loss event:', err));
        throwIfAborted(signal);
        await publishCancelSignal(row.threadId, row.id, updatedAt)
          .catch((err) => console.error('[reaper] Failed to publish cancel after worker-loss:', err));
        console.log(`[reaper] Reaped orphaned run (id=${row.id}, threadId=${row.threadId}) — heartbeat expired`);
        continue;
      }
      if (health === 'hard_timeout') {
        const detail = 'Run exceeded configured hard limit';
        throwIfAborted(signal);
        await failRun(row.id, row.threadId, detail, updatedAt);
        throwIfAborted(signal);
        await logMyWorkHealth(row.threadId, row.id, health, detail, 'error');
        throwIfAborted(signal);
        await publishHealthEvent({
          runId: row.id,
          threadId: row.threadId,
          health,
          detail,
          timestamp: updatedAt,
          phase: row.progressPhase,
          status: 'failed',
        }).catch((err) => console.error('[reaper] Failed to publish timeout event:', err));
        throwIfAborted(signal);
        await publishCancelSignal(row.threadId, row.id, updatedAt)
          .catch((err) => console.error('[reaper] Failed to publish cancel after hard timeout:', err));
        console.log(`[reaper] Reaped timed-out run (id=${row.id}, threadId=${row.threadId})`);
        continue;
      }
      if (health === 'progress_timeout') {
        const detail = `No meaningful progress for more than ${Math.round(config.progressAbortMs / 60_000)} minutes — run aborted`;
        throwIfAborted(signal);
        await failRun(row.id, row.threadId, detail, updatedAt);
        throwIfAborted(signal);
        await logMyWorkHealth(row.threadId, row.id, health, detail, 'error');
        throwIfAborted(signal);
        await publishHealthEvent({
          runId: row.id,
          threadId: row.threadId,
          health,
          detail,
          timestamp: updatedAt,
          phase: row.progressPhase,
          status: 'failed',
        }).catch((err) => console.error('[reaper] Failed to publish progress-timeout event:', err));
        throwIfAborted(signal);
        await publishCancelSignal(row.threadId, row.id, updatedAt)
          .catch((err) => console.error('[reaper] Failed to publish cancel after progress timeout:', err));
        console.log(`[reaper] Reaped progress-stalled run (id=${row.id}, threadId=${row.threadId})`);
        continue;
      }
      if (health === 'never_claimed') {
        throwIfAborted(signal);
        await db
          .update(agentRuns)
          .set({
            status: 'failed',
            lastError: 'Never claimed (worker lost before lease)',
            updatedAt,
          })
          .where(and(eq(agentRuns.id, row.id), eq(agentRuns.status, 'queued')));
        throwIfAborted(signal);
        await logMyWorkHealth(
          row.threadId,
          row.id,
          health,
          'Never claimed (worker lost before lease)',
          'error',
        );
        throwIfAborted(signal);
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
        throwIfAborted(signal);
        await db
          .update(agentRuns)
          .set({ lastError: warning, updatedAt })
          .where(and(eq(agentRuns.id, row.id), eq(agentRuns.status, 'running')));
        throwIfAborted(signal);
        await logMyWorkHealth(row.threadId, row.id, health, warning, 'warn');
        throwIfAborted(signal);
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
        throwIfAborted(signal);
        await db
          .update(agentRuns)
          .set({ lastError: null, updatedAt })
          .where(and(eq(agentRuns.id, row.id), eq(agentRuns.status, 'running')));
        throwIfAborted(signal);
        await logMyWorkHealth(row.threadId, row.id, 'healthy', 'Meaningful progress resumed', 'info');
        throwIfAborted(signal);
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

    if (recoverColdStarts) {
      throwIfAborted(signal);
      const recovery = await recoverStaleDispatchedRuns();
      if (recovery.selected > 0) {
        emitWorkerTelemetry(() => {
          workerTierTelemetry.reaperAction({ lane: 'background' });
        });
      }
    }
  } catch (err) {
    if (signal?.aborted || err instanceof RepoCacheLeaseLostError) {
      throw err;
    }
    console.error('[reaper] Failed to reap orphaned runs:', err);
  }
}

/**
 * Start the reaper: run immediately on startup, then repeat on interval.
 */
export function startReaper(): void {
  if (reaperTimer) {
    return;
  }

  void runReaperCycle('[reaper] Initial reap failed:');
  reaperTimer = setInterval(() => {
    void runReaperCycle('[reaper] Periodic reap failed:');
  }, REAP_INTERVAL_MS);
  reaperTimer.unref?.();
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
