/**
 * Payload-free Service Bus publisher for admitted AI runs.
 *
 * The publisher deliberately constructs the outbound contract rather than
 * serializing its input so runtime-only execution data cannot reach the queue.
 */
import { AzureCliCredential, ManagedIdentityCredential } from '@azure/identity';
import type { TokenCredential } from '@azure/identity';
import type { DispatchMessage } from '../../shared/types/agentRunAdmission';

const SERVICE_BUS_SCOPE = 'https://servicebus.azure.net/.default';
const DEFAULT_QUEUE_NAME = 'ai-runs-background';

export type ServiceBusPublisher = {
  publish(message: DispatchMessage): Promise<void>;
};

let injectedPublisher: ServiceBusPublisher | null = null;

export function setServiceBusPublisher(
  publisher: ServiceBusPublisher | null
): void {
  injectedPublisher = publisher;
}

export function getServiceBusPublisher(): ServiceBusPublisher {
  return injectedPublisher ?? createDefaultServiceBusPublisher();
}

/** Production uses the queue-scoped managed identity; local development uses Azure CLI. */
export function createServiceBusCredential(): TokenCredential {
  return process.env.NODE_ENV === 'production'
    ? new ManagedIdentityCredential()
    : new AzureCliCredential();
}

function createDefaultServiceBusPublisher(): ServiceBusPublisher {
  return {
    async publish(message: DispatchMessage): Promise<void> {
      const mode = process.env.AI_RUNS_DISPATCH_PUBLISHER?.trim().toLowerCase();
      if (mode === 'noop' || process.env.NODE_ENV === 'test') {
        return;
      }

      const namespace = process.env.AI_RUNS_SERVICEBUS_NAMESPACE?.trim();
      if (!namespace) {
        throw new Error(
          'AI_RUNS_SERVICEBUS_NAMESPACE is required to publish AI run dispatch messages'
        );
      }

      const token =
        await createServiceBusCredential().getToken(SERVICE_BUS_SCOPE);
      if (!token?.token) {
        throw new Error(
          'Failed to acquire Service Bus access token for AI run dispatch'
        );
      }

      const queueName =
        process.env.AI_RUNS_BACKGROUND_QUEUE_NAME?.trim() || DEFAULT_QUEUE_NAME;
      const host = namespace.includes('.')
        ? namespace
        : `${namespace}.servicebus.windows.net`;
      const url = `https://${host}/${encodeURIComponent(queueName)}/messages`;
      const body: DispatchMessage = {
        runId: message.runId,
        dispatchMessageId: message.dispatchMessageId,
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.token}`,
          'Content-Type': 'application/json',
          BrokerProperties: JSON.stringify({
            MessageId: message.dispatchMessageId,
          }),
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Service Bus publish failed (${response.status})`);
      }
    },
  };
}
