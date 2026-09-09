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
  HttpMethod,
  type DaprInvokerCallbackContent,
} from '@dapr/dapr';
// Side-effect: initialize Application Insights when the connection string is set.
import '../telemetry';
import { getAiRunnerCallbackToken } from '../aiRunsCallbackToken';
import { createAiRunsCallbackClient } from '../aiRunsWorker/callbackClient';
import { openGroundedReader } from '../aiRunsWorker/workspace';
import { interactiveLiveBus } from '../interactiveLiveBus';
import type { RepoReader } from '../../../shared/types/repoReader';
import { acquireInteractiveCursorAgent } from './interactiveCursorExecution';
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
type ReaderCheckout = WarmThreadCheckout & { reader: RepoReader };

export interface InteractiveDispatchRequest {
  threadId: string;
  runId: string;
  dispatchMessageId: string;
}

interface InteractiveDispatchInvoker {
  listen(
    methodName: string,
    callback: (data: DaprInvokerCallbackContent) => Promise<unknown>,
    options: { method: HttpMethod }
  ): Promise<unknown>;
}

function parseDispatchBody(body: string | undefined): unknown {
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error('Interactive dispatch body must be valid JSON');
  }
}

/**
 * Serialize an unknown thrown value into structured, log-safe fields. The
 * dispatch and fatal handlers previously logged only error.name, which reduced
 * every actor failure to the opaque errorType "Error" - impossible to
 * diagnose without a redeploy. We now surface message, stack, and any nested
 * `cause` so the failing stage (grounding, checkout, Cursor SDK) is visible in
 * Container Apps logs. These frames never contain prompt/snapshot/secret data.
 */
function describeError(error: unknown): {
  errorType: string;
  errorMessage?: string;
  errorStack?: string;
  errorCause?: string;
} {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    return {
      errorType: error.name || 'Error',
      errorMessage: error.message,
      errorStack: error.stack,
      errorCause:
        cause instanceof Error
          ? `${cause.name}: ${cause.message}`
          : cause != null
            ? String(cause)
            : undefined,
    };
  }
  let errorMessage: string;
  try {
    errorMessage = typeof error === 'string' ? error : JSON.stringify(error);
  } catch {
    errorMessage = String(error);
  }
  return { errorType: 'UnknownError', errorMessage };
}

export function parseInteractiveDispatchRequest(
  content: DaprInvokerCallbackContent
): InteractiveDispatchRequest {
  const payload = parseDispatchBody(
    content.body
  ) as Partial<InteractiveDispatchRequest> | null;
  if (
    !payload ||
    typeof payload.threadId !== 'string' ||
    typeof payload.runId !== 'string' ||
    typeof payload.dispatchMessageId !== 'string'
  ) {
    throw new Error(
      'Interactive dispatch requires threadId, runId, and dispatchMessageId'
    );
  }
  return {
    threadId: payload.threadId,
    runId: payload.runId,
    dispatchMessageId: payload.dispatchMessageId,
  };
}

export async function registerInteractiveDispatchHandler(
  invoker: InteractiveDispatchInvoker,
  resolveActor: (threadId: string) => IInteractiveSessionActor,
  recoverActorFailure?: (
    payload: InteractiveDispatchRequest,
    error: unknown
  ) => Promise<void>
): Promise<void> {
  await invoker.listen(
    'dispatch',
    async (content) => {
      let payload: InteractiveDispatchRequest;
      try {
        payload = parseInteractiveDispatchRequest(content);
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: 'InteractiveDispatchRejected',
            ...describeError(error),
          })
        );
        return { accepted: false };
      }
      console.log(
        JSON.stringify({
          event: 'InteractiveDispatchAccepted',
          threadId: payload.threadId,
          runId: payload.runId,
          dispatchMessageId: payload.dispatchMessageId,
        })
      );
      const actor = resolveActor(payload.threadId);
      void actor
        .handleTurn({
          runId: payload.runId,
          dispatchMessageId: payload.dispatchMessageId,
        })
        .then((outcome) => {
          console.log(
            JSON.stringify({
              event: 'InteractiveDispatchCompleted',
              threadId: payload.threadId,
              runId: payload.runId,
              dispatchMessageId: payload.dispatchMessageId,
              status: outcome.status,
            })
          );
        })
        .catch(async (error) => {
          console.error(
            JSON.stringify({
              event: 'InteractiveDispatchFailed',
              threadId: payload.threadId,
              runId: payload.runId,
              dispatchMessageId: payload.dispatchMessageId,
              ...describeError(error),
            })
          );
          if (!recoverActorFailure) return;
          try {
            await recoverActorFailure(payload, error);
            console.log(
              JSON.stringify({
                event: 'InteractiveDispatchFailureRecovered',
                threadId: payload.threadId,
                runId: payload.runId,
                dispatchMessageId: payload.dispatchMessageId,
              })
            );
          } catch (recoveryError) {
            console.error(
              JSON.stringify({
                event: 'InteractiveDispatchFailureRecoveryFailed',
                threadId: payload.threadId,
                runId: payload.runId,
                dispatchMessageId: payload.dispatchMessageId,
                ...describeError(recoveryError),
              })
            );
          }
        });
      return { accepted: true };
    },
    { method: HttpMethod.POST }
  );
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
    getToken: getAiRunnerCallbackToken,
  });

  // Single shared logic core: thread-keyed warm checkout + live Agent cache.
  const logic = createInteractiveSessionActor({
    openWarmCheckout: async (_threadId, snapshot) => {
      const reader = await openGroundedReader(snapshot);
      const checkout: ReaderCheckout = {
        workspacePath: snapshot.workspaceRef,
        reader,
      };
      return checkout;
    },
    acquireAgent: (snapshot, checkout, options) =>
      acquireInteractiveCursorAgent(
        snapshot,
        (checkout as ReaderCheckout).reader,
        options
      ),
    postIngest: (projectId, runId, body) =>
      callback.postIngest(projectId, runId, body),
    // Live token/tool/phase fan-out over Redis (ephemeral). No-op when Redis
    // is unconfigured — durability then rides ingest + client safety-net poll.
    publishLive: (threadId, envelope) =>
      interactiveLiveBus.publish(threadId, envelope),
  });
  // Eagerly connect the publisher so first-token latency isn't paid lazily.
  await interactiveLiveBus.init();
  setInteractiveActorRuntime({ logic, callback });

  const disposeOnShutdown = (): void => {
    void logic.disposeAll().catch(() => {});
  };
  process.once('SIGTERM', disposeOnShutdown);
  process.once('SIGINT', disposeOnShutdown);

  const server = new DaprServer({
    serverPort,
    communicationProtocol: CommunicationProtocolEnum.HTTP,
  });

  await server.actor.init();
  await server.actor.registerActor(InteractiveSessionActorImpl);

  const proxyBuilder = new ActorProxyBuilder<IInteractiveSessionActor>(
    InteractiveSessionActorImpl,
    server.client
  );

  // The API POSTs { threadId, runId, dispatchMessageId }; Dapr wraps the JSON
  // request body in DaprInvokerCallbackContent before invoking this handler.
  await registerInteractiveDispatchHandler(
    server.invoker,
    (threadId) => proxyBuilder.build(new ActorId(threadId)),
    async (payload) => {
      // `/dispatch` returns before the long-running actor invocation finishes.
      // If Dapr cannot deliver that invocation (for example, it routes to a
      // restarting replica), no actor exists to write a terminal event. Resolve
      // the fenced bootstrap here and finish the run through the same durable
      // ingest path used by the actor so the client can retry immediately.
      const bootstrap = await callback.getBootstrap({
        runId: payload.runId,
        dispatchMessageId: payload.dispatchMessageId,
      });
      await callback.postIngest(bootstrap.projectId, payload.runId, {
        dispatchMessageId: payload.dispatchMessageId,
        kind: 'terminal',
        status: 'failed',
        phase: 'completion',
        detail: 'Interactive agent could not start. Please retry.',
      });
    }
  );

  await server.start();
  console.log(
    JSON.stringify({
      event: 'InteractiveActorHostStarted',
      serverPort,
    })
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        event: 'InteractiveActorHostFatal',
        ...describeError(error),
      })
    );
    process.exitCode = 1;
  });
}
