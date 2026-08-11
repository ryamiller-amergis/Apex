/**
 * One-message Container Apps Job entrypoint for background AI runs.
 *
 * Service Bus carries only runId + dispatchMessageId. The authenticated
 * bootstrap callback supplies all project-confidential execution data.
 */
import { DefaultAzureCredential } from '@azure/identity';
import type { DispatchMessage } from '../../../shared/types/agentRunAdmission';
import { resolveStaticAiRunnerCallbackToken } from '../aiRunnerCallbackAuthConfig';
import { createAiRunsCallbackClient } from './callbackClient';
import { createLocalCursorExecution } from './cursorExecution';
import { createAiRunsWorker } from './worker';
import {
  flushWorkspaceArtifacts,
  openLocalCheckout,
} from './workspace';

const SERVICE_BUS_SCOPE = 'https://servicebus.azure.net/.default';

function parseDispatchMessage(value: unknown): DispatchMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AI run dispatch must be an object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2
    || keys[0] !== 'dispatchMessageId'
    || keys[1] !== 'runId'
  ) {
    throw new Error(
      'AI run dispatch may contain only runId and dispatchMessageId',
    );
  }
  if (
    typeof record.runId !== 'string'
    || !record.runId.trim()
    || typeof record.dispatchMessageId !== 'string'
    || !record.dispatchMessageId.trim()
  ) {
    throw new Error('AI run dispatch is missing runId or dispatchMessageId');
  }
  return {
    runId: record.runId,
    dispatchMessageId: record.dispatchMessageId,
  };
}

export async function receiveAiRunsDispatchFromServiceBus(options: {
  namespace: string;
  queueName: string;
  getAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): Promise<DispatchMessage> {
  const host = options.namespace.includes('.')
    ? options.namespace
    : `${options.namespace}.servicebus.windows.net`;
  const url =
    `https://${host}/${encodeURIComponent(options.queueName)}/messages/head?timeout=60`;
  const token = await options.getAccessToken();
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (response.status === 204 || response.status === 404) {
    throw new Error('No AI run dispatch message available');
  }
  if (!response.ok) {
    throw new Error(`Service Bus receive failed (${response.status})`);
  }
  return parseDispatchMessage(await response.json());
}

export async function loadAiRunsDispatchMessage(): Promise<DispatchMessage> {
  const localMessage = process.env.AI_RUNS_DISPATCH_MESSAGE_JSON?.trim();
  if (localMessage) {
    return parseDispatchMessage(JSON.parse(localMessage));
  }

  const namespace = process.env.AI_RUNS_SERVICEBUS_NAMESPACE?.trim();
  if (!namespace) {
    throw new Error(
      'AI_RUNS_SERVICEBUS_NAMESPACE is required to receive dispatch messages',
    );
  }
  const queueName =
    process.env.AI_RUNS_BACKGROUND_QUEUE_NAME?.trim()
    || 'ai-runs-background';
  const credential = new DefaultAzureCredential();
  return receiveAiRunsDispatchFromServiceBus({
    namespace,
    queueName,
    getAccessToken: async () => {
      const token = await credential.getToken(SERVICE_BUS_SCOPE);
      if (!token?.token) {
        throw new Error('Failed to acquire Service Bus access token');
      }
      return token.token;
    },
  });
}

async function getCallbackToken(): Promise<string> {
  // Match interactive actor host: prefer MI JWT when audience is configured,
  // fall back to the static bridge token when MI is unavailable (DEV allowlist).
  const staticToken = resolveStaticAiRunnerCallbackToken();
  const audience = process.env.AI_RUNS_CALLBACK_TOKEN_AUDIENCE?.trim();

  if (audience) {
    const scope = audience.endsWith('/.default')
      ? audience
      : `${audience}/.default`;
    try {
      const token = await new DefaultAzureCredential().getToken(scope);
      if (token?.token) return token.token;
      if (!staticToken) {
        throw new Error('Failed to acquire AI runner callback token');
      }
    } catch (error) {
      if (!staticToken) throw error;
    }
  }

  if (staticToken) return staticToken;

  throw new Error(
    'AI_RUNS_CALLBACK_TOKEN_AUDIENCE is required for managed-identity callbacks',
  );
}

export async function main(): Promise<void> {
  const dispatch = await loadAiRunsDispatchMessage();
  const callbackBaseUrl =
    process.env.APEX_CALLBACK_URL?.trim()
    || process.env.AI_RUNS_APEX_CALLBACK_BASE_URL?.trim()
    || '';
  if (!callbackBaseUrl) {
    throw new Error('APEX_CALLBACK_URL is required');
  }

  const callback = createAiRunsCallbackClient({
    callbackBaseUrl,
    getToken: getCallbackToken,
  });
  const worker = createAiRunsWorker({
    getBootstrap: (message) => callback.getBootstrap(message),
    openCheckout: (snapshot) => openLocalCheckout(snapshot),
    createExecution: (snapshot, checkout) =>
      createLocalCursorExecution(
        snapshot,
        checkout as Awaited<ReturnType<typeof openLocalCheckout>>,
      ),
    postIngest: (projectId, runId, body) =>
      callback.postIngest(projectId, runId, body),
    flushArtifacts: flushWorkspaceArtifacts,
  });

  console.log(JSON.stringify({
    event: 'AiRunsWorkerStarted',
    runId: dispatch.runId,
    dispatchMessageId: dispatch.dispatchMessageId,
  }));
  await worker.execute(dispatch);
  console.log(JSON.stringify({
    event: 'AiRunsWorkerFinished',
    runId: dispatch.runId,
    dispatchMessageId: dispatch.dispatchMessageId,
  }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: 'AiRunsWorkerFatal',
      errorType: error instanceof Error ? error.name : 'UnknownError',
    }));
    process.exitCode = 1;
  });
}
