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

const PUBLISH_MAX_ATTEMPTS = 3;
const PUBLISH_RETRY_BASE_MS = 200;

/**
 * Transient broker statuses worth another attempt inside a single publish call.
 *
 * Retrying is safe because the queue requires duplicate detection: a repeat
 * carrying the same MessageId inside the history window is dropped by the
 * broker rather than delivered twice.
 */
const RETRYABLE_PUBLISH_STATUSES = new Set([
  408, 429, 500, 502, 503, 504,
]);

export type ServiceBusPublisher = {
  publish(message: DispatchMessage): Promise<void>;
};

let injectedPublisher: ServiceBusPublisher | null = null;
let cachedCredential: TokenCredential | null = null;

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

/**
 * Reuse one credential while authentication succeeds.
 *
 * `@azure/identity` caches tokens per credential instance, so building a new
 * one per publish sends an IMDS request every time. The recovery sweep
 * publishes once per cycle per stale run on every instance, which turned into
 * 721 token requests in 48 minutes during the incident this guards against.
 * A broker 401/403 clears this instance so the next bounded retry cannot reuse
 * the rejected credential/token cache.
 */
function getCachedServiceBusCredential(): TokenCredential {
  cachedCredential ??= createServiceBusCredential();
  return cachedCredential;
}

/** Drops the cached credential so tests can assert construction. */
export function resetServiceBusCredentialCache(): void {
  cachedCredential = null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

      let lastStatus = 0;
      let authorizationRefreshAttempted = false;
      for (let attempt = 1; attempt <= PUBLISH_MAX_ATTEMPTS; attempt += 1) {
        const token =
          await getCachedServiceBusCredential().getToken(SERVICE_BUS_SCOPE);
        if (!token?.token) {
          throw new Error(
            'Failed to acquire Service Bus access token for AI run dispatch'
          );
        }
        const request: RequestInit = {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token.token}`,
            'Content-Type': 'application/json',
            BrokerProperties: JSON.stringify({
              MessageId: message.dispatchMessageId,
            }),
          },
          body: JSON.stringify(body),
        };
        const response = await fetch(url, request);
        if (response.ok) {
          return;
        }

        lastStatus = response.status;
        if (response.status === 401 || response.status === 403) {
          resetServiceBusCredentialCache();
          if (
            authorizationRefreshAttempted
            || attempt >= PUBLISH_MAX_ATTEMPTS
          ) {
            break;
          }
          authorizationRefreshAttempted = true;
          await delay(PUBLISH_RETRY_BASE_MS * attempt);
          continue;
        }
        if (
          !RETRYABLE_PUBLISH_STATUSES.has(response.status)
          || attempt >= PUBLISH_MAX_ATTEMPTS
        ) {
          break;
        }
        await delay(PUBLISH_RETRY_BASE_MS * attempt);
      }

      throw new Error(`Service Bus publish failed (${lastStatus})`);
    },
  };
}
