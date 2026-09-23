/**
 * FEAT-007 / TBI-010 — Dapr virtual-actor binding for the interactive session
 * host.
 *
 * The Dapr runtime instantiates one actor per `threadId` (single activation)
 * and serializes method calls, giving turn-based concurrency for free. This
 * class is a thin binding: it fetches the project-confidential bootstrap
 * snapshot (never carried on the dispatch wire — same fence model as the
 * background worker), verifies the dispatch fence, then delegates to the shared
 * {@link InteractiveSessionActor} logic core. The logic core keeps the warm
 * grounded checkout and live Cursor Agent keyed by `threadId`, so a single
 * shared instance correctly serves every actor in the process.
 *
 * Dependencies are injected via a module-level runtime because the Dapr SDK
 * constructs actors reflectively (`new Actor(daprClient, id)`); the host
 * entrypoint calls {@link setInteractiveActorRuntime} before `server.start()`.
 */
import { AbstractActor } from '@dapr/dapr';
import type { AgentRunExecutionSnapshot } from '../../../shared/types/agentRunLifecycle';
import {
  isInteractiveActorBootstrap,
  type InteractiveActorBootstrap,
} from '../../../shared/types/aiRunIngest';
import { INTERACTIVE_LANE } from '../../../shared/types/interactiveWorkflow';
import type { AiRunsCallbackClient } from '../aiRunsWorker/callbackClient';
import { workerTierTelemetry } from '../workerTierTelemetry';
import type {
  InteractiveSessionActor,
  InteractiveTurnOutcome,
} from './interactiveSessionActor';

export interface InteractiveActorRuntime {
  /** Shared logic core (thread-keyed warm checkout + agent cache). */
  logic: InteractiveSessionActor;
  /** Authenticated fenced callback client for bootstrap + ingest. */
  callback: AiRunsCallbackClient;
}

let runtime: InteractiveActorRuntime | undefined;

function isDurableInteractiveSnapshot(
  snapshot: AgentRunExecutionSnapshot,
): snapshot is Extract<
  AgentRunExecutionSnapshot,
  { kind: 'interactive-turn' }
> {
  return 'kind' in snapshot && snapshot.kind === 'interactive-turn';
}

export function setInteractiveActorRuntime(next: InteractiveActorRuntime): void {
  runtime = next;
}

/** Only dispatch identifiers travel on the wire; the snapshot is fetched. */
export interface InteractiveDispatchPayload {
  runId: string;
  dispatchMessageId: string;
}

export interface IInteractiveSessionActor {
  handleTurn(
    payload: InteractiveDispatchPayload,
  ): Promise<InteractiveTurnOutcome>;
}

function priorOutcomeForTerminalAttempt(
  bootstrap: InteractiveActorBootstrap,
): InteractiveTurnOutcome {
  switch (bootstrap.attemptStatus) {
    case 'completed':
      return {
        status: 'completed',
        cursorAgentId: bootstrap.cursorAgentId,
      };
    case 'cancelled':
      return { status: 'cancelled' };
    case 'failed':
      return { status: 'cancelled' };
    default:
      return { status: 'fence-conflict' };
  }
}

export class InteractiveSessionActorImpl
  extends AbstractActor
  implements IInteractiveSessionActor {
  async handleTurn(
    payload: InteractiveDispatchPayload,
  ): Promise<InteractiveTurnOutcome> {
    const active = runtime;
    if (!active) {
      throw new Error('Interactive actor runtime is not initialized');
    }

    const receiptAt = Date.now();
    const telemetryContext = {
      runId: payload.runId,
      dispatchMessageId: payload.dispatchMessageId,
      lane: INTERACTIVE_LANE,
    };

    // Bootstrap precedes any project-scoped work (auth + exact dispatch fence).
    const bootstrapStartedAt = Date.now();
    try {
      workerTierTelemetry.interactiveStage(
        telemetryContext,
        'actor_receipt',
        Math.max(0, bootstrapStartedAt - receiptAt),
      );
    } catch {
      // ignore
    }

    const bootstrap = await active.callback.getBootstrap({
      runId: payload.runId,
      dispatchMessageId: payload.dispatchMessageId,
    });
    try {
      workerTierTelemetry.interactiveStage(
        {
          ...telemetryContext,
          project: bootstrap.projectId,
        },
        'bootstrap',
        Date.now() - bootstrapStartedAt,
      );
    } catch {
      // ignore
    }

    // Durable interactive V2 bootstrap — attempt-aware path.
    if (isInteractiveActorBootstrap(bootstrap)) {
      if (bootstrap.dispatchMessageId !== payload.dispatchMessageId) {
        return { status: 'fence-conflict' };
      }
      if (
        bootstrap.attemptStatus === 'completed' ||
        bootstrap.attemptStatus === 'failed' ||
        bootstrap.attemptStatus === 'cancelled'
      ) {
        return priorOutcomeForTerminalAttempt(bootstrap);
      }
      if (
        bootstrap.attemptStatus !== 'queued' &&
        bootstrap.attemptStatus !== 'dispatched' &&
        bootstrap.attemptStatus !== 'running'
      ) {
        return { status: 'fence-conflict' };
      }

      const threadId = this.getActorId().getId();
      return active.logic.handleDurableTurn({
        threadId,
        bootstrap,
      });
    }

    const persistedSnapshot = bootstrap.run.executionSnapshot;
    if (isDurableInteractiveSnapshot(persistedSnapshot)) {
      throw new Error(
        'Durable interactive turns require the direct actor V2 executor',
      );
    }
    const snapshot = Object.freeze({ ...persistedSnapshot });

    // A stale fence aborts before any warm-checkout access or ingest (BR-018).
    if (
      bootstrap.run.dispatchMessageId !== payload.dispatchMessageId ||
      snapshot.projectId !== bootstrap.projectId
    ) {
      return { status: 'fence-conflict' };
    }

    // Actor identity is the threadId; single activation guarantees serialized
    // turns on this thread.
    const threadId = this.getActorId().getId();

    return active.logic.handleTurn({
      runId: payload.runId,
      threadId,
      projectId: bootstrap.projectId,
      dispatchMessageId: payload.dispatchMessageId,
      snapshot,
      cursorAgentId: bootstrap.cursorAgentId ?? null,
    });
  }
}
