/**
 * FEAT-007 / TBI-010 + TBI-011 — Dapr virtual-actor session host (logic core).
 *
 * One actor per `threadId` (single activation). Turn-based concurrency is
 * enforced by {@link PerThreadTurnQueue}: at most one in-flight turn per thread,
 * applied in order (BR-015). Each turn resumes the thread's Cursor session
 * (`Agent.resume` by `cursor_agent_id`) over a WARM grounded checkout reused
 * across turns, runs the shared execution core, and streams BATCHED token/tool/
 * progress events through the fenced runner ingest (reused Phase 1 spine).
 *
 * Every callback carries the current dispatch fence; a stale fence aborts the
 * turn before further writes (BR-018). Cancellation is cooperative (ingest
 * response `cancelRequested` → stop the SDK run → post cancel_ack). Durability
 * stays in agent_run_events via ingest; this host never owns the client socket
 * and never logs prompt/snapshot/workspace/secret (BR-016, BR-019).
 */
import type { ExecutionSnapshot } from '../../../shared/types/agentRunLifecycle';
import type {
  AiRunIngestBody,
  AiRunIngestResponse,
} from '../../../shared/types/aiRunIngest';
import type { SseEvent } from '../../../shared/types/chat';
import { INTERACTIVE_LANE } from '../../../shared/types/interactiveWorkflow';
import {
  executeCursorExecutionCore,
  type CursorExecutionResult,
} from '../cursorExecutionCore';
import type { WorkerCursorExecution } from '../aiRunsWorker/cursorExecution';
import { AiRunFenceConflictError } from '../aiRunsWorker/callbackClient';
import { workerTierTelemetry, type WorkerTierTelemetry } from '../workerTierTelemetry';
import {
  createInteractiveTokenBatcher,
  INTERACTIVE_TOKEN_BATCH_MAX_BYTES,
} from '../interactiveTokenBatcher';
import { createPerThreadTurnQueue, type PerThreadTurnQueue } from './perThreadTurnQueue';

class InteractiveCancellationObservedError extends Error {
  constructor() {
    super('Interactive turn cancellation requested');
    this.name = 'InteractiveCancellationObservedError';
  }
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
  turnQueue?: PerThreadTurnQueue;
  telemetry?: WorkerTierTelemetry;
  batchMaxBytes?: number;
  sourceInstance?: string;
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
        }
        throw error;
      }
      if (response.cancelRequested && body.kind !== 'cancel_ack') {
        cancellationRequested = true;
        await stopRun();
        if (abortOnCancellation) throw new InteractiveCancellationObservedError();
      }
    };

    const tokenBatcher = createInteractiveTokenBatcher(batchMaxBytes);

    const postToken = async (text: string): Promise<void> => {
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
      await post({
        dispatchMessageId,
        kind: 'progress',
        phase: 'implementation',
        status: 'running',
        detail: undefined,
        event: { type: 'token', text },
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
                // Coalesce tokens to respect the NOTIFY payload limit (BR-016).
                for (const batch of tokenBatcher.push(event.text)) {
                  await postToken(batch);
                }
                return;
              }
              await post({
                dispatchMessageId,
                kind: 'progress',
                phase: 'implementation',
                status: 'running',
                event,
              });
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
        const tail = tokenBatcher.flush();
        if (tail && !fenceConflict && !cancellationRequested) {
          await postToken(tail).catch(() => {});
        }
      }

      if (cancellationRequested) throw new InteractiveCancellationObservedError();
      if (!isSuccessfulWait(result)) {
        throw new Error('Interactive turn did not finish successfully');
      }

      await post({
        dispatchMessageId,
        kind: 'terminal',
        status: 'completed',
        artifactsFlushed: true,
      });

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
        error instanceof InteractiveCancellationObservedError
      ) {
        await dependencies
          .postIngest(projectId, runId, {
            dispatchMessageId,
            kind: 'cancel_ack',
            detail: 'Interactive turn stopped',
          })
          .catch(() => {});
        return { status: 'cancelled' };
      }
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
