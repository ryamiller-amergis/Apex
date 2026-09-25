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
} from '../../../shared/types/aiRunIngest';
import type { AiRunBlobRef } from '../../../shared/types/aiRunV2';
import type {
  AgentRunEventEnvelope,
  ChatMessage,
  SseEvent,
} from '../../../shared/types/chat';
import { INTERACTIVE_LANE } from '../../../shared/types/interactiveWorkflow';
import type { InteractiveStageName } from '../../../shared/types/workerTierOperations';
import {
  createCursorTurnEndMonitor,
  createCursorRunEventEnvelope,
  executeCursorExecutionCore,
  type CursorExecutionResult,
} from '../cursorExecutionCore';
import type { WorkerCursorExecutionRun } from '../aiRunsWorker/cursorExecution';
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
import type { InteractiveCursorAgentHandle } from './interactiveCursorExecution';
import type { InteractiveActorBootstrap } from '../../../shared/types/aiRunIngest';
import { createPerThreadTurnQueue, type PerThreadTurnQueue } from './perThreadTurnQueue';

/** Default cadence for durable progress heartbeats (clocks + cancel signal). */
const DEFAULT_HEARTBEAT_MS = 4_000;

/** Idle TTL for the live per-thread Agent cache. */
export const INTERACTIVE_AGENT_CACHE_IDLE_MS = 10 * 60_000;

/** Hard cap on live Agent handles retained in this process. */
export const INTERACTIVE_AGENT_CACHE_MAX = 32;

/** Home-facing live phase detail before checkout / SDK work. */
export const INTERACTIVE_STARTING_DETAIL = 'Starting agent…';

/**
 * Attempt-local workspace root. Hosts may override with
 * `AI_RUNS_INTERACTIVE_ATTEMPT_ROOT`; otherwise `os.tmpdir()`.
 */
export function resolveInteractiveAttemptWorkspacePath(
  attemptId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.AI_RUNS_INTERACTIVE_ATTEMPT_ROOT?.trim();
  const root = configured && configured.length > 0 ? configured : os.tmpdir();
  return path.join(root, 'apex-interactive-attempt', attemptId);
}

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
  const redactedMessage = redactFailureMessage(
    typeof err?.message === 'string' ? err.message : '',
  );
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
  /** Materialize a pinned attempt-local workspace for durable turns. */
  materializeWorkspace?(
    bootstrap: InteractiveActorBootstrap,
    destination: string,
    signal: AbortSignal,
  ): Promise<WarmThreadCheckout>;
  /**
   * Collect attempt-local outputs, upload attempt-scoped blobs, write the
   * manifest last, and return its blob ref. Required for durable completed
   * terminals that claim `artifactsFlushed: true`.
   */
  uploadAttemptArtifacts?(
    bootstrap: InteractiveActorBootstrap,
    workspacePath: string,
    signal: AbortSignal,
  ): Promise<AiRunBlobRef>;
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
  now?: () => number;
  /** Idle TTL for cached Agents (default 10 minutes). */
  agentCacheIdleMs?: number;
  /** Max cached Agents in this process (default 32). */
  agentCacheMax?: number;
}

export interface InteractiveSessionActor {
  handleTurn(request: InteractiveTurnRequest): Promise<InteractiveTurnOutcome>;
  handleDurableTurn(request: {
    threadId: string;
    bootstrap: InteractiveActorBootstrap;
  }): Promise<InteractiveTurnOutcome>;
  /** Dispose every warm checkout + cached Agent (process shutdown / deactivation). */
  disposeAll(): Promise<void>;
}

interface CachedAgentEntry {
  handle: InteractiveCursorAgentHandle;
  lastUsedAt: number;
}

function isSuccessfulWait(result: CursorExecutionResult): boolean {
  if (result.completedOnTurnEnd) return true;
  return (
    result.waitResult.status === 'finished' ||
    result.waitResult.status === 'completed' ||
    result.waitResult.status === 'success'
  );
}

export function createInteractiveSessionActor(
  dependencies: InteractiveActorDependencies,
): InteractiveSessionActor {
  const turnQueue = dependencies.turnQueue ?? createPerThreadTurnQueue();
  const telemetry = dependencies.telemetry ?? workerTierTelemetry;
  const batchMaxBytes =
    dependencies.batchMaxBytes ?? INTERACTIVE_TOKEN_BATCH_MAX_BYTES;
  const sourceInstance =
    dependencies.sourceInstance ?? 'ai-runs-interactive-actor';
  const heartbeatMs = dependencies.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const publishLive: LiveEnvelopePublisher =
    dependencies.publishLive ?? (async () => {});
  const now = dependencies.now ?? Date.now;
  const agentCacheIdleMs =
    dependencies.agentCacheIdleMs ?? INTERACTIVE_AGENT_CACHE_IDLE_MS;
  const agentCacheMax =
    dependencies.agentCacheMax ?? INTERACTIVE_AGENT_CACHE_MAX;

  // Warm session cache keyed by threadId — single activation reuses the
  // grounded checkout and live Cursor Agent across turns.
  const warmCheckouts = new Map<string, WarmThreadCheckout>();
  const agentCache = new Map<string, CachedAgentEntry>();
  const agentIdByThread = new Map<string, string | null>();

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

  const disposeAgentEntry = async (threadId: string): Promise<void> => {
    const entry = agentCache.get(threadId);
    if (!entry) return;
    agentCache.delete(threadId);
    await entry.handle.dispose().catch(() => {});
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
        if (entry.lastUsedAt < oldestAt) {
          oldestAt = entry.lastUsedAt;
          oldestThreadId = threadId;
        }
      }
      if (!oldestThreadId) break;
      await disposeAgentEntry(oldestThreadId);
    }
  };

  const runTurn = async (
    request: InteractiveTurnRequest,
  ): Promise<InteractiveTurnOutcome> => {
    const { runId, threadId, projectId, dispatchMessageId, snapshot } = request;
    const telemetryContext = {
      runId,
      dispatchMessageId,
      project: projectId,
      lane: INTERACTIVE_LANE,
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
        throw new Error('Interactive turn did not finish successfully');
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
      return turnQueue.submit(request.threadId, () =>
        runDurableTurn(request.threadId, request.bootstrap),
      );
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
    if (
      !Number.isFinite(absoluteMs) ||
      absoluteMs <= nowMs ||
      !Number.isFinite(effectiveDeadlines.firstEventMs) ||
      effectiveDeadlines.firstEventMs <= 0 ||
      !Number.isFinite(effectiveDeadlines.toolCallMs) ||
      effectiveDeadlines.toolCallMs <= 0 ||
      (effectiveDeadlines.repositoryPreparationMs !== null &&
        (!(effectiveDeadlines.repositoryPreparationMs > 0)))
    ) {
      throw new Error('Interactive effective deadlines are missing or expired');
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

    const stopRun = async (): Promise<void> => {
      if (activeRunRef?.cancel) await activeRunRef.cancel().catch(() => {});
    };

    const clearToolTimer = (): void => {
      if (toolTimer !== undefined) {
        clearTimeout(toolTimer);
        toolTimer = undefined;
      }
    };

    const armToolTimer = (): void => {
      clearToolTimer();
      const toolMs = Math.min(
        effectiveDeadlines.toolCallMs,
        absoluteMs - now(),
      );
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
        if (response.cancelRequested && body.kind !== 'cancel_ack') {
          cancellationRequested = true;
          await stopRun();
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

    try {
      await publishLive(threadId, createCursorRunEventEnvelope({
        threadId,
        runId,
        sourceInstance,
        sequence: 1,
        timestamp: new Date(now()).toISOString(),
        event: {
          type: 'phase',
          phase: 'setup',
          status: 'running',
          detail: INTERACTIVE_STARTING_DETAIL,
        },
      })).catch(() => {});

      // Durable turns always rematerialize a fresh attempt-local directory.
      // Never reuse a warm checkout from a prior durable attempt.
      const destination = resolveInteractiveAttemptWorkspacePath(attemptId);

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
      try {
        attemptCheckout = await dependencies.materializeWorkspace(
          bootstrap,
          destination,
          prepAbort.signal,
        );
      } finally {
        if (prepTimer) clearTimeout(prepTimer);
        absoluteAbort.signal.removeEventListener('abort', onAbsoluteAbort);
      }

      const checkout = attemptCheckout;

      const cached = agentCache.get(threadId);
      const cacheCompatible =
        cached &&
        cached.handle.model === specification.model &&
        cached.handle.workspaceRef === checkout.workspacePath;

      let acquisitionMode: 'warm' | 'resumed' | 'recreated' = 'warm';
      if (cacheCompatible && cached) {
        agentHandle = cached.handle;
        acquisitionMode = 'warm';
      } else {
        if (cached) await disposeAgentEntry(threadId);
        const resumeAgentId =
          cursorAgentId ?? agentIdByThread.get(threadId) ?? null;
        if (dependencies.acquireDurableAgent) {
          const acquired = await dependencies.acquireDurableAgent(
            bootstrap,
            checkout,
            { resumeAgentId },
          );
          agentHandle = acquired.handle;
          acquisitionMode = acquired.mode;
        } else {
          agentHandle = await dependencies.acquireAgent(
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
          );
          acquisitionMode = resumeAgentId ? 'resumed' : 'recreated';
        }
      }

      if (agentHandle.agentId) {
        agentIdByThread.set(threadId, agentHandle.agentId);
      }

      const prompt =
        acquisitionMode === 'recreated'
          ? specification.recreationPrompt
          : specification.currentPrompt;

      const firstEventMs = Math.min(
        effectiveDeadlines.firstEventMs,
        absoluteMs - now(),
      );
      if (!(firstEventMs > 0)) {
        throw Object.assign(new Error('hard_timeout'), { code: 'hard_timeout' });
      }

      let firstEventSeen = false;
      const firstEventTimer = setTimeout(() => {
        if (!firstEventSeen) {
          failureCategory = 'hard_timeout';
          absoluteAbort.abort(
            Object.assign(new Error('hard_timeout'), { code: 'hard_timeout' }),
          );
          void stopRun();
        }
      }, firstEventMs);

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
        const turnEndMonitor = createCursorTurnEndMonitor();
        activeRunRef = await agentHandle.send(prompt, {
          onDelta: (update) => {
            if (!firstEventSeen) {
              firstEventSeen = true;
              clearTimeout(firstEventTimer);
            }
            turnEndMonitor.observe(update);
          },
        });

        const result = await executeCursorExecutionCore({
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
          run: activeRunRef,
          context: { runId, sourceInstance },
          sink: {
            publish: async (event: SseEvent) => {
              if (fenceConflict) throw new AiRunFenceConflictError();
              if (cancellationRequested) {
                throw new InteractiveCancellationObservedError();
              }
              if (absoluteAbort.signal.aborted) {
                throw absoluteAbort.signal.reason instanceof Error
                  ? absoluteAbort.signal.reason
                  : Object.assign(new Error('hard_timeout'), {
                      code: 'hard_timeout',
                    });
              }
              if (!firstEventSeen) {
                firstEventSeen = true;
                clearTimeout(firstEventTimer);
              }
              if (event.type === 'tool_call') {
                armToolTimer();
              } else if (event.type === 'tool_status') {
                if (event.status === 'running') {
                  armToolTimer();
                } else {
                  clearToolTimer();
                }
              }
              if (event.type === 'token') {
                await publishLiveTokenBatches(
                  liveBatcher.push(event.text, now()),
                );
              } else {
                await publishLiveEnvelope(event);
                await post({
                  dispatchMessageId,
                  attemptId,
                  kind: 'progress',
                  phase: 'implementation',
                  status: 'running',
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
            },
          },
          nextSequence: () => 1,
          turnEnd: turnEndMonitor.completion,
        });

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
          throw new Error('Interactive turn did not finish successfully');
        }

        const finalText = result.text;
        if (finalText && finalText.trim().length > 0) {
          const finalMessage: ChatMessage = {
            id: randomUUID(),
            role: 'agent',
            text: finalText,
            ts: new Date(now()).toISOString(),
          };
          await post({
            dispatchMessageId,
            attemptId,
            kind: 'progress',
            event: { type: 'message', message: finalMessage },
          });
        }

        let artifactManifestRef: AiRunBlobRef | undefined;
        let artifactsFlushed = false;
        if (dependencies.uploadAttemptArtifacts) {
          artifactManifestRef = await dependencies.uploadAttemptArtifacts(
            bootstrap,
            checkout.workspacePath,
            absoluteAbort.signal,
          );
          artifactsFlushed = true;
        }

        if (!artifactsFlushed) {
          throw new Error(
            'Durable interactive completed terminal requires artifact collect/upload',
          );
        }

        await post({
          dispatchMessageId,
          attemptId,
          kind: 'terminal',
          status: 'completed',
          artifactsFlushed: true,
          artifactManifestRef,
          cursorAgentId: agentHandle.agentId ?? null,
        });

        agentCache.set(threadId, { handle: agentHandle, lastUsedAt: now() });
        retainAgent = true;
        return {
          status: 'completed',
          cursorAgentId: agentHandle.agentId ?? null,
        };
      } finally {
        clearTimeout(firstEventTimer);
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
        await post({
          dispatchMessageId,
          attemptId,
          kind: 'cancel_ack',
          detail: 'Interactive turn stopped',
        });
        return { status: 'cancelled' };
      }

      await disposeAgentEntry(threadId);
      const code =
        failureCategory ||
        (error &&
        typeof error === 'object' &&
        'code' in error &&
        ((error as { code?: string }).code === 'hard_timeout' ||
          (error as { code?: string }).code === 'tool_timeout')
          ? ((error as { code: 'hard_timeout' | 'tool_timeout' }).code)
          : null);
      const detail =
        code === 'tool_timeout'
          ? 'Interactive tool deadline exceeded'
          : code === 'hard_timeout'
            ? 'Interactive absolute deadline exceeded'
            : describeInteractiveFailure(error).reason;
      await post({
        dispatchMessageId,
        attemptId,
        kind: 'terminal',
        status: 'failed',
        detail,
        artifactsFlushed: false,
        ...(code ? { failureCategory: code } : {}),
      }).catch(() => {});
      if (code) {
        return { status: 'failed', failureCategory: code };
      }
      throw error;
    } finally {
      clearTimeout(absoluteTimer);
      clearToolTimer();
      if (attemptCheckout?.dispose) {
        await attemptCheckout.dispose().catch(() => {});
      }
      if (!retainAgent && agentHandle && !agentCache.has(threadId)) {
        await agentHandle.dispose().catch(() => {});
      }
    }
  }
}
