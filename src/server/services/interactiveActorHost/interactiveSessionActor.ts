/**
 * FEAT-007 / TBI-010 + TBI-011 — Dapr virtual-actor session host (logic core).
 *
 * One actor per `threadId` (single activation). Turn-based concurrency is
 * enforced by {@link PerThreadTurnQueue}: at most one in-flight turn per thread,
 * applied in order (BR-015). Each turn resumes the thread's Cursor session
 * (`Agent.resume` by `cursor_agent_id`) over a WARM grounded checkout reused
 * across turns and runs the shared execution core.
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
import {
  createCursorRunEventEnvelope,
  executeCursorExecutionCore,
  type CursorExecutionResult,
} from '../cursorExecutionCore';
import type { WorkerCursorExecution } from '../aiRunsWorker/cursorExecution';
import {
  AiRunCallbackError,
  AiRunFenceConflictError,
} from '../aiRunsWorker/callbackClient';
import { workerTierTelemetry, type WorkerTierTelemetry } from '../workerTierTelemetry';
import {
  createIncrementalTokenBatcher,
  INTERACTIVE_TOKEN_BATCH_MAX_BYTES,
} from '../interactiveTokenBatcher';
import { createPerThreadTurnQueue, type PerThreadTurnQueue } from './perThreadTurnQueue';

/** Default cadence for durable progress heartbeats (clocks + cancel signal). */
const DEFAULT_HEARTBEAT_MS = 4_000;

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
  /** Create (first turn) or resume (subsequent turns) the Cursor execution. */
  createExecution(
    snapshot: Readonly<ExecutionSnapshot>,
    checkout: WarmThreadCheckout,
    options: { resumeAgentId?: string | null },
  ): Promise<WorkerCursorExecution & { agentId?: string | null }>;
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
}

export interface InteractiveSessionActor {
  handleTurn(request: InteractiveTurnRequest): Promise<InteractiveTurnOutcome>;
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

  // Warm session cache keyed by threadId — single activation reuses the
  // grounded checkout and Cursor agent id across turns.
  const warmCheckouts = new Map<string, WarmThreadCheckout>();
  const agentIdByThread = new Map<string, string | null>();

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
    const turnStartedAt = now();
    let sequence = 0;
    let execution: (WorkerCursorExecution & { agentId?: string | null }) | undefined;

    const stopRun = async (): Promise<void> => {
      if (execution?.run.cancel) await execution.run.cancel().catch(() => {});
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
      // Reuse or open the warm grounded checkout (no per-turn re-grounding).
      let checkout = warmCheckouts.get(threadId);
      if (!checkout) {
        checkout = await dependencies.openWarmCheckout(threadId, snapshot);
        warmCheckouts.set(threadId, checkout);
      }

      const resumeAgentId =
        request.cursorAgentId ?? agentIdByThread.get(threadId) ?? null;
      execution = await dependencies.createExecution(snapshot, checkout, {
        resumeAgentId,
      });
      if (execution.agentId) agentIdByThread.set(threadId, execution.agentId);

      let result: CursorExecutionResult;
      try {
        result = await executeCursorExecutionCore({
          snapshot,
          run: execution.run,
          context: { runId, sourceInstance },
          sink: {
            publish: async (event: SseEvent) => {
              if (fenceConflict) throw fenceConflict;
              if (cancellationRequested) {
                throw new InteractiveCancellationObservedError();
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

      await post({
        dispatchMessageId,
        kind: 'terminal',
        status: 'completed',
        artifactsFlushed: true,
      });
      // Live terminal so the socket clears the spinner immediately; the durable
      // `done` (agent_run_events) covers reconnect replay, and the client's
      // `/run-status` poll is the belt-and-suspenders safety net.
      await publishLiveEvent({ type: 'done', runId });

      try {
        telemetry.interactiveTurn(telemetryContext, now() - turnStartedAt);
      } catch {
        // ignore
      }
      return { status: 'completed', cursorAgentId: agentIdByThread.get(threadId) };
    } catch (error) {
      if (fenceConflict || error instanceof AiRunFenceConflictError) {
        // A stale fence aborts before any further write (BR-018).
        return { status: 'fence-conflict' };
      }
      if (
        cancellationRequested ||
        error instanceof InteractiveCancellationObservedError ||
        isStopRaceIngestError(error)
      ) {
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
      // Dispose the per-turn Cursor agent; the grounded checkout stays warm and
      // is reused by the next turn on this thread (single activation).
      await execution?.dispose().catch(() => {});
    }
  };

  return {
    handleTurn(request: InteractiveTurnRequest): Promise<InteractiveTurnOutcome> {
      // BR-015: serialize per thread — one in-flight turn, applied in order.
      return turnQueue.submit(request.threadId, () => runTurn(request));
    },
  };
}
