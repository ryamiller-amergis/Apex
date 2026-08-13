/**
 * One-message Container Apps Job entrypoint for admin repository checkout.
 * Service Bus payload is empty; Postgres owns the job row to claim.
 */
import { DefaultAzureCredential } from '@azure/identity';
import { processNextCheckoutJob } from '../projectRepositoryCheckoutService';

const SERVICE_BUS_SCOPE = 'https://servicebus.azure.net/.default';
const DEFAULT_QUEUE_NAME = 'repo-checkout';

export async function receiveRepoCheckoutWakeup(options: {
  namespace: string;
  queueName: string;
  getAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): Promise<void> {
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
    throw new Error('No repo-checkout wakeup message available');
  }
  if (!response.ok) {
    throw new Error(`Service Bus receive failed (${response.status})`);
  }
}

export async function loadRepoCheckoutWakeup(): Promise<void> {
  if (process.env.REPO_CHECKOUT_WORKER_MODE?.trim().toLowerCase() === 'in-process') {
    return;
  }

  const namespace = process.env.AI_RUNS_SERVICEBUS_NAMESPACE?.trim();
  if (!namespace) {
    throw new Error(
      'AI_RUNS_SERVICEBUS_NAMESPACE is required to receive repo-checkout wakeups',
    );
  }
  const queueName =
    process.env.REPO_CHECKOUT_QUEUE_NAME?.trim() || DEFAULT_QUEUE_NAME;
  const credential = new DefaultAzureCredential();
  await receiveRepoCheckoutWakeup({
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

export async function main(): Promise<void> {
  await loadRepoCheckoutWakeup();
  const result = await processNextCheckoutJob();
  console.log(JSON.stringify({
    event: 'RepoCheckoutWorkerFinished',
    status: result?.status ?? 'idle',
    skillSettingsId: result?.skillSettingsId ?? null,
  }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: 'RepoCheckoutWorkerFatal',
      errorType: error instanceof Error ? error.name : 'UnknownError',
    }));
    process.exitCode = 1;
  });
}
