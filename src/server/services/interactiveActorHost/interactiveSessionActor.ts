/**
 * FEAT-007 / TBI-010 + TBI-011 — Dapr virtual-actor session host (logic core).
 *
 * One actor per `threadId` (single activation). Turn-based concurrency is
 * enforced by {@link PerThreadTurnQueue}: at most one in-flight turn per thread,
 * applied in order (BR-015). Each turn reuses a live Cursor Agent when the
 * bounded per-thread cache hits, otherwise creates/resumes by `cursor_agent_id`
 * over a WARM grounded checkout reused across turns.
 *
 * TRANSPORT SPLIT (real-time refactor):
 *  - LIVE (ephemeral): token / tool / thinking / phase frames are published to
 *    the Redis live bus with incremental flushing (~60ms / ~256B) so the client
 *    streams smoothly. These are NOT persisted.
 *  - DURABLE (Postgres via fenced ingest): periodic progress heartbeats (refresh
 *    the reaper clocks + carry `cancelRequested`), the FINAL assistant message
 *    (so a refresh/replay always shows the full answer), and the `terminal` done.
 *
 * Every ingest carries the current dispatch fence; a stale fence aborts the turn
 * before further writes (BR-018). Cancellation is cooperative (a heartbeat's
 * ingest response `cancelRequested` → stop the SDK run → post cancel_ack). This
 * host never owns the client socket and never logs prompt/snapshot/secret
 * (BR-016, BR-019).
 */
import { randomUUID } from 'crypto';
import os from 'node:os';
import path from 'node:path';
import type { ExecutionSnapshot } from '../../../shared/types/agentRunLifecycle';
import type {
  AiRunIngestBody,
  AiRunIngestResponse,
  InlineInteractiveArtifact,
  InteractiveTurnStageTimings,
} from '../../../shared/types/aiRunIngest';
import type { AiRunBlobRef } from '../../../shared/types/aiRunV2';
import type {
  AgentRunEventEnvelope,
  ChatMessage,
  SseEvent,
} from '../../../shared/types/chat';
import {
  mcpServerNoToolFallback,
  mcpServerToolRetryPrompt,
  mcpServerTurnRequiresToolUse,
} from '../../../shared/types/mcpServers';
import { INTERACTIVE_LANE } from '../../../shared/types/interactiveWorkflow';
import {
  resolveChatAreaId,
  type HarnessAgentPhase,
  type HarnessControlMessage,
  type HarnessPendingControl,
  type HarnessRecreateReason,
} from '../../../shared/types/chatHarness';
import type { InteractiveStageName } from '../../../shared/types/workerTierOperations';
import {
  createCursorTurnEndMonitor,
  createCursorRunEventEnvelope,
  CursorExecutionWaitError,
  CursorStreamClosedBeforeTurnEndError,
  executeCursorExecutionCore,
  sanitizeCursorTerminalDetail,
  tokenFieldsForTerminalIngest,
  type CursorExecutionResult,
} from '../cursorExecutionCore';
import type { WorkerCursorExecutionRun } from '../aiRunsWorker/cursorExecution';
import { AdapterResumeStalledError } from '../cursorSdkAdapter/types';
import { normalizeGuidedInterviewResponse } from '../guidedInterviewState';
import {
  AiRunCallbackError,
  AiRunFenceConflictError,
} from '../aiRunsWorker/callbackClient';
import { workerTierTelemetry, type WorkerTierTelemetry } from '../workerTierTelemetry';
import {
  createIncrementalTokenBatcher,
  INTERACTIVE_TOKEN_BATCH_MAX_BYTES,
} from '../interactiveTokenBatcher';
import {
  createInteractiveDurableStreamBatcher,
  buildOffsetLiveTokenEvent,
} from '../interactiveDurableStreamBatcher';
import type {
  ChatHarnessControlBus,
  HarnessCancelDisposition,
  HarnessControlDisposition,
  HarnessSteerDisposition,
} from '../interactiveControlBus';
import {
  defaultAgentStoreSync,
  type AgentStoreRestoreStatus,
  type AgentStoreSync,
} from './agentStoreSync';
import type { InteractiveCursorAgentHandle } from './interactiveCursorExecution';
import { isRetryableCursorConnectionError } from './cursorConnectionError';
import { turnReadSources } from './brainstormSourceMount';
import type { InteractiveActorBootstrap } from '../../../shared/types/aiRunIngest';
import { createPerThreadTurnQueue, type PerThreadTurnQueue } from './perThreadTurnQueue';

/** Default cadence for durable progress heartbeats (clocks + cancel signal). */
const DEFAULT_HEARTBEAT_MS = 4_000;

/**
 * Durable interactive turns heartbeat on a timer from the moment they start,
 * so App Service can tell a slow turn (checkout, agent start) from a dead one.
 * Must stay well inside the reaper's durable heartbeat timeout.
 */
const DEFAULT_DURABLE_HEARTBEAT_MS = 15_000;

/** Idle TTL for the live per-thread Agent cache. */
export const INTERACTIVE_AGENT_CACHE_IDLE_MS = 10 * 60_000;

/** Hard cap on live Agent handles retained in this process. */
export const INTERACTIVE_AGENT_CACHE_MAX = 32;

/**
 * Disposing an Agent is cleanup, so a turn stops waiting on it after this long.
 * A dispose over a dropped Cursor connection can stay pending forever.
 */
export const INTERACTIVE_AGENT_DISPOSE_WAIT_MS = 5_000;

/**
 * Probe window for a warm or resumed Agent to emit its first SDK delta/event.
 * If zero events arrive within this window, the wedged session is cancelled,
 * evicted, and transparently recreated inside the same turn ("Reconnecting…").
 */
export const INTERACTIVE_WARM_FIRST_EVENT_PROBE_MS = 12_000;

/** Home-facing live phase detail before checkout / SDK work. */
export const INTERACTIVE_STARTING_DETAIL = 'Starting agent…';
/** Shown while a grounded turn downloads the project code. */
export const INTERACTIVE_LOADING_CODE_DETAIL = 'Preparing project repository…';
/** Shown once the Agent is ready and the prompt is going to the model. */
export const INTERACTIVE_THINKING_DETAIL = 'Thinking…';

export function brainstormSourceIdsSignature(
  bootstrap: Pick<InteractiveActorBootstrap, 'specification'>,
): string {
  const roots = turnReadSources(bootstrap.specification)?.readRoots ?? [];
  if (roots.length === 0) return '';
  return roots
    .map((root) => `${root.sourceId}:${root.commitSha.toLowerCase()}`)
    .sort()
    .join(',');
}
export function resolveInteractiveThreadWorkspacePath(
  threadId: string,
  _groundingSha?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.AI_RUNS_INTERACTIVE_ATTEMPT_ROOT?.trim();
  const root = configured && configured.length > 0 ? configured : os.tmpdir();
  // One stable folder per thread (no SHA segment) so the Cursor SDK agent
  // store keyed by working directory survives commit updates.
  return path.join(root, 'apex-interactive-thread', threadId);
}

/** Attempts remembered per process so a repeated dispatch never reruns a turn. */
const STARTED_ATTEMPTS_MAX = 1_000;

/** Publish a live (ephemeral) run-event envelope to the Redis backplane. */
export type LiveEnvelopePublisher = (
  threadId: string,
  envelope: AgentRunEventEnvelope,
) => Promise<void>;

class InteractiveCancellationObservedError extends Error {
  constructor() {
    super('Interactive turn cancellation requested');
    this.name = 'InteractiveCancellationObservedError';
  }
}

class WarmAgentFirstEventStalledError extends Error {
  constructor() {
    super('Warm or resumed Cursor agent produced no first event within probe window');
    this.name = 'WarmAgentFirstEventStalledError';
  }
}

/** Stop raced ahead and terminalized the run before a heartbeat observed it. */
function isStopRaceIngestError(error: unknown): boolean {
  return (
    error instanceof AiRunCallbackError
    && error.code === 'AI_RUN_ILLEGAL_TRANSITION'
  );
}

/** Max chars of a redacted failure reason surfaced durably + on the live bus. */
const MAX_FAILURE_REASON_LENGTH = 200;

/**
 * Drop an error message that could carry prompt/snapshot/secret/path material
 * (BR-016, BR-019). Returns a collapsed, length-capped message when it is safe
 * to surface, or an empty string when it looks sensitive.
 */
function redactFailureMessage(message: string): string {
  const collapsed = message.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  const looksSensitive =
    /(?:^|[\s"'=])(?:[a-z]:[\\/]|\\\\)/i.test(collapsed) ||
    /(?:^|[\s"'=])\/(?:home|users?|tmp|var|opt|mnt|root|private)\//i.test(
      collapsed,
    ) ||
    /\bBearer\s+\S+/i.test(collapsed) ||
    /(?:password|passwd|token|secret|credential|api[_-]?key)\s*[=:]/i.test(
      collapsed,
    ) ||
    /(?:prompt|snapshot|workspace(?:Dir|Path|Content)?)\s*[=:]/i.test(
      collapsed,
    ) ||
    /https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(collapsed);
  if (looksSensitive) return '';
  return collapsed.slice(0, MAX_FAILURE_REASON_LENGTH);
}

/**
 * Build a short, secret-safe description of a fatal turn error so the durable
 * terminal (`last_error`), the live error frame, and container logs carry the
 * real cause instead of the opaque "Interactive turn failed". We surface the
 * error class + code, plus a redacted message slice only when it is safe.
 */
function describeInteractiveFailure(error: unknown): {
  reason: string;
  errorName: string;
  errorCode: string | null;
} {
  const err =
    error && typeof error === 'object'
      ? (error as { name?: unknown; message?: unknown; code?: unknown })
      : null;
  const errorName =
    (typeof err?.name === 'string' && err.name.trim()) || 'Error';
  const errorCode =
    typeof err?.code === 'string' && err.code.trim()
      ? err.code.trim().slice(0, 64)
      : null;
  const redactedMessage =
    error instanceof CursorExecutionWaitError && error.terminalStatusMessage
      ? redactFailureMessage(sanitizeCursorTerminalDetail(error.terminalStatusMessage))
      : redactFailureMessage(typeof err?.message === 'string' ? err.message : '');
  const head = errorCode ? `${errorName} (${errorCode})` : errorName;
  const reason = redactedMessage
    ? `Interactive turn failed: ${head}: ${redactedMessage}`
    : `Interactive turn failed: ${head}`;
  return {
    reason: reason.slice(0, MAX_FAILURE_REASON_LENGTH),
    errorName: errorName.slice(0, 64),
    errorCode,
  };
}

/** Warm per-thread session reused across turns (single activation). */
export interface WarmThreadCheckout {
  workspacePath: string;
  dispose?(): Promise<void>;
}

export interface InteractiveTurnRequest {
  runId: string;
  threadId: string;
  projectId: string;
  dispatchMessageId: string;
  /** Frozen per-turn execution inputs (prompt/model/workspaceRef/skill/...). */
  snapshot: Readonly<ExecutionSnapshot>;
  /** Existing Cursor session to resume; absent on the thread's first turn. */
  cursorAgentId?: string | null;
}

export type InteractiveTurnOutcome =
  | { status: 'completed'; cursorAgentId?: string | null }
  | { status: 'accepted' }
  | { status: 'duplicate' }
  | { status: 'cancelled' }
  | { status: 'failed'; failureCategory?: 'hard_timeout' | 'tool_timeout' }
  | { status: 'fence-conflict' };

export interface InteractiveActorDependencies {
  /** Open or reuse the thread's warm grounded checkout (reused across turns). */
  openWarmCheckout(
    threadId: string,
    snapshot: Readonly<ExecutionSnapshot>,
  ): Promise<WarmThreadCheckout>;
  /**
   * Acquire (create/resume) a live Cursor Agent without sending yet — allows
   * the actor to retain the same Agent across serialized turns.
   */
  acquireAgent(
    snapshot: Readonly<ExecutionSnapshot>,
    checkout: WarmThreadCheckout,
    options: {
      resumeAgentId?: string | null;
      mcpServers?: Readonly<Record<string, { url: string }>>;
    },
  ): Promise<InteractiveCursorAgentHandle>;
  /**
   * Durable V2 acquisition that returns warm/resumed/recreated modes. When
   * omitted, {@link handleDurableTurn} falls back to {@link acquireAgent}.
   */
  acquireDurableAgent?(
    bootstrap: InteractiveActorBootstrap,
    checkout: WarmThreadCheckout,
    options: { resumeAgentId?: string | null },
  ): Promise<
    import('./interactiveCursorExecution').InteractiveAgentAcquisition
  >;
  /**
   * Materialize a pinned attempt-local workspace for durable turns.
   * `reclaimDisk` removes idle threads' workspaces so a checkout refused for
   * disk space can be retried.
   */
  materializeWorkspace?(
    bootstrap: InteractiveActorBootstrap,
    destination: string,
    signal: AbortSignal,
    options?: { reclaimDisk(): Promise<void> },
  ): Promise<WarmThreadCheckout>;
  /**
   * Collect attempt-local outputs and upload them when there is something to
   * store. Returns no ref when the workspace has no eligible files. A durable
   * completed terminal still sets `artifactsFlushed: true`.
   */
  uploadAttemptArtifacts?(
    bootstrap: InteractiveActorBootstrap,
    workspacePath: string,
    signal: AbortSignal,
  ): Promise<AttemptArtifactsUploadResult>;
  /** Fenced runner ingest (reuses /api/internal/ai-runs/.../ingest). */
  postIngest(
    projectId: string,
    runId: string,
    body: AiRunIngestBody,
  ): Promise<AiRunIngestResponse>;
  /**
   * Publish an ephemeral live envelope to the Redis backplane. Omitted (or a
   * no-op) when Redis is unconfigured — the client then relies on the durable
   * final message + `/run-status` safety net.
   */
  publishLive?: LiveEnvelopePublisher;
  turnQueue?: PerThreadTurnQueue;
  telemetry?: WorkerTierTelemetry;
  batchMaxBytes?: number;
  sourceInstance?: string;
  /** Durable progress heartbeat cadence in ms (default 4000). */
  heartbeatMs?: number;
  /** Timer heartbeat cadence for durable V2 turns in ms (default 15000). */
  durableHeartbeatMs?: number;
  now?: () => number;
  /** Idle TTL for cached Agents (default 10 minutes). */
  agentCacheIdleMs?: number;
  /** Max cached Agents in this process (default 32). */
  agentCacheMax?: number;
  /** Probe window in ms before a silent warm/resumed Agent is recreated in-turn (default 12s). */
  warmFirstEventProbeMs?: number;
  /** Optional Redis control bus for low-latency steer/cancel delivery and acks. */
  controlBus?: Pick<ChatHarnessControlBus, 'subscribeControl' | 'publishAck'>;
  /** Optional Blob backup/restore sync for the thread's SDK agent store. */
  agentStoreSync?: AgentStoreSync;
  /** Optional host revision identifier used to attribute deploy-driven recreations. */
  hostRevision?: string | (() => string | null);
}

export type AttemptArtifactsUploadResult =
  | AiRunBlobRef
  | Readonly<{
      manifestRef?: AiRunBlobRef;
      inlineArtifacts?: ReadonlyArray<InlineInteractiveArtifact>;
    }>
  | undefined;

function unpackAttemptArtifactsResult(result: AttemptArtifactsUploadResult): {
  artifactManifestRef?: AiRunBlobRef;
  inlineArtifacts?: ReadonlyArray<InlineInteractiveArtifact>;
} {
  if (!result) return {};
  if ('container' in result && 'key' in result) {
    return { artifactManifestRef: result };
  }
  return {
    ...(result.manifestRef ? { artifactManifestRef: result.manifestRef } : {}),
    ...(result.inlineArtifacts && result.inlineArtifacts.length > 0
      ? { inlineArtifacts: result.inlineArtifacts }
      : {}),
  };
}

export interface InteractiveSteerInput {
  threadId: string;
  runId: string;
  commandId: string;
  text: string;
}

export interface InteractiveCancelInput {
  threadId: string;
  runId: string;
  commandId: string;
}

export interface InteractiveSessionActor {
  handleTurn(request: InteractiveTurnRequest): Promise<InteractiveTurnOutcome>;
  handleDurableTurn(request: {
    threadId: string;
    bootstrap: InteractiveActorBootstrap;
  }): Promise<InteractiveTurnOutcome>;
  steer?(input: InteractiveSteerInput): Promise<HarnessSteerDisposition>;
  cancel?(input: InteractiveCancelInput): Promise<HarnessCancelDisposition>;
  /** Dispose every warm checkout + cached Agent (process shutdown / deactivation). */
  disposeAll(): Promise<void>;
}

export interface InteractiveSessionActorController
  extends InteractiveSessionActor {
  steer(input: InteractiveSteerInput): Promise<HarnessSteerDisposition>;
  cancel(input: InteractiveCancelInput): Promise<HarnessCancelDisposition>;
}

interface CachedAgentEntry {
  handle: InteractiveCursorAgentHandle;
  lastUsedAt: number;
  /** Signature of mounted Brainstorm source IDs + SHAs when the Agent's customTools were built. */
  brainstormSourcesSignature?: string;
  /** Pinned grounding SHA materialized into the stable thread workspace. */
  groundingSha?: string | null;
  /** Removes the thread workspace the cached Agent runs in. */
  releaseWorkspace?: () => Promise<void>;
}

interface ActiveTurnController {
  readonly runId: string;
  handleSteer(
    commandId: string,
    text: string,
  ): Promise<HarnessSteerDisposition>;
  handleCancel(commandId: string): Promise<HarnessCancelDisposition>;
}

interface RecreateReasonInput {
  hadPriorBinding: boolean;
  wasIdleEvicted: boolean;
  workspaceChanged: boolean;
  hostRevisionChanged: boolean;
  storeRestoreStatus: AgentStoreRestoreStatus | null;
  resumeReturnedNotFound?: boolean;
}

function resolveRecreateReason(input: RecreateReasonInput): HarnessRecreateReason {
  if (input.workspaceChanged) return 'folder-change';
  if (input.hostRevisionChanged) return 'deploy';
  if (input.hadPriorBinding && input.storeRestoreStatus === 'missing') {
    return 'replica-move';
  }
  if (
    input.hadPriorBinding &&
    (input.resumeReturnedNotFound || input.storeRestoreStatus === 'restored')
  ) {
    return 'sdk-version';
  }
  if (input.wasIdleEvicted) return 'idle-eviction';
  return 'unknown';
}

function mergePendingSteersIntoPrompt(
  basePrompt: string,
  steers: ReadonlyArray<{ commandId: string; text: string }>,
): string {
  if (steers.length === 0) return basePrompt;
  const steerBlock = steers
    .map((item) => item.text.trim())
    .filter((text) => text.length > 0)
    .join('\n\n');
  if (!steerBlock) return basePrompt;
  return `${basePrompt}\n\nAdditional user guidance:\n${steerBlock}`;
}

function isAdapterResumeStalledError(
  error: unknown,
): error is AdapterResumeStalledError {
  return (
    error instanceof AdapterResumeStalledError ||
    (error instanceof Error && error.name === 'AdapterResumeStalledError')
  );
}

function isSuccessfulWait(result: CursorExecutionResult): boolean {
  if (result.completedOnTurnEnd) return true;
  const status = result.waitResult.status.trim().toLowerCase();
  return status === 'finished' || status === 'completed' || status === 'success';
}

function firstNonEmptySummaryText(
  ...candidates: Array<string | null | undefined>
): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return undefined;
}

function extractDeltaSummaryText(update: unknown): string | undefined {
  if (!update || typeof update !== 'object') return undefined;
  const record = update as { type?: unknown; summary?: unknown };
  if (record.type === 'summary' && typeof record.summary === 'string') {
    return firstNonEmptySummaryText(record.summary);
  }
  return undefined;
}

/**
 * Rejects with the signal's reason once it aborts, even if `work` never
 * settles; a hung Cursor stream or wait must not outlive the turn deadline.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => {});
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function logInteractiveAgentStep(
  event: string,
  fields: Record<string, unknown>,
): void {
  console.log(JSON.stringify({ event, ...fields }));
}

/** Waits for `dispose` up to `ms`; reports whether it finished in time. */
async function disposeWithin(
  dispose: () => Promise<void>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      dispose().then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function unsuccessfulWaitDetail(result: CursorExecutionResult): string {
  const status = result.waitResult.status
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    || 'unknown';
  const waitError =
    result.waitResult.error
    && typeof result.waitResult.error === 'object'
    && typeof (result.waitResult.error as { message?: unknown }).message ===
      'string'
      ? (result.waitResult.error as { message: string }).message
      : '';
  const detail = redactFailureMessage(
    sanitizeCursorTerminalDetail(result.terminalStatusMessage || waitError),
  );
  return detail
    ? `Interactive turn ended with status: ${status}: ${detail}`
    : `Interactive turn ended with status: ${status}`;
}

export function createInteractiveSessionActor(
  dependencies: InteractiveActorDependencies,
): InteractiveSessionActorController {
  const turnQueue = dependencies.turnQueue ?? createPerThreadTurnQueue();
  const telemetry = dependencies.telemetry ?? workerTierTelemetry;
  const batchMaxBytes =
    dependencies.batchMaxBytes ?? INTERACTIVE_TOKEN_BATCH_MAX_BYTES;
  const sourceInstance =
    dependencies.sourceInstance ?? 'ai-runs-interactive-actor';
  const heartbeatMs = dependencies.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const durableHeartbeatMs =
    dependencies.durableHeartbeatMs ?? DEFAULT_DURABLE_HEARTBEAT_MS;
  const publishLive: LiveEnvelopePublisher =
    dependencies.publishLive ?? (async () => {});
  const now = dependencies.now ?? Date.now;
  const agentCacheIdleMs =
    dependencies.agentCacheIdleMs ?? INTERACTIVE_AGENT_CACHE_IDLE_MS;
  const agentCacheMax =
    dependencies.agentCacheMax ?? INTERACTIVE_AGENT_CACHE_MAX;
  const warmFirstEventProbeMs =
    dependencies.warmFirstEventProbeMs ?? INTERACTIVE_WARM_FIRST_EVENT_PROBE_MS;
  const agentStoreSync = dependencies.agentStoreSync ?? defaultAgentStoreSync;
  const resolveHostRevision = (): string | null => {
    if (typeof dependencies.hostRevision === 'function') {
      return dependencies.hostRevision()?.trim() || null;
    }
    if (typeof dependencies.hostRevision === 'string') {
      return dependencies.hostRevision.trim() || null;
    }
    return process.env.CONTAINER_APP_REVISION?.trim() || null;
  };

  // Warm session cache keyed by threadId — single activation reuses the
  // grounded checkout and live Cursor Agent across turns.
  const warmCheckouts = new Map<string, WarmThreadCheckout>();
  const agentCache = new Map<string, CachedAgentEntry>();
  const agentIdByThread = new Map<string, string | null>();
  // Agents whose resume stalled; the next turn recreates instead of resuming.
  const unresumableAgentIds = new Set<string>();
  // Threads whose cached Agent was evicted due to idle TTL or cache overflow.
  const evictedThreads = new Set<string>();
  const lastWorkspacePathByThread = new Map<string, string>();
  const lastHostRevisionByThread = new Map<string, string | null>();
  // Active per-thread control handlers for steer/cancel delivery.
  const activeTurns = new Map<string, ActiveTurnController>();

  const emitStage = (
    context: {
      runId: string;
      dispatchMessageId: string;
      project: string;
      lane: string;
    },
    stage: InteractiveStageName,
    startedAt: number,
  ): void => {
    try {
      telemetry.interactiveStage(context, stage, Math.max(0, now() - startedAt));
    } catch {
      // Telemetry must never affect the turn.
    }
  };

  const disposeAgentHandle = async (
    threadId: string,
    handle: InteractiveCursorAgentHandle,
  ): Promise<void> => {
    const disposed = await disposeWithin(
      () => handle.dispose(),
      INTERACTIVE_AGENT_DISPOSE_WAIT_MS,
    );
    if (!disposed) {
      logInteractiveAgentStep('InteractiveAgentDisposeTimedOut', {
        threadId,
        agentId: handle.agentId,
        waitedMs: INTERACTIVE_AGENT_DISPOSE_WAIT_MS,
      });
    }
  };

  const disposeAgentEntry = async (threadId: string): Promise<void> => {
    const entry = agentCache.get(threadId);
    if (!entry) return;
    agentCache.delete(threadId);
    await disposeAgentHandle(threadId, entry.handle);
    await entry.releaseWorkspace?.().catch(() => {});
  };

  const startedAttempts = new Set<string>();
  const claimAttempt = (attemptId: string): boolean => {
    if (startedAttempts.has(attemptId)) return false;
    startedAttempts.add(attemptId);
    if (startedAttempts.size > STARTED_ATTEMPTS_MAX) {
      const oldest = startedAttempts.values().next().value;
      if (oldest !== undefined) startedAttempts.delete(oldest);
    }
    return true;
  };

  const disposeCheckout = async (threadId: string): Promise<void> => {
    const checkout = warmCheckouts.get(threadId);
    if (!checkout) return;
    warmCheckouts.delete(threadId);
    await checkout.dispose?.().catch(() => {});
  };

  const invalidateThread = async (threadId: string): Promise<void> => {
    await disposeAgentEntry(threadId);
    await disposeCheckout(threadId);
  };

  const evictExpiredAgents = async (): Promise<void> => {
    const cutoff = now() - agentCacheIdleMs;
    for (const [threadId, entry] of agentCache) {
      if (entry.lastUsedAt < cutoff) {
        evictedThreads.add(threadId);
        await disposeAgentEntry(threadId);
      }
    }
  };

  // Threads with a durable turn in progress; their cached Agent and workspace
  // are in use and must not be evicted.
  const activeDurableThreads = new Set<string>();

  const evictIdleDurableAgents = async (cutoff: number): Promise<void> => {
    for (const [threadId, entry] of agentCache) {
      if (activeDurableThreads.has(threadId)) continue;
      if (entry.lastUsedAt < cutoff) {
        evictedThreads.add(threadId);
        await disposeAgentEntry(threadId);
      }
    }
  };

  const evictOverflowAgents = async (retainThreadId: string): Promise<void> => {
    while (agentCache.size > agentCacheMax) {
      let oldestThreadId: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [threadId, entry] of agentCache) {
        if (threadId === retainThreadId) continue;
        if (activeDurableThreads.has(threadId)) continue;
        if (entry.lastUsedAt < oldestAt) {
          oldestAt = entry.lastUsedAt;
          oldestThreadId = threadId;
        }
      }
      if (!oldestThreadId) break;
      evictedThreads.add(oldestThreadId);
      await disposeAgentEntry(oldestThreadId);
    }
  };

  const runTurn = async (
    request: InteractiveTurnRequest,
  ): Promise<InteractiveTurnOutcome> => {
    const { runId, threadId, projectId, dispatchMessageId, snapshot } = request;
    const resolvedArea = resolveChatAreaId(snapshot.workflowClass);
    const telemetryContext = {
      runId,
      dispatchMessageId,
      project: projectId,
      lane: INTERACTIVE_LANE,
      ...(resolvedArea ? { area: resolvedArea } : {}),
    };

    let fenceConflict: AiRunFenceConflictError | undefined;
    let cancellationRequested = false;
    let firstTokenAt: number | null = null;
    let firstSdkEventAt: number | null = null;
    const turnStartedAt = now();
    let sequence = 0;
    let agentHandle: InteractiveCursorAgentHandle | undefined;
    let retainAgent = false;
    let activeRun: WorkerCursorExecutionRun | undefined;

    const stopRun = async (): Promise<void> => {
      if (activeRun?.cancel) await activeRun.cancel().catch(() => {});
    };

    // Serialized fenced ingest post; a 409 latches the fence conflict so no
    // later callback is attempted (BR-018).
    const post = async (
      body: AiRunIngestBody,
      abortOnCancellation = true,
    ): Promise<void> => {
      if (fenceConflict) throw fenceConflict;
      let response: AiRunIngestResponse;
      try {
        response = await dependencies.postIngest(projectId, runId, body);
      } catch (error) {
        if (error instanceof AiRunFenceConflictError) {
          fenceConflict = error;
          await stopRun();
        } else if (isStopRaceIngestError(error)) {
          // cancelRun already terminalized — stop the SDK and exit as cancelled.
          cancellationRequested = true;
          await stopRun();
        }
        throw error;
      }
      if (response.cancelRequested && body.kind !== 'cancel_ack') {
        cancellationRequested = true;
        await stopRun();
        if (abortOnCancellation) throw new InteractiveCancellationObservedError();
      }
    };

    // Live path: incremental (time/size) flush to Redis for a real-time feel.
    const liveBatcher = createIncrementalTokenBatcher({
      maxBytes: batchMaxBytes,
      now,
    });
    let liveSequence = 0;
    let lastHeartbeatAt = turnStartedAt;

    const liveEnvelopeFor = (event: SseEvent): AgentRunEventEnvelope =>
      createCursorRunEventEnvelope({
        threadId,
        runId,
        sourceInstance,
        sequence: (liveSequence += 1),
        timestamp: new Date(now()).toISOString(),
        event,
      });

    // Ephemeral live fan-out; best effort — durability rides ingest/Postgres.
    const publishLiveEvent = async (event: SseEvent): Promise<void> => {
      await publishLive(threadId, liveEnvelopeFor(event)).catch(() => {});
    };

    const emitTokenBatch = async (text: string): Promise<void> => {
      if (firstTokenAt === null) {
        firstTokenAt = now();
        emitStage(telemetryContext, 'first_token', turnStartedAt);
        try {
          telemetry.interactiveFirstToken(
            telemetryContext,
            firstTokenAt - turnStartedAt,
          );
        } catch {
          // Telemetry must never affect the turn.
        }
      }
      await publishLiveEvent({ type: 'token', text });
    };

    const publishTokenBatches = async (batches: string[]): Promise<void> => {
      for (const batch of batches) await emitTokenBatch(batch);
    };

    // Durable progress heartbeat: refreshes the reaper clocks and surfaces
    // `cancelRequested`. Throttled so token cadence stays on the Redis path.
    const maybeHeartbeat = async (): Promise<void> => {
      const at = now();
      if (at - lastHeartbeatAt < heartbeatMs) return;
      lastHeartbeatAt = at;
      await post({
        dispatchMessageId,
        kind: 'progress',
        phase: 'implementation',
        status: 'running',
      });
    };

    try {
      // Immediate Home feedback before checkout / Cursor SDK work.
      await publishLiveEvent({
        type: 'phase',
        phase: 'setup',
        status: 'running',
        detail: INTERACTIVE_STARTING_DETAIL,
      });

      await evictExpiredAgents();

      // Invalidate warm checkout + Agent when the grounded workspace changes so
      // tools never stay bound to a stale repository snapshot.
      const existingCheckout = warmCheckouts.get(threadId);
      if (
        existingCheckout
        && existingCheckout.workspacePath !== snapshot.workspaceRef
      ) {
        await invalidateThread(threadId);
      }

      let checkout = warmCheckouts.get(threadId);
      const checkoutStartedAt = now();
      if (!checkout) {
        checkout = await dependencies.openWarmCheckout(threadId, snapshot);
        warmCheckouts.set(threadId, checkout);
        emitStage(telemetryContext, 'checkout_open', checkoutStartedAt);
      } else {
        emitStage(telemetryContext, 'checkout_hit', checkoutStartedAt);
      }

      const cached = agentCache.get(threadId);
      const cacheCompatible =
        cached
        && cached.handle.model === snapshot.model
        && cached.handle.workspaceRef === snapshot.workspaceRef;

      const agentStartedAt = now();
      if (cacheCompatible && cached) {
        agentHandle = cached.handle;
        emitStage(telemetryContext, 'agent_cache_hit', agentStartedAt);
      } else {
        if (cached) await disposeAgentEntry(threadId);
        const resumeAgentId =
          request.cursorAgentId ?? agentIdByThread.get(threadId) ?? null;
        agentHandle = await dependencies.acquireAgent(snapshot, checkout, {
          resumeAgentId,
        });
        emitStage(
          telemetryContext,
          resumeAgentId ? 'agent_resume' : 'agent_create',
          agentStartedAt,
        );
      }

      if (agentHandle.agentId) {
        agentIdByThread.set(threadId, agentHandle.agentId);
      }

      const sendStartedAt = now();
      const turnEndMonitor = createCursorTurnEndMonitor();
      activeRun = await agentHandle.send(snapshot.prompt, {
        requestId: snapshot.requestId ?? runId,
        onDelta: (update) => turnEndMonitor.observe(update),
      });
      emitStage(telemetryContext, 'send', sendStartedAt);

      let result: CursorExecutionResult;
      try {
        result = await executeCursorExecutionCore({
          snapshot,
          run: activeRun,
          context: { runId, sourceInstance },
          sink: {
            publish: async (event: SseEvent) => {
              if (fenceConflict) throw fenceConflict;
              if (cancellationRequested) {
                throw new InteractiveCancellationObservedError();
              }
              if (firstSdkEventAt === null) {
                firstSdkEventAt = now();
                emitStage(telemetryContext, 'first_sdk_event', turnStartedAt);
              }
              if (event.type === 'token') {
                // Real-time: incremental flush to Redis (no NOTIFY cap).
                await publishTokenBatches(liveBatcher.push(event.text, now()));
              } else {
                // tool / thinking / phase → ephemeral live fan-out.
                await publishLiveEvent(event);
              }
              // Durable heartbeat keeps clocks fresh + carries cancellation.
              await maybeHeartbeat();
            },
          },
          hooks: {
            beforeStreamEvent: () => {
              if (fenceConflict) throw fenceConflict;
              if (cancellationRequested) {
                throw new InteractiveCancellationObservedError();
              }
            },
          },
          nextSequence: () => ++sequence,
          turnEnd: turnEndMonitor.completion,
        });
      } finally {
        const tail = liveBatcher.flush();
        if (tail && !fenceConflict && !cancellationRequested) {
          await emitTokenBatch(tail).catch(() => {});
        }
      }

      if (cancellationRequested) throw new InteractiveCancellationObservedError();
      if (!isSuccessfulWait(result)) {
        throw new Error(unsuccessfulWaitDetail(result));
      }

      // Durable FINAL assistant message so a refresh/replay always shows the
      // full answer. Also delivered live with the SAME message.id, so the
      // client de-dupes the live copy against the durable replay copy.
      const finalText = result.text;
      if (finalText && finalText.trim().length > 0) {
        const finalMessage: ChatMessage = {
          id: randomUUID(),
          role: 'agent',
          text: finalText,
          ts: new Date(now()).toISOString(),
        };
        await publishLiveEvent({ type: 'message', message: finalMessage });
        await post({
          dispatchMessageId,
          kind: 'progress',
          event: { type: 'message', message: finalMessage },
        });
      }

      const cursorAgentId = agentHandle.agentId ?? agentIdByThread.get(threadId) ?? null;
      await post({
        dispatchMessageId,
        kind: 'terminal',
        status: 'completed',
        artifactsFlushed: true,
        cursorAgentId,
        durationMs: Math.max(0, now() - turnStartedAt),
        ...tokenFieldsForTerminalIngest(result.usage),
      });
      // Live terminal so the socket clears the spinner immediately; the durable
      // `done` (agent_run_events) covers reconnect replay, and the client's
      // `/run-status` poll is the belt-and-suspenders safety net.
      await publishLiveEvent({ type: 'done', runId });

      // Retain the live Agent for the next serialized turn on this thread.
      agentCache.set(threadId, { handle: agentHandle, lastUsedAt: now() });
      retainAgent = true;
      await evictOverflowAgents(threadId);

      try {
        telemetry.interactiveTurn(telemetryContext, now() - turnStartedAt);
      } catch {
        // ignore
      }
      emitStage(telemetryContext, 'completion', turnStartedAt);
      return { status: 'completed', cursorAgentId };
    } catch (error) {
      retainAgent = false;
      if (fenceConflict || error instanceof AiRunFenceConflictError) {
        await disposeAgentEntry(threadId);
        // A stale fence aborts before any further write (BR-018).
        return { status: 'fence-conflict' };
      }
      if (
        cancellationRequested ||
        error instanceof InteractiveCancellationObservedError ||
        isStopRaceIngestError(error)
      ) {
        await disposeAgentEntry(threadId);
        await dependencies
          .postIngest(projectId, runId, {
            dispatchMessageId,
            kind: 'cancel_ack',
            detail: 'Interactive turn stopped',
          })
          .catch(() => {});
        // Clear the live spinner (durable cancel/done covers replay).
        // Never publish a live `error` on user Stop — the client would show
        // "Interactive turn failed" with Try again.
        await publishLiveEvent({ type: 'done', runId }).catch(() => {});
        return { status: 'cancelled' };
      }
      await disposeAgentEntry(threadId);
      // Unmask the real cause (redacted) so the durable terminal (`last_error`),
      // the live error frame, and container logs are diagnosable instead of the
      // opaque "Interactive turn failed". Redaction keeps prompt/snapshot/secret
      // material out (BR-016, BR-019).
      const failure = describeInteractiveFailure(error);
      console.error('[interactive] turn failed', {
        runId,
        errorName: failure.errorName,
        errorCode: failure.errorCode,
        reason: failure.reason,
      });
      // Live failure so the socket surfaces the error and stops spinning; the
      // durable failed terminal + `done` (below, via ingest) cover replay.
      await publishLiveEvent({
        type: 'error',
        error: failure.reason,
        errorCode: 'fatal',
      }).catch(() => {});
      await publishLiveEvent({ type: 'done', runId }).catch(() => {});
      await post({
        dispatchMessageId,
        kind: 'terminal',
        status: 'failed',
        detail: failure.reason,
        artifactsFlushed: false,
      }).catch(() => {});
      throw error;
    } finally {
      // Dispose only when we are not retaining a warm Agent for the next turn.
      if (!retainAgent && agentHandle && !agentCache.has(threadId)) {
        await agentHandle.dispose().catch(() => {});
      }
    }
  };

  return {
    handleTurn(request: InteractiveTurnRequest): Promise<InteractiveTurnOutcome> {
      // BR-015: serialize per thread — one in-flight turn, applied in order.
      return turnQueue.submit(request.threadId, () => runTurn(request));
    },
    handleDurableTurn(request: {
      threadId: string;
      bootstrap: InteractiveActorBootstrap;
    }): Promise<InteractiveTurnOutcome> {
      if (!claimAttempt(request.bootstrap.attemptId)) {
        return Promise.resolve({ status: 'duplicate' });
      }
      return turnQueue.submit(request.threadId, () =>
        runDurableTurn(request.threadId, request.bootstrap),
      );
    },
    async steer(input: InteractiveSteerInput): Promise<HarnessSteerDisposition> {
      const controller = activeTurns.get(input.threadId);
      if (!controller || (input.runId && controller.runId !== input.runId)) {
        return 'turn-ended';
      }
      return controller.handleSteer(input.commandId, input.text);
    },
    async cancel(
      input: InteractiveCancelInput,
    ): Promise<HarnessCancelDisposition> {
      const controller = activeTurns.get(input.threadId);
      if (!controller || (input.runId && controller.runId !== input.runId)) {
        return 'turn-ended';
      }
      return controller.handleCancel(input.commandId);
    },
    async disposeAll(): Promise<void> {
      const threadIds = new Set([
        ...warmCheckouts.keys(),
        ...agentCache.keys(),
      ]);
      for (const threadId of threadIds) {
        await invalidateThread(threadId);
      }
      agentIdByThread.clear();
      evictedThreads.clear();
      lastWorkspacePathByThread.clear();
      lastHostRevisionByThread.clear();
      activeTurns.clear();
    },
  };

  async function runDurableTurn(
    threadId: string,
    bootstrap: InteractiveActorBootstrap,
  ): Promise<InteractiveTurnOutcome> {
    const {
      runId,
      dispatchMessageId,
      projectId,
      specification,
      effectiveDeadlines,
      absoluteDeadlineAt,
      attemptId,
      cursorAgentId,
      mcpServers,
    } = bootstrap;

    const absoluteMs = Date.parse(absoluteDeadlineAt);
    const nowMs = now();
    const deadlinesInvalid =
      !Number.isFinite(absoluteMs) ||
      !Number.isFinite(effectiveDeadlines.firstEventMs) ||
      effectiveDeadlines.firstEventMs <= 0 ||
      !Number.isFinite(effectiveDeadlines.toolCallMs) ||
      effectiveDeadlines.toolCallMs <= 0 ||
      (effectiveDeadlines.repositoryPreparationMs !== null &&
        (!(effectiveDeadlines.repositoryPreparationMs > 0)));
    if (deadlinesInvalid || absoluteMs <= nowMs) {
      // The attempt is already claimed, so a redelivery is a duplicate; this
      // turn must report its own terminal or the run stays open until the reaper.
      const expired = !deadlinesInvalid;
      await dependencies
        .postIngest(projectId, runId, {
          kind: 'terminal',
          status: 'failed',
          detail: expired
            ? 'Interactive absolute deadline exceeded'
            : 'Interactive effective deadlines are missing or invalid',
          artifactsFlushed: false,
          ...(expired ? { failureCategory: 'hard_timeout' as const } : {}),
          attemptId,
          dispatchMessageId,
        })
        .catch(() => {});
      return expired
        ? { status: 'failed', failureCategory: 'hard_timeout' }
        : { status: 'failed' };
    }

    const absoluteAbort = new AbortController();
    // Node timers are 32-bit; clamp so far-future absolute deadlines do not wrap.
    const ABSOLUTE_TIMER_MAX_MS = 2_147_483_647;
    const absoluteTimer = setTimeout(
      () =>
        absoluteAbort.abort(
          Object.assign(new Error('hard_timeout'), { code: 'hard_timeout' }),
        ),
      Math.min(ABSOLUTE_TIMER_MAX_MS, Math.max(1, absoluteMs - nowMs)),
    );

    let attemptCheckout: WarmThreadCheckout | undefined;
    let toolTimer: ReturnType<typeof setTimeout> | undefined;
    let activeRunRef: WorkerCursorExecutionRun | undefined;
    let agentHandle: InteractiveCursorAgentHandle | undefined;
    let retainAgent = false;
    let fenceConflict = false;
    let cancellationRequested = false;
    let failureCategory: 'hard_timeout' | 'tool_timeout' | null = null;
    let firstEventTimedOut = false;
    let silenceTimedOut = false;
    let firstEventSeen = false;
    let firstEventTimer: ReturnType<typeof setTimeout> | undefined;
    let warmProbeTimer: ReturnType<typeof setTimeout> | undefined;
    let silenceTimer: ReturnType<typeof setTimeout> | undefined;
    let workspaceMs: number | undefined;
    let agentAcquireMs: number | undefined;
    let agentMode: InteractiveTurnStageTimings['agentMode'];
    let recreateReason: HarnessRecreateReason | undefined;
    let clearCursorAgentId = false;
    let storeRestoreStatus: AgentStoreRestoreStatus | null = null;
    let sendStartedAt: number | undefined;
    let firstEventAt: number | undefined;
    let firstTokenAt: number | undefined;

    let phase: HarnessAgentPhase = 'starting';
    let turnEnded = false;
    let sendIssued = false;
    const appliedControlDispositions = new Map<
      string,
      HarnessControlDisposition
    >();
    const pendingPromptSteers: Array<{ commandId: string; text: string }> = [];
    const heldSummarySteers: Array<{ commandId: string; text: string }> = [];
    const queuedRunningSteers: Array<{ commandId: string; text: string }> = [];
    let cancelAckPromise: Promise<void> | null = null;

    const stageTimings = (): InteractiveTurnStageTimings => ({
      ...(workspaceMs !== undefined ? { workspaceMs } : {}),
      ...(agentAcquireMs !== undefined ? { agentAcquireMs } : {}),
      ...(agentMode ? { agentMode } : {}),
      ...(recreateReason ? { recreateReason } : {}),
      ...(sendStartedAt !== undefined && firstEventAt !== undefined
        ? { firstEventMs: Math.max(0, firstEventAt - sendStartedAt) }
        : {}),
      ...(sendStartedAt !== undefined && firstTokenAt !== undefined
        ? { firstTokenMs: Math.max(0, firstTokenAt - sendStartedAt) }
        : {}),
      workerTurnMs: Math.max(0, now() - nowMs),
    });

    const stopRun = async (): Promise<void> => {
      if (activeRunRef?.cancel) {
        await activeRunRef.cancel().catch(() => {});
      } else if (agentHandle?.cancel) {
        await agentHandle.cancel().catch(() => {});
      }
    };

    const publishControlAck = async (
      commandId: string,
      kind: 'steer' | 'cancel',
      disposition: HarnessControlDisposition,
    ): Promise<void> => {
      if (!dependencies.controlBus) return;
      await dependencies.controlBus
        .publishAck({
          threadId,
          runId,
          commandId,
          kind,
          disposition,
          timestamp: new Date(now()).toISOString(),
        })
        .catch(() => {});
    };

    const postCancelAckOnce = (): Promise<void> => {
      if (!cancelAckPromise) {
        cancelAckPromise = dependencies
          .postIngest(projectId, runId, {
            dispatchMessageId,
            attemptId,
            kind: 'cancel_ack',
            detail: 'Interactive turn stopped',
          })
          .then(
            () => undefined,
            () => undefined,
          );
      }
      return cancelAckPromise;
    };

    const applySdkSteer = async (text: string): Promise<void> => {
      if (agentHandle?.steer) {
        await agentHandle.steer(text);
      }
    };

    const flushHeldSummarySteers = async (): Promise<void> => {
      if (heldSummarySteers.length === 0) return;
      const toFlush = heldSummarySteers.splice(0, heldSummarySteers.length);
      if (cancellationRequested || fenceConflict) return;
      for (const item of toFlush) {
        try {
          await applySdkSteer(item.text);
          appliedControlDispositions.set(item.commandId, 'steered');
          await publishControlAck(item.commandId, 'steer', 'steered');
        } catch {
          // Best-effort flush; do not disrupt summary cleanup.
        }
      }
    };

    const flushQueuedRunningSteers = async (): Promise<void> => {
      if (queuedRunningSteers.length === 0) return;
      const toFlush = queuedRunningSteers.splice(0, queuedRunningSteers.length);
      if (cancellationRequested || fenceConflict) return;
      for (const item of toFlush) {
        try {
          await applySdkSteer(item.text);
        } catch {
          // Best-effort flush.
        }
      }
    };

    const handleSteer = async (
      commandId: string,
      text: string,
    ): Promise<HarnessSteerDisposition> => {
      const existing = appliedControlDispositions.get(commandId);
      if (existing && existing !== 'cancelled') {
        return existing;
      }
      if (turnEnded || cancellationRequested || fenceConflict) {
        await publishControlAck(commandId, 'steer', 'turn-ended');
        return 'turn-ended';
      }
      if (phase === 'summarizing') {
        heldSummarySteers.push({ commandId, text });
        appliedControlDispositions.set(commandId, 'held');
        await publishControlAck(commandId, 'steer', 'held');
        return 'held';
      }
      if (
        !sendIssued &&
        (phase === 'starting' || phase === 'resuming' || phase === 'recreating')
      ) {
        pendingPromptSteers.push({ commandId, text });
        appliedControlDispositions.set(commandId, 'merged');
        await publishControlAck(commandId, 'steer', 'merged');
        return 'merged';
      }
      if (phase === 'running' || sendIssued) {
        appliedControlDispositions.set(commandId, 'steered');
        if (activeRunRef && agentHandle?.steer) {
          await applySdkSteer(text);
        } else if (sendIssued && !activeRunRef) {
          queuedRunningSteers.push({ commandId, text });
        } else {
          await applySdkSteer(text);
        }
        await publishControlAck(commandId, 'steer', 'steered');
        return 'steered';
      }
      await publishControlAck(commandId, 'steer', 'turn-ended');
      return 'turn-ended';
    };

    const handleCancel = async (
      commandId: string,
    ): Promise<HarnessCancelDisposition> => {
      const existing = appliedControlDispositions.get(commandId);
      if (existing === 'cancelled') {
        return 'cancelled';
      }
      if (turnEnded) {
        await publishControlAck(commandId, 'cancel', 'turn-ended');
        return 'turn-ended';
      }
      appliedControlDispositions.set(commandId, 'cancelled');
      cancellationRequested = true;
      await stopRun();
      if (!absoluteAbort.signal.aborted) {
        absoluteAbort.abort(new InteractiveCancellationObservedError());
      }
      await postCancelAckOnce();
      await publishControlAck(commandId, 'cancel', 'cancelled');
      return 'cancelled';
    };

    const dispatchPendingControls = async (
      items: ReadonlyArray<HarnessPendingControl>,
    ): Promise<void> => {
      for (const item of items) {
        if (item.kind === 'steer' && typeof item.text === 'string') {
          await handleSteer(item.commandId, item.text);
        } else if (item.kind === 'cancel') {
          await handleCancel(item.commandId);
        }
      }
    };

    const dispatchControlMessage = async (
      message: HarnessControlMessage,
    ): Promise<void> => {
      if (message.runId !== runId) return;
      if (message.kind === 'steer') {
        await handleSteer(message.commandId, message.text);
      } else if (message.kind === 'cancel') {
        await handleCancel(message.commandId);
      }
    };

    activeTurns.set(threadId, {
      runId,
      handleSteer,
      handleCancel,
    });
    const unsubscribeControl = dependencies.controlBus
      ? dependencies.controlBus.subscribeControl(threadId, (message) => {
          void dispatchControlMessage(message);
        })
      : () => {};

    const clearEventTimers = (): void => {
      if (firstEventTimer !== undefined) {
        clearTimeout(firstEventTimer);
        firstEventTimer = undefined;
      }
      if (warmProbeTimer !== undefined) {
        clearTimeout(warmProbeTimer);
        warmProbeTimer = undefined;
      }
      if (silenceTimer !== undefined) {
        clearTimeout(silenceTimer);
        silenceTimer = undefined;
      }
    };

    // After the first event, the same budget bounds each gap between events.
    // A running tool has its own deadline, so silence during one is expected.
    const armSilenceTimer = (): void => {
      if (silenceTimer !== undefined) clearTimeout(silenceTimer);
      silenceTimer = undefined;
      const silenceMs = effectiveDeadlines.firstEventMs;
      if (!(silenceMs > 0) || silenceMs >= absoluteMs - now()) return;
      silenceTimer = setTimeout(() => {
        silenceTimer = undefined;
        if (toolTimer !== undefined) {
          armSilenceTimer();
          return;
        }
        failureCategory = 'hard_timeout';
        silenceTimedOut = true;
        logInteractiveAgentStep('InteractiveTurnWentSilent', {
          runId,
          threadId,
          silentMs: silenceMs,
        });
        absoluteAbort.abort(
          Object.assign(new Error('hard_timeout'), { code: 'hard_timeout' }),
        );
        void stopRun();
      }, silenceMs);
    };

    const observeEvent = (): void => {
      if (!firstEventSeen) {
        firstEventSeen = true;
        firstEventAt = now();
        if (firstEventTimer !== undefined) clearTimeout(firstEventTimer);
        firstEventTimer = undefined;
        if (warmProbeTimer !== undefined) clearTimeout(warmProbeTimer);
        warmProbeTimer = undefined;
      }
      armSilenceTimer();
    };
    absoluteAbort.signal.addEventListener(
      'abort',
      () => {
        void stopRun();
      },
      { once: true },
    );

    const clearToolTimer = (): void => {
      if (toolTimer !== undefined) {
        clearTimeout(toolTimer);
        toolTimer = undefined;
      }
    };

    const armToolTimer = (toolName?: string): void => {
      clearToolTimer();
      const remainingMs = absoluteMs - now();
      // toolCallMs bounds a stalled MCP call. A shell is the step itself, so
      // it keeps the rest of the turn instead of the MCP stall limit.
      const configuredMs =
        toolName?.toLowerCase() === 'shell' ? remainingMs : effectiveDeadlines.toolCallMs;
      const toolMs = Math.min(configuredMs, remainingMs);
      if (!(toolMs > 0)) {
        failureCategory = 'tool_timeout';
        throw Object.assign(new Error('tool_timeout'), { code: 'tool_timeout' });
      }
      toolTimer = setTimeout(() => {
        failureCategory = 'tool_timeout';
        absoluteAbort.abort(
          Object.assign(new Error('tool_timeout'), { code: 'tool_timeout' }),
        );
        void stopRun();
      }, toolMs);
    };

    const post = async (body: AiRunIngestBody): Promise<void> => {
      if (fenceConflict) return;
      try {
        const response = await dependencies.postIngest(projectId, runId, {
          ...body,
          attemptId,
          dispatchMessageId,
        });
        if (response.pendingControl && response.pendingControl.length > 0) {
          await dispatchPendingControls(response.pendingControl);
        }
        if (response.cancelRequested && body.kind !== 'cancel_ack') {
          cancellationRequested = true;
          await stopRun();
          if (!absoluteAbort.signal.aborted) {
            absoluteAbort.abort(new InteractiveCancellationObservedError());
          }
        }
      } catch (error) {
        if (error instanceof AiRunFenceConflictError) {
          fenceConflict = true;
          await stopRun();
          return;
        }
        throw error;
      }
    };

    const heartbeatStats = { lastAcceptedAt: now(), maxGapMs: 0, sent: 0, failed: 0 };
    const recordHeartbeatGap = (at: number): void => {
      heartbeatStats.maxGapMs = Math.max(heartbeatStats.maxGapMs, at - heartbeatStats.lastAcceptedAt);
    };
    const heartbeat = (): void => {
      heartbeatStats.sent += 1;
      void post({ kind: 'heartbeat', dispatchMessageId, attemptId }).then(
        () => {
          const at = now();
          recordHeartbeatGap(at);
          heartbeatStats.lastAcceptedAt = at;
        },
        () => {
          heartbeatStats.failed += 1;
        },
      );
    };
    heartbeat();
    const heartbeatTimer = setInterval(heartbeat, durableHeartbeatMs);
    activeDurableThreads.add(threadId);

    let startupSequence = 0;
    const publishStartupPhase = async (
      phase: 'setup' | 'analysis',
      detail: string,
    ): Promise<void> => {
      const event: SseEvent = {
        type: 'phase',
        phase,
        status: 'running',
        detail,
      };
      const eventId = randomUUID();
      await publishLive(threadId, createCursorRunEventEnvelope({
        eventId,
        threadId,
        runId,
        sourceInstance,
        sequence: (startupSequence += 1),
        timestamp: new Date(now()).toISOString(),
        event,
      })).catch(() => {});
      await post({
        dispatchMessageId,
        attemptId,
        kind: 'progress',
        phase,
        status: 'running',
        detail,
        eventId,
        event,
      }).catch(() => {});
    };

    try {
      await publishStartupPhase(
        'setup',
        specification.grounding?.sha && specification.workflowClass !== 'brainstorm'
          ? INTERACTIVE_LOADING_CODE_DETAIL
          : INTERACTIVE_STARTING_DETAIL,
      );

      const destination = resolveInteractiveThreadWorkspacePath(
        threadId,
        specification.grounding?.sha ?? null,
      );

      if (!dependencies.materializeWorkspace) {
        throw new Error(
          'Durable interactive turns require materializeWorkspace',
        );
      }

      const prepMs = effectiveDeadlines.repositoryPreparationMs;
      const prepAbort = new AbortController();
      const onAbsoluteAbort = () =>
        prepAbort.abort(absoluteAbort.signal.reason);
      absoluteAbort.signal.addEventListener('abort', onAbsoluteAbort, {
        once: true,
      });
      let prepTimer: ReturnType<typeof setTimeout> | undefined;
      if (prepMs != null) {
        prepTimer = setTimeout(
          () => prepAbort.abort(new Error('repository_preparation_timeout')),
          prepMs,
        );
      }
      await evictIdleDurableAgents(now() - agentCacheIdleMs);
      // A worktree from an earlier commit still counts against the disk budget.
      const cachedForThread = agentCache.get(threadId);
      if (
        cachedForThread &&
        (cachedForThread.handle.workspaceRef !== destination ||
          (cachedForThread.groundingSha ?? null) !==
            (specification.grounding?.sha ?? null))
      ) {
        await disposeAgentEntry(threadId);
      }
      const workspaceStartedAt = now();
      try {
        attemptCheckout = await dependencies.materializeWorkspace(
          bootstrap,
          destination,
          prepAbort.signal,
          {
            reclaimDisk: () =>
              evictIdleDurableAgents(Number.POSITIVE_INFINITY),
          },
        );
      } finally {
        if (prepTimer) clearTimeout(prepTimer);
        absoluteAbort.signal.removeEventListener('abort', onAbsoluteAbort);
      }
      workspaceMs = now() - workspaceStartedAt;
      // A repository-preparation timeout falls back to the remote reader; an
      // expired absolute deadline ends the turn.
      if (absoluteAbort.signal.aborted) throw absoluteAbort.signal.reason;

      const checkout = attemptCheckout;

      const firstEventMs = Math.min(
        effectiveDeadlines.firstEventMs,
        absoluteMs - now(),
      );
      if (!(firstEventMs > 0)) {
        throw Object.assign(new Error('hard_timeout'), { code: 'hard_timeout' });
      }

      const armHardFirstEventTimer = (): void => {
        if (firstEventTimer !== undefined) {
          clearTimeout(firstEventTimer);
          firstEventTimer = undefined;
        }
        if (firstEventSeen) return;
        const budgetMs = Math.min(
          effectiveDeadlines.firstEventMs,
          absoluteMs - now(),
        );
        if (!(budgetMs > 0)) {
          failureCategory = 'hard_timeout';
          firstEventTimedOut = true;
          absoluteAbort.abort(
            Object.assign(new Error('hard_timeout'), { code: 'hard_timeout' }),
          );
          void stopRun();
          return;
        }
        firstEventTimer = setTimeout(() => {
          if (!firstEventSeen) {
            failureCategory = 'hard_timeout';
            firstEventTimedOut = true;
            absoluteAbort.abort(
              Object.assign(new Error('hard_timeout'), { code: 'hard_timeout' }),
            );
            void stopRun();
          }
        }, budgetMs);
      };

      // The first-event budget covers starting or resuming the Agent as well as
      // its first reply.
      armHardFirstEventTimer();

      const cached = agentCache.get(threadId);
      const currentSourcesSignature = brainstormSourceIdsSignature(bootstrap);
      const cacheCompatible =
        cached &&
        cached.handle.model === specification.model &&
        cached.handle.workspaceRef === checkout.workspacePath &&
        (cached.groundingSha ?? null) === (specification.grounding?.sha ?? null) &&
        (cached.handle.interviewPhase ?? null) ===
          (specification.guidedInterview?.phase ?? null) &&
        (cached.brainstormSourcesSignature ?? '') === currentSourcesSignature;

      const wasIdleEvicted = evictedThreads.delete(threadId);
      const previousWorkspacePath = lastWorkspacePathByThread.get(threadId);
      const workspaceChanged = Boolean(
        previousWorkspacePath && previousWorkspacePath !== checkout.workspacePath,
      );
      const currentRevision = resolveHostRevision();
      const previousRevision = lastHostRevisionByThread.get(threadId);
      const hostRevisionChanged = Boolean(
        previousRevision &&
          currentRevision &&
          previousRevision !== currentRevision,
      );

      const startAcquisition = (
        resumeAgentId: string | null,
      ): Promise<{
        handle: InteractiveCursorAgentHandle;
        mode: 'warm' | 'resumed' | 'recreated';
      }> =>
        dependencies.acquireDurableAgent
          ? dependencies.acquireDurableAgent(bootstrap, checkout, {
              resumeAgentId,
            })
          : dependencies
              .acquireAgent(
                {
                  prompt: specification.currentPrompt,
                  model: specification.model,
                  effort: specification.effort ?? undefined,
                  workspaceRef: checkout.workspacePath,
                  workflowClass: 'agent_home_chat',
                  skillPath: specification.skill?.path ?? '',
                  projectId: specification.projectId,
                  threadId: specification.threadId,
                },
                checkout,
                { resumeAgentId, mcpServers },
              )
              .then((handle) => ({
                handle,
                mode: resumeAgentId ? 'resumed' as const : 'recreated' as const,
              }));

      let acquisitionMode: 'warm' | 'resumed' | 'recreated' = 'warm';
      if (cacheCompatible && cached) {
        agentHandle = cached.handle;
        acquisitionMode = 'warm';
        agentAcquireMs = 0;
      } else {
        // When only the attached Brainstorm sources changed on the same workspace,
        // dispose the warm handle without deleting the thread workspace we just
        // materialized so `Agent.resume` rebinds customTools to the updated checkout.
        if (cached) {
          agentCache.delete(threadId);
          await disposeAgentHandle(threadId, cached.handle);
          if (cached.handle.workspaceRef !== checkout.workspacePath) {
            await cached.releaseWorkspace?.().catch(() => {});
          }
        }
        if (specification.grounding?.sha && specification.workflowClass !== 'brainstorm') {
          await publishStartupPhase('setup', INTERACTIVE_STARTING_DETAIL);
        }
        const knownAgentId =
          cursorAgentId ?? agentIdByThread.get(threadId) ?? null;
        const resumeAgentId =
          knownAgentId && !unresumableAgentIds.has(knownAgentId)
            ? knownAgentId
            : null;
        phase = resumeAgentId ? 'resuming' : 'starting';
        if (resumeAgentId) {
          storeRestoreStatus = await agentStoreSync
            .restoreAgentStore(threadId, checkout.workspacePath)
            .catch(() => 'missing' as const);
        }
        const acquireStartedAt = now();
        const acquisition = startAcquisition(resumeAgentId);
        try {
          const acquired = await untilAborted(acquisition, absoluteAbort.signal);
          agentHandle = acquired.handle;
          acquisitionMode = acquired.mode;
          agentAcquireMs = now() - acquireStartedAt;
          if (acquisitionMode === 'recreated') {
            recreateReason = resolveRecreateReason({
              hadPriorBinding: Boolean(knownAgentId),
              wasIdleEvicted,
              workspaceChanged,
              hostRevisionChanged,
              storeRestoreStatus,
              resumeReturnedNotFound:
                Boolean(resumeAgentId) && storeRestoreStatus === 'restored',
            });
          }
          const durableArea = resolveChatAreaId(specification.workflowClass);
          logInteractiveAgentStep('InteractiveAgentAcquired', {
            runId,
            threadId,
            mode: acquired.mode,
            durationMs: now() - acquireStartedAt,
            ...(recreateReason ? { recreateReason } : {}),
            ...(durableArea ? { area: durableArea } : {}),
          });
        } catch (error) {
          if (isAdapterResumeStalledError(error)) {
            clearCursorAgentId = true;
            const stalledId = error.agentId || resumeAgentId;
            if (stalledId) {
              unresumableAgentIds.add(stalledId);
              agentIdByThread.delete(threadId);
            }
          }
          if (absoluteAbort.signal.aborted) {
            void acquisition
              .then((late) => disposeAgentHandle(threadId, late.handle))
              .catch(() => {});
            if (resumeAgentId) {
              unresumableAgentIds.add(resumeAgentId);
              agentIdByThread.delete(threadId);
            }
            logInteractiveAgentStep('InteractiveAgentAcquireTimedOut', {
              runId,
              threadId,
              resumed: resumeAgentId !== null,
              waitedMs: now() - acquireStartedAt,
            });
          }
          throw error;
        }
      }

      lastWorkspacePathByThread.set(threadId, checkout.workspacePath);
      lastHostRevisionByThread.set(threadId, currentRevision);

      if (agentHandle.agentId) {
        agentIdByThread.set(threadId, agentHandle.agentId);
      }
      agentMode = acquisitionMode;
      await publishStartupPhase('analysis', INTERACTIVE_THINKING_DETAIL);

      let prompt =
        acquisitionMode === 'recreated'
          ? specification.recreationPrompt
          : specification.currentPrompt;
      const mcpServerChat =
        specification.mcpServers.length === 1 &&
        specification.mcpServers[0]?.kind === 'internal-proxy' &&
        specification.mcpServers[0].serverName === 'mcp-server';
      const mcpToolRequired =
        mcpServerChat &&
        mcpServerTurnRequiresToolUse(specification.currentMessage.text);
      let mcpToolUsedThisAttempt = false;

      const liveBatcher = createIncrementalTokenBatcher({
        maxBytes: batchMaxBytes,
        now,
      });
      let liveSequence = 0;
      let liveStreamOffset = 0;
      let lastMatchingLive:
        | Readonly<{
            eventId: string;
            streamOffset: number;
            streamEndOffset: number;
            text: string;
          }>
        | null = null;

      const publishLiveEnvelope = async (
        event: SseEvent,
        eventId?: string,
      ): Promise<string> => {
        const envelope = createCursorRunEventEnvelope({
          eventId,
          threadId,
          runId,
          sourceInstance,
          sequence: (liveSequence += 1),
          timestamp: new Date(now()).toISOString(),
          event,
        });
        await publishLive(threadId, envelope).catch(() => {});
        return envelope.eventId;
      };

      // Explicit `operation: 'summarize'` turn (PBI-006 / VT-05).
      if (specification.harness?.operation === 'summarize') {
        if (pendingPromptSteers.length > 0) {
          heldSummarySteers.push(
            ...pendingPromptSteers.splice(0, pendingPromptSteers.length),
          );
        }
        phase = 'summarizing';
        sendStartedAt = now();
        type SummaryOutcome = {
          status: 'completed' | 'fallback' | 'error';
          text?: string;
        };
        const summaryState: { outcome: SummaryOutcome | null } = {
          outcome: null,
        };
        let summaryErrorPosted = false;

        try {
          await publishLiveEnvelope({ type: 'summary', status: 'running' });
          await post({
            dispatchMessageId,
            attemptId,
            kind: 'summary',
            status: 'running',
            commandId: specification.turnId,
          });

          if (typeof agentHandle.summarize !== 'function') {
            throw new Error('Agent handle does not support summarize');
          }

          const rawSummaryRun = await untilAborted(
            agentHandle.summarize(),
            absoluteAbort.signal,
          );
          if (
            rawSummaryRun &&
            typeof rawSummaryRun === 'object' &&
            typeof (rawSummaryRun as WorkerCursorExecutionRun).stream ===
              'function'
          ) {
            const summaryRun = rawSummaryRun as WorkerCursorExecutionRun;
            activeRunRef = summaryRun;
            const summaryResult = await untilAborted(
              executeCursorExecutionCore({
                snapshot: {
                  prompt: specification.currentPrompt,
                  model: specification.model,
                  effort: specification.effort ?? undefined,
                  workspaceRef: checkout.workspacePath,
                  workflowClass: 'agent_home_chat',
                  skillPath: specification.skill?.path ?? '',
                  projectId: specification.projectId,
                  threadId: specification.threadId,
                },
                run: summaryRun,
                context: { runId, sourceInstance },
                sink: {
                  publish: async (event: SseEvent) => {
                    if (fenceConflict) throw new AiRunFenceConflictError();
                    if (cancellationRequested) {
                      throw new InteractiveCancellationObservedError();
                    }
                    observeEvent();
                    if (event.type === 'summary') {
                      if (event.status === 'error') {
                        summaryState.outcome = { status: 'error' };
                      } else if (
                        event.status === 'completed' ||
                        event.status === 'fallback'
                      ) {
                        summaryState.outcome = {
                          status: event.status,
                          text: firstNonEmptySummaryText(
                            summaryState.outcome?.text,
                          ),
                        };
                      } else {
                        await publishLiveEnvelope(event);
                      }
                    } else {
                      await publishLiveEnvelope(event);
                    }
                  },
                },
                hooks: {
                  beforeStreamEvent: () => {
                    if (fenceConflict) throw new AiRunFenceConflictError();
                    if (cancellationRequested) {
                      throw new InteractiveCancellationObservedError();
                    }
                  },
                  onSummaryCompleted: ({ text, fallback }) => {
                    summaryState.outcome = {
                      status: fallback ? 'fallback' : 'completed',
                      text: firstNonEmptySummaryText(
                        text,
                        summaryState.outcome?.text,
                      ),
                    };
                  },
                },
                nextSequence: () => 1,
                failIfStreamEndsBeforeTurnEnd: false,
              }),
              absoluteAbort.signal,
            );
            const waitSummaryText = firstNonEmptySummaryText(
              summaryResult.waitResult.result,
              summaryResult.text,
            );
            const currentOutcome = summaryState.outcome;
            if (!currentOutcome) {
              if (isSuccessfulWait(summaryResult) && waitSummaryText) {
                summaryState.outcome = {
                  status: 'completed',
                  text: waitSummaryText,
                };
              } else {
                summaryState.outcome = { status: 'error' };
              }
            } else if (
              currentOutcome.status === 'completed' ||
              currentOutcome.status === 'fallback'
            ) {
              const mergedText = firstNonEmptySummaryText(
                currentOutcome.text,
                waitSummaryText,
              );
              summaryState.outcome =
                isSuccessfulWait(summaryResult) && mergedText
                  ? { status: currentOutcome.status, text: mergedText }
                  : { status: 'error' };
            }
          } else if (typeof rawSummaryRun === 'string') {
            const text = firstNonEmptySummaryText(rawSummaryRun);
            summaryState.outcome = text
              ? { status: 'completed', text }
              : { status: 'error' };
          } else if (rawSummaryRun && typeof rawSummaryRun === 'object') {
            const obj = rawSummaryRun as {
              status?: string;
              text?: string;
              summary?: string;
              fallback?: boolean;
            };
            const status =
              obj.status === 'error'
                ? 'error'
                : obj.fallback || obj.status === 'fallback'
                  ? 'fallback'
                  : 'completed';
            const text = firstNonEmptySummaryText(obj.summary, obj.text);
            summaryState.outcome =
              status === 'error' || !text
                ? { status: 'error' }
                : { status, text };
          } else {
            summaryState.outcome = { status: 'error' };
          }
        } catch (summaryErr) {
          if (
            fenceConflict ||
            summaryErr instanceof AiRunFenceConflictError ||
            cancellationRequested ||
            summaryErr instanceof InteractiveCancellationObservedError
          ) {
            throw summaryErr;
          }
          summaryState.outcome = { status: 'error' };
          summaryErrorPosted = true;
          await publishLiveEnvelope({ type: 'summary', status: 'error' });
          await post({
            dispatchMessageId,
            attemptId,
            kind: 'summary',
            status: 'error',
            commandId: specification.turnId,
          }).catch(() => {});
        } finally {
          phase = 'running';
          await flushHeldSummarySteers();
          clearEventTimers();
          clearToolTimer();
        }

        const resolvedSummary =
          summaryState.outcome &&
          (summaryState.outcome.status === 'completed' ||
            summaryState.outcome.status === 'fallback') &&
          !firstNonEmptySummaryText(summaryState.outcome.text)
            ? { status: 'error' as const }
            : (summaryState.outcome ?? { status: 'error' as const });
        if (resolvedSummary.status === 'error') {
          if (!summaryErrorPosted) {
            await publishLiveEnvelope({ type: 'summary', status: 'error' });
            await post({
              dispatchMessageId,
              attemptId,
              kind: 'summary',
              status: 'error',
              commandId: specification.turnId,
            }).catch(() => {});
          }
          await agentStoreSync
            .backupAgentStore(threadId, checkout.workspacePath)
            .catch(() => 0);
          await post({
            dispatchMessageId,
            attemptId,
            kind: 'terminal',
            status: 'failed',
            detail: 'Could not summarize this conversation',
            artifactsFlushed: false,
            ...(recreateReason ? { recreateReason } : {}),
            stageTimings: stageTimings(),
          }).catch(() => {});
          await publishLiveEnvelope({ type: 'done', runId });
          return { status: 'failed' };
        }

        await publishLiveEnvelope({
          type: 'summary',
          status: resolvedSummary.status,
        });
        await post({
          dispatchMessageId,
          attemptId,
          kind: 'summary',
          status: resolvedSummary.status,
          ...(resolvedSummary.text !== undefined
            ? { text: resolvedSummary.text }
            : {}),
          commandId: specification.turnId,
        });

        let summaryArtifacts: ReturnType<typeof unpackAttemptArtifactsResult> = {};
        if (dependencies.uploadAttemptArtifacts) {
          summaryArtifacts = unpackAttemptArtifactsResult(
            await dependencies.uploadAttemptArtifacts(
              bootstrap,
              checkout.workspacePath,
              absoluteAbort.signal,
            ),
          );
        }

        await agentStoreSync
          .backupAgentStore(threadId, checkout.workspacePath)
          .catch(() => 0);

        await post({
          dispatchMessageId,
          attemptId,
          kind: 'terminal',
          status: 'completed',
          artifactsFlushed: true,
          artifactManifestRef: summaryArtifacts.artifactManifestRef,
          ...(summaryArtifacts.inlineArtifacts
            ? { inlineArtifacts: summaryArtifacts.inlineArtifacts }
            : {}),
          cursorAgentId: agentHandle.agentId ?? null,
          ...(recreateReason ? { recreateReason } : {}),
          stageTimings: stageTimings(),
          durationMs: Math.max(0, now() - sendStartedAt),
        });
        await publishLiveEnvelope({ type: 'done', runId });

        agentCache.set(threadId, {
          handle: agentHandle,
          lastUsedAt: now(),
          brainstormSourcesSignature: currentSourcesSignature,
          groundingSha: specification.grounding?.sha ?? null,
          releaseWorkspace: checkout.dispose,
        });
        retainAgent = true;
        await evictOverflowAgents(threadId);
        return {
          status: 'completed',
          cursorAgentId: agentHandle.agentId ?? null,
        };
      }

      const durableBatcher = createInteractiveDurableStreamBatcher({
        persist: async ({ event, eventId }) => {
          const matchedLive =
            lastMatchingLive !== null &&
            lastMatchingLive.streamOffset === event.streamOffset &&
            lastMatchingLive.streamEndOffset === event.streamEndOffset &&
            lastMatchingLive.text === event.text
              ? lastMatchingLive
              : null;
          // Shared id when live Redis and durable Postgres share a chunk
          // boundary; otherwise the batcher's id is published to both.
          const sharedEventId = matchedLive ? matchedLive.eventId : eventId;
          if (matchedLive) {
            lastMatchingLive = null;
          }
          await post({
            dispatchMessageId,
            attemptId,
            kind: 'progress',
            phase: 'implementation',
            status: 'running',
            eventId: sharedEventId,
            event,
          });
          if (!matchedLive) {
            await publishLiveEnvelope(
              buildOffsetLiveTokenEvent(event),
              sharedEventId,
            );
          }
        },
      });

      const publishLiveTokenBatches = async (
        batches: string[],
      ): Promise<void> => {
        for (const text of batches) {
          if (!text) continue;
          const streamOffset = liveStreamOffset;
          const streamEndOffset = streamOffset + text.length;
          liveStreamOffset = streamEndOffset;
          const tokenEvent = buildOffsetLiveTokenEvent({
            text,
            streamOffset,
            streamEndOffset,
          });
          // Allocate before Redis publish so a matching durable persist can
          // reuse the same eventId in Postgres.
          const eventId = randomUUID();
          await publishLiveEnvelope(tokenEvent, eventId);
          lastMatchingLive = {
            eventId,
            streamOffset,
            streamEndOffset,
            text,
          };
          await durableBatcher.push(text);
        }
      };

      try {
        // Merge any steers that arrived during starting/resuming/recreating into the prompt.
        if (pendingPromptSteers.length > 0) {
          prompt = mergePendingSteersIntoPrompt(
            prompt,
            pendingPromptSteers.splice(0, pendingPromptSteers.length),
          );
        }
        sendIssued = true;
        phase = 'running';

        let turnEndMonitor = createCursorTurnEndMonitor();
        let latestAutoSummaryText: string | undefined;
        const sendTurn = async (
          handle: InteractiveCursorAgentHandle,
          signal: AbortSignal = absoluteAbort.signal,
        ): Promise<WorkerCursorExecutionRun> => {
          latestAutoSummaryText = undefined;
          const startedRun = await untilAborted(
            handle.send(prompt, {
              mcpServers,
              requestId: bootstrap.requestId ?? bootstrap.runId,
              onDelta: (update) => {
                observeEvent();
                const deltaSummary = extractDeltaSummaryText(update);
                if (deltaSummary) {
                  latestAutoSummaryText = deltaSummary;
                }
                turnEndMonitor.observe(update);
              },
            }),
            signal,
          );
          activeRunRef = startedRun;
          await flushQueuedRunningSteers();
          return startedRun;
        };

        const executeActiveRun = (
          signal: AbortSignal = absoluteAbort.signal,
        ) =>
          untilAborted(
            executeCursorExecutionCore({
              snapshot: {
                prompt,
                model: specification.model,
                effort: specification.effort ?? undefined,
                workspaceRef: checkout.workspacePath,
                workflowClass: 'agent_home_chat',
                skillPath: specification.skill?.path ?? '',
                projectId: specification.projectId,
                threadId: specification.threadId,
              },
              run: activeRunRef!,
              context: { runId, sourceInstance },
              sink: {
                publish: async (event: SseEvent, envelope: AgentRunEventEnvelope) => {
                  if (fenceConflict) throw new AiRunFenceConflictError();
                  if (cancellationRequested) {
                    throw new InteractiveCancellationObservedError();
                  }
                  if (signal.aborted) {
                    throw signal.reason instanceof Error
                      ? signal.reason
                      : Object.assign(new Error('hard_timeout'), {
                          code: 'hard_timeout',
                        });
                  }
                  if (absoluteAbort.signal.aborted) {
                    throw absoluteAbort.signal.reason instanceof Error
                      ? absoluteAbort.signal.reason
                      : Object.assign(new Error('hard_timeout'), {
                          code: 'hard_timeout',
                        });
                  }
                  // Synthetic Still working heartbeats ride the live bus only and
                  // never refresh silence/progress timers or bloat replay pages.
                  if (envelope.ephemeral) {
                    await publishLiveEnvelope(event);
                    return;
                  }
                  observeEvent();
                  if (event.type === 'tool_call') {
                    if (mcpServerChat) mcpToolUsedThisAttempt = true;
                    armToolTimer(event.toolName);
                  } else if (event.type === 'tool_status') {
                    if (mcpServerChat) mcpToolUsedThisAttempt = true;
                    if (event.status === 'running') {
                      armToolTimer(event.toolName);
                    } else {
                      clearToolTimer();
                    }
                  }
                  if (event.type === 'token') {
                    if (mcpToolRequired && !mcpToolUsedThisAttempt) return;
                    firstTokenAt ??= now();
                    await publishLiveTokenBatches(
                      liveBatcher.push(event.text, now()),
                    );
                  } else if (event.type === 'summary') {
                    await publishLiveEnvelope(event);
                    if (event.status === 'running') {
                      phase = 'summarizing';
                      await post({
                        dispatchMessageId,
                        attemptId,
                        kind: 'summary',
                        status: 'running',
                      });
                    } else if (event.status === 'error') {
                      await post({
                        dispatchMessageId,
                        attemptId,
                        kind: 'summary',
                        status: 'error',
                      });
                      phase = 'running';
                      await flushHeldSummarySteers();
                    }
                  } else {
                    const eventId = randomUUID();
                    await publishLiveEnvelope(event, eventId);
                    await post({
                      dispatchMessageId,
                      attemptId,
                      kind: 'progress',
                      phase: 'implementation',
                      status: 'running',
                      eventId,
                      event,
                    });
                  }
                },
              },
              hooks: {
                beforeStreamEvent: () => {
                  if (fenceConflict) throw new AiRunFenceConflictError();
                  if (cancellationRequested) {
                    throw new InteractiveCancellationObservedError();
                  }
                  if (signal.aborted) {
                    throw signal.reason instanceof Error
                      ? signal.reason
                      : new WarmAgentFirstEventStalledError();
                  }
                },
                onSummaryCompleted: async ({ text, fallback }) => {
                  const summaryText = firstNonEmptySummaryText(
                    text,
                    latestAutoSummaryText,
                  );
                  latestAutoSummaryText = undefined;
                  try {
                    // `@cursor/sdk` v1.4.0 emits auto-summary status events without
                    // exposing the summary text on `send()`. Skip persistence when
                    // text is absent rather than failing the live turn with 422.
                    if (summaryText) {
                      await post({
                        dispatchMessageId,
                        attemptId,
                        kind: 'summary',
                        status: fallback ? 'fallback' : 'completed',
                        text: summaryText,
                      });
                    }
                  } finally {
                    phase = 'running';
                    if (!fenceConflict && !cancellationRequested) {
                      await flushHeldSummarySteers();
                    }
                  }
                },
              },
              nextSequence: () => 1,
              turnEnd: turnEndMonitor.completion,
              failIfStreamEndsBeforeTurnEnd: true,
            }),
            signal,
          );

        const recreateAfterUnresponsiveAgent = async (
          dropped: InteractiveCursorAgentHandle,
          code: unknown,
          waitedMs?: number,
        ): Promise<void> => {
          if (warmProbeTimer !== undefined) {
            clearTimeout(warmProbeTimer);
            warmProbeTimer = undefined;
          }
          clearToolTimer();
          activeRunRef = undefined;
          logInteractiveAgentStep('InteractiveAgentReconnecting', {
            runId,
            threadId,
            mode: agentMode,
            code,
            ...(waitedMs !== undefined ? { waitedMs } : {}),
          });
          await publishLiveEnvelope({
            type: 'retrying',
            attempt: 1,
            maxAttempts: 1,
            reason: 'reconnecting',
          });
          if (dropped.agentId) {
            unresumableAgentIds.add(dropped.agentId);
            agentIdByThread.delete(threadId);
          }
          // This turn's workspace stays; only the Agent is replaced.
          if (agentCache.get(threadId)?.handle === dropped) {
            agentCache.delete(threadId);
          }
          await disposeAgentHandle(threadId, dropped);
          armHardFirstEventTimer();
          const reacquireStartedAt = now();
          phase = 'recreating';
          const reacquired = await untilAborted(
            startAcquisition(null),
            absoluteAbort.signal,
          );
          agentHandle = reacquired.handle;
          agentMode = 'recreated';
          recreateReason = recreateReason ?? 'unknown';
          phase = 'running';
          agentAcquireMs = now() - reacquireStartedAt;
          const durableArea = resolveChatAreaId(specification.workflowClass);
          logInteractiveAgentStep('InteractiveAgentAcquired', {
            runId,
            threadId,
            mode: 'recreated',
            durationMs: agentAcquireMs,
            ...(durableArea ? { area: durableArea } : {}),
          });
          prompt = specification.recreationPrompt;
          if (agentHandle.agentId) {
            agentIdByThread.set(threadId, agentHandle.agentId);
          }
          await publishStartupPhase('analysis', INTERACTIVE_THINKING_DETAIL);
          turnEndMonitor = createCursorTurnEndMonitor();
          sendStartedAt = now();
        };

        const probeMs = Math.min(
          warmFirstEventProbeMs,
          effectiveDeadlines.firstEventMs,
        );
        const canProbeWarmAgent =
          (agentMode === 'warm' || agentMode === 'resumed') &&
          probeMs > 0 &&
          absoluteMs - now() > probeMs;

        let result: CursorExecutionResult;
        if (canProbeWarmAgent) {
          // Pause the hard turn-ending timer during the probe; if the warm
          // agent produces an event, observeEvent() arms silenceTimer, and if
          // it stalls with zero events we recreate with a fresh hard budget.
          if (firstEventTimer !== undefined) {
            clearTimeout(firstEventTimer);
            firstEventTimer = undefined;
          }
          const probeAbort = new AbortController();
          const forwardAbsoluteAbort = () =>
            probeAbort.abort(absoluteAbort.signal.reason);
          if (absoluteAbort.signal.aborted) {
            probeAbort.abort(absoluteAbort.signal.reason);
          } else {
            absoluteAbort.signal.addEventListener('abort', forwardAbsoluteAbort, {
              once: true,
            });
          }
          warmProbeTimer = setTimeout(() => {
            warmProbeTimer = undefined;
            if (
              firstEventSeen ||
              cancellationRequested ||
              fenceConflict ||
              absoluteAbort.signal.aborted
            ) {
              return;
            }
            probeAbort.abort(new WarmAgentFirstEventStalledError());
            void stopRun();
          }, probeMs);

          sendStartedAt = now();
          try {
            activeRunRef = await sendTurn(agentHandle, probeAbort.signal);
            result = await executeActiveRun(probeAbort.signal);
          } catch (error) {
            const warmProbeStalled =
              error instanceof WarmAgentFirstEventStalledError ||
              (probeAbort.signal.aborted &&
                probeAbort.signal.reason instanceof WarmAgentFirstEventStalledError);
            const retryableSendDrop =
              !warmProbeStalled && isRetryableCursorConnectionError(error);
            if (
              (!warmProbeStalled && !retryableSendDrop) ||
              firstEventSeen ||
              absoluteAbort.signal.aborted ||
              cancellationRequested ||
              fenceConflict
            ) {
              throw error;
            }
            await recreateAfterUnresponsiveAgent(
              agentHandle,
              warmProbeStalled
                ? 'warm_first_event_timeout'
                : ((error as { code?: unknown }).code ?? null),
              warmProbeStalled ? probeMs : undefined,
            );
            activeRunRef = await sendTurn(agentHandle, absoluteAbort.signal);
            result = await executeActiveRun(absoluteAbort.signal);
          } finally {
            if (warmProbeTimer !== undefined) {
              clearTimeout(warmProbeTimer);
              warmProbeTimer = undefined;
            }
            absoluteAbort.signal.removeEventListener(
              'abort',
              forwardAbsoluteAbort,
            );
          }
        } else {
          sendStartedAt = now();
          try {
            activeRunRef = await sendTurn(agentHandle);
          } catch (error) {
            // No run exists yet, so nothing was shown and no tool ran.
            if (
              !isRetryableCursorConnectionError(error) ||
              firstEventSeen ||
              absoluteAbort.signal.aborted ||
              cancellationRequested ||
              fenceConflict
            ) {
              throw error;
            }
            await recreateAfterUnresponsiveAgent(
              agentHandle,
              (error as { code?: unknown }).code ?? null,
            );
            activeRunRef = await sendTurn(agentHandle);
          }
          result = await executeActiveRun();
        }

        if (mcpToolRequired && !mcpToolUsedThisAttempt) {
          await publishLiveEnvelope({
            type: 'retrying',
            attempt: 1,
            maxAttempts: 2,
          });
          prompt = mcpServerToolRetryPrompt(
            'MCP server',
            specification.currentMessage.text,
          );
          mcpToolUsedThisAttempt = false;
          turnEndMonitor = createCursorTurnEndMonitor();
          activeRunRef = await sendTurn(agentHandle);
          result = await executeActiveRun();
        }
        clearEventTimers();

        const liveTail = liveBatcher.flush();
        if (liveTail) {
          await publishLiveTokenBatches([liveTail]);
        }
        await durableBatcher.flush();

        clearToolTimer();

        if (failureCategory || absoluteAbort.signal.aborted) {
          const reason =
            failureCategory ||
            (absoluteAbort.signal.reason &&
            typeof absoluteAbort.signal.reason === 'object' &&
            'code' in absoluteAbort.signal.reason &&
            ((absoluteAbort.signal.reason as { code?: string }).code ===
              'hard_timeout' ||
              (absoluteAbort.signal.reason as { code?: string }).code ===
                'tool_timeout')
              ? (absoluteAbort.signal.reason as {
                  code: 'hard_timeout' | 'tool_timeout';
                }).code
              : null);
          if (reason) {
            throw Object.assign(new Error(reason), { code: reason });
          }
          throw absoluteAbort.signal.reason instanceof Error
            ? absoluteAbort.signal.reason
            : Object.assign(new Error('hard_timeout'), { code: 'hard_timeout' });
        }

        if (cancellationRequested) {
          throw new InteractiveCancellationObservedError();
        }
        if (!isSuccessfulWait(result)) {
          throw new Error(unsuccessfulWaitDetail(result));
        }

        const finalText =
          mcpToolRequired && !mcpToolUsedThisAttempt
            ? mcpServerNoToolFallback('the connected MCP server')
            : result.text;
        const finalMessage: ChatMessage | null =
          finalText && finalText.trim().length > 0
            ? {
                id: randomUUID(),
                role: 'agent',
                text: specification.guidedInterview
                  ? normalizeGuidedInterviewResponse(
                      finalText,
                      specification.guidedInterview.turn,
                    )
                  : finalText,
                ts: new Date(now()).toISOString(),
              }
            : null;
        if (finalMessage) {
          const messageEventId = randomUUID();
          await publishLiveEnvelope(
            { type: 'message', message: finalMessage },
            messageEventId,
          );
          await post({
            dispatchMessageId,
            attemptId,
            kind: 'progress',
            eventId: messageEventId,
            event: { type: 'message', message: finalMessage },
          });
        }

        let uploadedArtifacts: ReturnType<typeof unpackAttemptArtifactsResult> = {};
        let artifactsFlushed = false;
        if (dependencies.uploadAttemptArtifacts) {
          uploadedArtifacts = unpackAttemptArtifactsResult(
            await dependencies.uploadAttemptArtifacts(
              bootstrap,
              checkout.workspacePath,
              absoluteAbort.signal,
            ),
          );
          artifactsFlushed = true;
        }

        if (!artifactsFlushed) {
          throw new Error(
            'Durable interactive completed terminal requires artifact collect/upload',
          );
        }

        // A run that may still be live must not be warmed or resumed next turn.
        const reusableAgentId = result.runLeftUnsettled
          ? null
          : agentHandle.agentId ?? null;
        if (result.runLeftUnsettled) {
          if (agentHandle.agentId) {
            unresumableAgentIds.add(agentHandle.agentId);
            agentIdByThread.delete(threadId);
          }
          logInteractiveAgentStep('InteractiveRunLeftUnsettled', {
            runId,
            threadId,
          });
        }

        if (!result.runLeftUnsettled) {
          await agentStoreSync
            .backupAgentStore(threadId, checkout.workspacePath)
            .catch(() => 0);
        }

        await post({
          dispatchMessageId,
          attemptId,
          kind: 'terminal',
          status: 'completed',
          artifactsFlushed: true,
          artifactManifestRef: uploadedArtifacts.artifactManifestRef,
          ...(uploadedArtifacts.inlineArtifacts
            ? { inlineArtifacts: uploadedArtifacts.inlineArtifacts }
            : {}),
          cursorAgentId: reusableAgentId,
          ...(recreateReason ? { recreateReason } : {}),
          ...(finalMessage
            ? { event: { type: 'message', message: finalMessage } }
            : {}),
          stageTimings: stageTimings(),
          ...(sendStartedAt !== undefined
            ? { durationMs: Math.max(0, now() - sendStartedAt) }
            : {}),
          ...tokenFieldsForTerminalIngest(result.usage),
        });
        await publishLiveEnvelope({ type: 'done', runId });

        if (result.runLeftUnsettled) {
          if (agentCache.get(threadId)?.handle === agentHandle) {
            await disposeAgentEntry(threadId);
          }
          return { status: 'completed', cursorAgentId: null };
        }

        agentCache.set(threadId, {
          handle: agentHandle,
          lastUsedAt: now(),
          brainstormSourcesSignature: currentSourcesSignature,
          groundingSha: specification.grounding?.sha ?? null,
          releaseWorkspace: checkout.dispose,
        });
        retainAgent = true;
        await evictOverflowAgents(threadId);
        return {
          status: 'completed',
          cursorAgentId: agentHandle.agentId ?? null,
        };
      } finally {
        if (heldSummarySteers.length > 0 && !cancellationRequested && !fenceConflict) {
          await flushHeldSummarySteers();
        }
        clearEventTimers();
        clearToolTimer();
      }
    } catch (error) {
      if (fenceConflict || error instanceof AiRunFenceConflictError) {
        await disposeAgentEntry(threadId);
        return { status: 'fence-conflict' };
      }
      if (
        cancellationRequested ||
        error instanceof InteractiveCancellationObservedError ||
        isStopRaceIngestError(error)
      ) {
        await disposeAgentEntry(threadId);
        await postCancelAckOnce();
        await publishLive(
          threadId,
          createCursorRunEventEnvelope({
            threadId,
            runId,
            sourceInstance,
            sequence: (startupSequence += 1),
            timestamp: new Date(now()).toISOString(),
            event: { type: 'done', runId },
          }),
        ).catch(() => {});
        return { status: 'cancelled' };
      }

      if (isAdapterResumeStalledError(error)) {
        clearCursorAgentId = true;
        if (error.agentId) {
          unresumableAgentIds.add(error.agentId);
          agentIdByThread.delete(threadId);
        }
      }

      await disposeAgentEntry(threadId);
      const streamClosedEarly =
        error instanceof CursorExecutionWaitError &&
        error.cause instanceof CursorStreamClosedBeforeTurnEndError;
      if (streamClosedEarly) {
        logInteractiveAgentStep('InteractiveStreamClosedBeforeTurnEnd', {
          runId,
          threadId,
        });
      }
      const code =
        failureCategory ||
        (error &&
        typeof error === 'object' &&
        'code' in error &&
        ((error as { code?: string }).code === 'hard_timeout' ||
          (error as { code?: string }).code === 'tool_timeout')
          ? ((error as { code: 'hard_timeout' | 'tool_timeout' }).code)
          : null);
      // The run may still be live on Cursor's side, so the next turn
      // recreates the Agent instead of resuming into the same stuck run.
      if ((code === 'hard_timeout' || streamClosedEarly) && agentHandle?.agentId) {
        unresumableAgentIds.add(agentHandle.agentId);
        agentIdByThread.delete(threadId);
      }
      const detail =
        code === 'tool_timeout'
          ? 'Interactive tool deadline exceeded'
          : code === 'hard_timeout'
            ? firstEventTimedOut
              ? 'Interactive first event deadline exceeded'
              : silenceTimedOut
                ? 'Interactive turn went silent'
                : 'Interactive absolute deadline exceeded'
            : streamClosedEarly
              ? 'Interactive turn failed: Cursor stream closed before the turn finished'
              : describeInteractiveFailure(error).reason;
      await post({
        dispatchMessageId,
        attemptId,
        kind: 'terminal',
        status: 'failed',
        detail,
        artifactsFlushed: false,
        ...(code ? { failureCategory: code } : {}),
        ...(clearCursorAgentId ? { clearCursorAgentId: true } : {}),
        ...(recreateReason ? { recreateReason } : {}),
        stageTimings: stageTimings(),
      }).catch(() => {});
      if (code) {
        return { status: 'failed', failureCategory: code };
      }
      console.error(
        JSON.stringify({
          event: 'InteractiveDurableTurnFailed',
          runId,
          attemptId,
          reason: detail,
        }),
      );
      return { status: 'failed' };
    } finally {
      turnEnded = true;
      unsubscribeControl();
      if (activeTurns.get(threadId)?.runId === runId) {
        activeTurns.delete(threadId);
      }
      activeDurableThreads.delete(threadId);
      clearInterval(heartbeatTimer);
      recordHeartbeatGap(now());
      try {
        telemetry.interactiveHeartbeats(
          { runId, dispatchMessageId, project: projectId, lane: INTERACTIVE_LANE },
          {
            maxGapMs: heartbeatStats.maxGapMs,
            sent: heartbeatStats.sent,
            failed: heartbeatStats.failed,
          },
        );
      } catch {
        // Telemetry must not change the turn outcome.
      }
      clearTimeout(absoluteTimer);
      clearToolTimer();
      clearEventTimers();
      if (!retainAgent && attemptCheckout?.dispose) {
        await attemptCheckout.dispose().catch(() => {});
      }
      if (!retainAgent && agentHandle && !agentCache.has(threadId)) {
        await disposeAgentHandle(threadId, agentHandle);
      }
    }
  }
}
