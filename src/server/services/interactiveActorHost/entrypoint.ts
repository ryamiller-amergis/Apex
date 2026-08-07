/**
 * FEAT-007 / TBI-010 — long-running Azure Container Apps host for the
 * interactive AI-runs lane.
 *
 * Boots a Dapr server that registers {@link InteractiveSessionActorImpl} (one
 * activation per `threadId`) and exposes a single `dispatch` service-invocation
 * method. The Apex API (App Service, no Dapr sidecar) posts turn dispatches to
 * this host's ingress; the handler resolves the thread's actor proxy through
 * the local Dapr sidecar and invokes `handleTurn`. The actor then fetches the
 * frozen bootstrap snapshot, runs the turn over a warm grounded checkout, and
 * streams batched events back through the fenced runner ingest.
 *
 * Client fan-out is NOT owned here: the durable spine is `agent_run_events`
 * (written by ingest) and the WebSocket gateway is mounted on the App Service.
 * This host never owns a client socket and never logs prompt/snapshot/secret.
 */
import {
  ActorId,
  ActorProxyBuilder,
  CommunicationProtocolEnum,
  DaprServer,
} from '@dapr/dapr';
import { DefaultAzureCredential } from '@azure/identity';
import { createAiRunsCallbackClient } from '../aiRunsWorker/callbackClient';
import { openLocalCheckout } from '../aiRunsWorker/workspace';
import type { LocalCheckoutReader } from '../localCheckoutReader';
import { createInteractiveCursorExecution } from './interactiveCursorExecution';
import {
  createInteractiveSessionActor,
  type WarmThreadCheckout,
} from './interactiveSessionActor';
import {
  InteractiveSessionActorImpl,
  setInteractiveActorRuntime,
  type IInteractiveSessionActor,
} from './interactiveSessionActorClass';

/** Warm checkout carrying the reader the execution factory needs. */
type ReaderCheckout = WarmThreadCheckout & { reader: LocalCheckoutReader };

async function getCallbackToken(): Promise<string> {
  const staticToken =
    process.env.NODE_ENV === 'production'
      ? undefined
      : process.env.AI_RUNS_RUNNER_CALLBACK_TOKEN?.trim();
  if (staticToken) return staticToken;

  const audience = process.env.AI_RUNS_CALLBACK_TOKEN_AUDIENCE?.trim();
  if (!audience) {
    throw new Error(
      'AI_RUNS_CALLBACK_TOKEN_AUDIENCE is required for managed-identity callbacks',
    );
  }
  const scope = audience.endsWith('/.default')
    ? audience
    : `${audience}/.default`;
  const token = await new DefaultAzureCredential().getToken(scope);
  if (!token?.token) {
    throw new Error('Failed to acquire AI runner callback token');
  }
  return token.token;
}

export async function main(): Promise<void> {
  const callbackBaseUrl =
    process.env.APEX_CALLBACK_URL?.trim() ||
    process.env.AI_RUNS_APEX_CALLBACK_BASE_URL?.trim() ||
    '';
  if (!callbackBaseUrl) {
    throw new Error('APEX_CALLBACK_URL is required');
  }
  const serverPort =
    process.env.AI_RUNS_INTERACTIVE_TARGET_PORT?.trim() ||
    process.env.PORT?.trim() ||
    '8080';

  const callback = createAiRunsCallbackClient({
    callbackBaseUrl,
    getToken: getCallbackToken,
  });

  // Single shared logic core: thread-keyed warm checkout + agent-id cache.
  const logic = createInteractiveSessionActor({
    openWarmCheckout: async (_threadId, snapshot) => {
      const reader = await openLocalCheckout(snapshot);
      const checkout: ReaderCheckout = {
        workspacePath: snapshot.workspaceRef,
        reader,
      };
      return checkout;
    },
    createExecution: (snapshot, checkout, options) =>
      createInteractiveCursorExecution(
        snapshot,
        (checkout as ReaderCheckout).reader,
        options,
      ),
    postIngest: (projectId, runId, body) =>
      callback.postIngest(projectId, runId, body),
  });
  setInteractiveActorRuntime({ logic, callback });

  const server = new DaprServer({
    serverPort,
    communicationProtocol: CommunicationProtocolEnum.HTTP,
  });

  await server.actor.init();
  await server.actor.registerActor(InteractiveSessionActorImpl);

  const proxyBuilder = new ActorProxyBuilder<IInteractiveSessionActor>(
    InteractiveSessionActorImpl,
    server.client,
  );

  // The API dispatches { threadId, runId, dispatchMessageId }; we resolve the
  // thread's actor and invoke its turn. Only identifiers cross the wire.
  await server.invoker.listen('dispatch', async (data: unknown) => {
    const payload = (data ?? {}) as {
      threadId?: unknown;
      runId?: unknown;
      dispatchMessageId?: unknown;
    };
    if (
      typeof payload.threadId !== 'string' ||
      typeof payload.runId !== 'string' ||
      typeof payload.dispatchMessageId !== 'string'
    ) {
      throw new Error('Interactive dispatch requires threadId, runId, and dispatchMessageId');
    }
    const actor = proxyBuilder.build(new ActorId(payload.threadId));
    return actor.handleTurn({
      runId: payload.runId,
      dispatchMessageId: payload.dispatchMessageId,
    });
  });

  await server.start();
  console.log(
    JSON.stringify({
      event: 'InteractiveActorHostStarted',
      serverPort,
    }),
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        event: 'InteractiveActorHostFatal',
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
    process.exitCode = 1;
  });
}
