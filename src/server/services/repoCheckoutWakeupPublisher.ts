/**
 * Payload-free Service Bus wakeup for the repo-checkout Container Apps Job.
 * Postgres owns job state; the message only starts a replica.
 */
import { createServiceBusCredential } from './serviceBusPublisher';

const SERVICE_BUS_SCOPE = 'https://servicebus.azure.net/.default';
const DEFAULT_QUEUE_NAME = 'repo-checkout';

export type RepoCheckoutWakeupPublisher = {
  publish(jobId: string): Promise<void>;
};

let injectedPublisher: RepoCheckoutWakeupPublisher | null = null;

export function setRepoCheckoutWakeupPublisher(
  publisher: RepoCheckoutWakeupPublisher | null,
): void {
  injectedPublisher = publisher;
}

export function getRepoCheckoutWakeupPublisher(): RepoCheckoutWakeupPublisher {
  return injectedPublisher ?? createDefaultRepoCheckoutWakeupPublisher();
}

function createDefaultRepoCheckoutWakeupPublisher(): RepoCheckoutWakeupPublisher {
  return {
    async publish(jobId: string): Promise<void> {
      if (process.env.NODE_ENV === 'test') return;

      const namespace = process.env.AI_RUNS_SERVICEBUS_NAMESPACE?.trim();
      if (!namespace) {
        throw new Error(
          'AI_RUNS_SERVICEBUS_NAMESPACE is required to wake the repo-checkout worker',
        );
      }

      const token = await createServiceBusCredential().getToken(SERVICE_BUS_SCOPE);
      if (!token?.token) {
        throw new Error('Failed to acquire Service Bus access token for repo-checkout wakeup');
      }

      const queueName =
        process.env.REPO_CHECKOUT_QUEUE_NAME?.trim() || DEFAULT_QUEUE_NAME;
      const host = namespace.includes('.')
        ? namespace
        : `${namespace}.servicebus.windows.net`;
      const url = `https://${host}/${encodeURIComponent(queueName)}/messages`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.token}`,
          'Content-Type': 'application/json',
          BrokerProperties: JSON.stringify({ MessageId: jobId }),
        },
        body: '{}',
      });

      if (!response.ok) {
        throw new Error(`Service Bus publish failed (${response.status})`);
      }
    },
  };
}
