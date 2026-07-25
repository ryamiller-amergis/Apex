/**
 * Service Bus dispatch publisher for load-test runs (FEAT-007).
 *
 * Uses the Azure Service Bus REST API + @azure/identity so we do not require
 * adding @azure/service-bus to package.json (protected without explicit permission).
 * Tests inject a mock publisher via setDispatchPublisher().
 */
import { DefaultAzureCredential } from '@azure/identity';
import type { LoadTestDispatchMessage } from '../../../shared/types/loadTest';

export type DispatchPublisher = {
  publish(message: LoadTestDispatchMessage): Promise<void>;
};

let injected: DispatchPublisher | null = null;

export function setDispatchPublisher(publisher: DispatchPublisher | null): void {
  injected = publisher;
}

export function getDispatchPublisher(): DispatchPublisher {
  if (injected) return injected;
  return createDefaultDispatchPublisher();
}

function createDefaultDispatchPublisher(): DispatchPublisher {
  return {
    async publish(message: LoadTestDispatchMessage): Promise<void> {
      const mode = (process.env.LT_DISPATCH_PUBLISHER || '').toLowerCase();
      if (mode === 'noop' || process.env.NODE_ENV === 'test') {
        return;
      }

      const namespace = process.env.LT_SERVICEBUS_NAMESPACE?.trim();
      const queue =
        process.env.LT_SERVICEBUS_QUEUE_NAME?.trim() ||
        process.env.LT_QUEUE_NAME?.trim() ||
        'lt-dispatch';

      if (!namespace) {
        throw new Error(
          'LT_SERVICEBUS_NAMESPACE is required to publish load-test dispatch messages',
        );
      }

      const credential = new DefaultAzureCredential();
      const token = await credential.getToken('https://servicebus.azure.net/.default');
      if (!token?.token) {
        throw new Error('Failed to acquire Service Bus access token for load-test dispatch');
      }

      const host = namespace.includes('.')
        ? namespace
        : `${namespace}.servicebus.windows.net`;
      const url = `https://${host}/${encodeURIComponent(queue)}/messages`;

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.token}`,
          'Content-Type': 'application/json',
          BrokerProperties: JSON.stringify({ MessageId: message.dispatchMessageId }),
        },
        body: JSON.stringify(message),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `Service Bus publish failed (${res.status}): ${body || res.statusText}`,
        );
      }
    },
  };
}

export function resolveCallbackBaseUrl(): string {
  const base =
    process.env.LT_APEX_CALLBACK_BASE_URL?.trim() ||
    process.env.APEX_CALLBACK_URL?.trim() ||
    process.env.APP_BASE_URL?.trim() ||
    '';
  return base.replace(/\/+$/, '');
}
