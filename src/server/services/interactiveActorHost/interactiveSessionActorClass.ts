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
 * grounded checkout and Cursor agent id keyed by `threadId`, so a single shared
 * instance correctly serves every actor in the process.
 *
 * Dependencies are injected via a module-level runtime because the Dapr SDK
 * constructs actors reflectively (`new Actor(daprClient, id)`); the host
 * entrypoint calls {@link setInteractiveActorRuntime} before `server.start()`.
 */
import { AbstractActor } from '@dapr/dapr';
import type { AiRunsCallbackClient } from '../aiRunsWorker/callbackClient';
import type {
  InteractiveSessionActor,
  InteractiveTurnOutcome,
} from './interactiveSessionActor';

export interface InteractiveActorRuntime {
  /** Shared logic core (thread-keyed warm checkout + agent-id cache). */
  logic: InteractiveSessionActor;
  /** Authenticated fenced callback client for bootstrap + ingest. */
  callback: AiRunsCallbackClient;
}

let runtime: InteractiveActorRuntime | undefined;

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

    // Bootstrap precedes any project-scoped work (auth + exact dispatch fence).
    const bootstrap = await active.callback.getBootstrap({
      runId: payload.runId,
      dispatchMessageId: payload.dispatchMessageId,
    });
    const snapshot = Object.freeze({ ...bootstrap.run.executionSnapshot });

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
    });
  }
}
