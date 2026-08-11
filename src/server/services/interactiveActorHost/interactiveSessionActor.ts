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
import type { ExecutionSnapshot } from '../../../shared/types/agentRunLifecycle';
import type {
  AiRunIngestBody,
  AiRunIngestResponse,
} from '../../../shared/types/aiRunIngest';
import type {
  AgentRunEventEnvelope,
  ChatMessage,
  SseEvent,
} from '../../../shared/types/chat';
import { INTERACTIVE_LANE } from '../../../shared/types/interactiveWorkflow';
import type { InteractiveStageName } from '../../../shared/types/workerTierOperations';
import {
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
import type { InteractiveCursorAgentHandle } from './interactiveCursorExecution';
import { createPerThreadTurnQueue, type PerThreadTurnQueue } from './perThreadTurnQueue';

/** Default cadence for durable progress heartbeats (clocks + cancel signal). */
const DEFAULT_HEARTBEAT_MS = 4_000;

/** Idle TTL for the live per-thread Agent cache. */
export const INTERACTIVE_AGENT_CACHE_IDLE_MS = 10 * 60_000;

/** Hard cap on live Agent handles retained in this process. */
export const INTERACTIVE_AGENT_CACHE_MAX = 32;

/** Home-facing live phase detail before checkout / SDK work. */
export const INTERACTIVE_STARTING_DETAIL = 'Starting agent…';

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
    options: { resumeAgentId?: string | null },
  ): Promise<InteractiveCursorAgentHandle>;
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
  /** Dispose every warm checkout + cached Agent (process shutdown / deactivation). */
  disposeAll(): Promise<void>;
}

interface CachedAgentEntry {
  handle: InteractiveCursorAgentHandle;
  lastUsedAt: number;
}

function isSuccessfulWait(result: CursorExecutionResult): boolean {
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
      activeRun = await agentHandle.send(snapshot.prompt);
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
      // Live failure so the socket surfaces the error and stops spinning; the
      // durable failed terminal + `done` (below, via ingest) cover replay.
      await publishLiveEvent({
        type: 'error',
        error: 'Interactive turn failed',
        errorCode: 'fatal',
      }).catch(() => {});
      await publishLiveEvent({ type: 'done', runId }).catch(() => {});
      await post({
        dispatchMessageId,
        kind: 'terminal',
        status: 'failed',
        detail: 'Interactive turn failed',
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
}
