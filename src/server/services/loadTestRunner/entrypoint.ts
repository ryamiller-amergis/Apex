/**
 * Container Apps Job entrypoint for the k6 load-test runner (FEAT-008).
 *
 * Message sources (first match wins):
 * 1. LT_DISPATCH_MESSAGE_JSON — local/dev / test injection
 * 2. Service Bus receive-and-delete from LT_SERVICEBUS_NAMESPACE / LT_QUEUE_NAME
 *
 * Does not write Postgres; callbacks go to Apex ingest (BR-008).
 */
import { DefaultAzureCredential } from '@azure/identity';
import type { LoadTestDispatchMessage } from '../../../shared/types/loadTest';
import {
  createBlobArtifactUploader,
  createContainerAppsJobRunner,
  createHttpAllowlistAsserter,
  createHttpCallbackClient,
  createKeyVaultSecretResolver,
  createProcessK6Executor,
} from './index';

async function getCallbackToken(): Promise<string> {
  // Short-term / local: shared secret (set LT_RUNNER_CALLBACK_TOKEN).
  // Long-term Azure: omit the secret and set LT_CALLBACK_TOKEN_AUDIENCE for MI JWTs.
  const staticToken = process.env.LT_RUNNER_CALLBACK_TOKEN?.trim();
  if (staticToken) return staticToken;

  const audience =
    process.env.LT_CALLBACK_TOKEN_AUDIENCE?.trim() ||
    process.env.APEX_API_APP_ID_URI?.trim() ||
    '';
  if (audience) {
    const credential = new DefaultAzureCredential();
    const scope = audience.endsWith('/.default') ? audience : `${audience}/.default`;
    const token = await credential.getToken(scope);
    if (!token?.token) {
      throw new Error('Failed to acquire runner callback token');
    }
    return token.token;
  }

  throw new Error(
    'LT_RUNNER_CALLBACK_TOKEN (short-term) or LT_CALLBACK_TOKEN_AUDIENCE (MI) is required',
  );
}

async function receiveDispatchFromServiceBus(): Promise<LoadTestDispatchMessage> {
  const namespace = process.env.LT_SERVICEBUS_NAMESPACE?.trim();
  const queue =
    process.env.LT_SERVICEBUS_QUEUE_NAME?.trim() ||
    process.env.LT_QUEUE_NAME?.trim() ||
    'lt-dispatch';

  if (!namespace) {
    throw new Error('LT_SERVICEBUS_NAMESPACE is required to receive dispatch messages');
  }

  const credential = new DefaultAzureCredential();
  const token = await credential.getToken('https://servicebus.azure.net/.default');
  if (!token?.token) {
    throw new Error('Failed to acquire Service Bus access token');
  }

  const host = namespace.includes('.')
    ? namespace
    : `${namespace}.servicebus.windows.net`;
  // Receive-and-delete (Destructive) — one message per Job execution.
  const url = `https://${host}/${encodeURIComponent(queue)}/messages/head?timeout=60`;

  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Content-Type': 'application/json',
    },
  });

  if (res.status === 204 || res.status === 404) {
    throw new Error('No Service Bus dispatch message available');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Service Bus receive failed (${res.status}): ${body || res.statusText}`,
    );
  }

  const message = (await res.json()) as LoadTestDispatchMessage;
  if (!message?.dispatchMessageId || !message?.runId) {
    throw new Error('Received Service Bus message missing dispatchMessageId/runId');
  }
  return message;
}

async function loadDispatch(): Promise<LoadTestDispatchMessage> {
  const raw = process.env.LT_DISPATCH_MESSAGE_JSON?.trim();
  if (raw) {
    return JSON.parse(raw) as LoadTestDispatchMessage;
  }
  return receiveDispatchFromServiceBus();
}

export async function main(): Promise<void> {
  const dispatch = await loadDispatch();
  const callbackBaseUrl =
    dispatch.callbackBaseUrl ||
    process.env.APEX_CALLBACK_URL?.trim() ||
    process.env.LT_APEX_CALLBACK_BASE_URL?.trim() ||
    '';

  if (!callbackBaseUrl) {
    throw new Error('callbackBaseUrl / APEX_CALLBACK_URL is required');
  }

  const callback = createHttpCallbackClient({
    callbackBaseUrl,
    getToken: getCallbackToken,
  });

  const runner = createContainerAppsJobRunner({
    assertAllowlist: createHttpAllowlistAsserter({
      getToken: getCallbackToken,
    }),
    resolveSecrets: createKeyVaultSecretResolver(),
    runK6: createProcessK6Executor(),
    uploadArtifact: createBlobArtifactUploader(),
    postIngest: (projectId, runId, body) =>
      callback.postIngest(projectId, runId, body),
  });

  console.log(
    JSON.stringify({
      event: 'LoadTestRunnerStarted',
      runId: dispatch.runId,
      projectId: dispatch.projectId,
      dispatchMessageId: dispatch.dispatchMessageId,
    }),
  );

  await runner.execute(dispatch);

  console.log(
    JSON.stringify({
      event: 'LoadTestRunnerFinished',
      runId: dispatch.runId,
      projectId: dispatch.projectId,
      dispatchMessageId: dispatch.dispatchMessageId,
    }),
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(
      JSON.stringify({
        event: 'LoadTestRunnerFatal',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exitCode = 1;
  });
}
