/**
 * Service Bus REST peek-lock consumer / command publisher for V2 queues.
 * Avoids adding @azure/service-bus; mirrors V1 serviceBusPublisher auth.
 */
import type { TokenCredential } from '@azure/identity';
import {
  createServiceBusCredential,
  resetServiceBusCredentialCache,
} from '../serviceBusPublisher';
import type { CommandPublisher, QueueConsumer } from './ports';
import type { CommandPublishRequest, PeekLockedMessage } from './types';

const SERVICE_BUS_SCOPE = 'https://servicebus.azure.net/.default';

function resolveHost(namespace: string): string {
  return namespace.includes('.')
    ? namespace
    : `${namespace}.servicebus.windows.net`;
}

async function getToken(credential: TokenCredential): Promise<string> {
  const token = await credential.getToken(SERVICE_BUS_SCOPE);
  if (!token?.token) {
    throw new Error('Failed to acquire Service Bus access token');
  }
  return token.token;
}

function parseBrokerProperties(
  header: string | null,
): { lockToken?: string; messageId?: string; deliveryCount?: number } {
  if (!header) return {};
  try {
    const parsed = JSON.parse(header) as Record<string, unknown>;
    return {
      lockToken:
        typeof parsed.LockToken === 'string'
          ? parsed.LockToken
          : typeof parsed.lockToken === 'string'
            ? parsed.lockToken
            : undefined,
      messageId:
        typeof parsed.MessageId === 'string'
          ? parsed.MessageId
          : typeof parsed.messageId === 'string'
            ? parsed.messageId
            : undefined,
      deliveryCount:
        typeof parsed.DeliveryCount === 'number'
          ? parsed.DeliveryCount
          : typeof parsed.deliveryCount === 'number'
            ? parsed.deliveryCount
            : undefined,
    };
  } catch {
    return {};
  }
}

export type ServiceBusRestOptions = Readonly<{
  namespace: string;
  queueName: string;
  credential?: TokenCredential;
  fetchImpl?: typeof fetch;
  noop?: boolean;
}>;

export function createServiceBusRestCommandPublisher(
  options: ServiceBusRestOptions,
): CommandPublisher {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async publish(request: CommandPublishRequest): Promise<void> {
      if (options.noop || process.env.NODE_ENV === 'test') {
        return;
      }
      const host = resolveHost(options.namespace);
      const queue = request.queueName || options.queueName;
      const url = `https://${host}/${encodeURIComponent(queue)}/messages`;
      const credential = options.credential ?? createServiceBusCredential();
      const token = await getToken(credential);
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          BrokerProperties: JSON.stringify({ MessageId: request.messageId }),
        },
        body: JSON.stringify(request.body),
      });
      if (response.status === 401 || response.status === 403) {
        resetServiceBusCredentialCache();
      }
      if (!response.ok) {
        throw new Error(`Service Bus publish failed (${response.status})`);
      }
    },
  };
}

export function createServiceBusRestQueueConsumer(
  options: ServiceBusRestOptions,
): QueueConsumer {
  const fetchImpl = options.fetchImpl ?? fetch;
  const host = resolveHost(options.namespace);
  const queue = options.queueName;
  const credential = options.credential ?? createServiceBusCredential();

  async function authorized(
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    const token = await getToken(credential);
    const url = `https://${host}/${encodeURIComponent(queue)}/${path}`;
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });
    if (response.status === 401 || response.status === 403) {
      resetServiceBusCredentialCache();
    }
    return response;
  }

  return {
    async receive(receiveOptions): Promise<PeekLockedMessage | null> {
      if (options.noop || process.env.NODE_ENV === 'test') {
        return null;
      }
      const timeout = receiveOptions?.timeoutSeconds ?? 30;
      const response = await authorized(
        `messages/head?timeout=${timeout}`,
        { method: 'POST' },
      );
      if (response.status === 204 || response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`Service Bus peek-lock failed (${response.status})`);
      }
      const broker = parseBrokerProperties(
        response.headers.get('BrokerProperties'),
      );
      if (!broker.lockToken) {
        throw new Error('Service Bus peek-lock response missing LockToken');
      }
      const body = (await response.json()) as Record<string, unknown>;
      return {
        lockToken: broker.lockToken,
        messageId: broker.messageId ?? '',
        body,
        deliveryCount: broker.deliveryCount ?? 1,
      };
    },

    async complete(lockToken: string): Promise<void> {
      if (options.noop || process.env.NODE_ENV === 'test') return;
      const response = await authorized(
        `messages/${encodeURIComponent(lockToken)}`,
        { method: 'DELETE' },
      );
      if (!response.ok && response.status !== 404) {
        throw new Error(`Service Bus complete failed (${response.status})`);
      }
    },

    async abandon(lockToken: string): Promise<void> {
      if (options.noop || process.env.NODE_ENV === 'test') return;
      const response = await authorized(
        `messages/${encodeURIComponent(lockToken)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      if (!response.ok && response.status !== 404) {
        throw new Error(`Service Bus abandon failed (${response.status})`);
      }
    },

    async deadLetter(
      lockToken: string,
      reason: string,
      description?: string,
    ): Promise<void> {
      if (options.noop || process.env.NODE_ENV === 'test') return;
      const response = await authorized(
        `messages/${encodeURIComponent(lockToken)}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            BrokerProperties: JSON.stringify({
              DeadLetterReason: reason,
              DeadLetterErrorDescription: description ?? reason,
            }),
          },
          body: JSON.stringify({}),
        },
      );
      if (!response.ok && response.status !== 404) {
        throw new Error(`Service Bus dead-letter failed (${response.status})`);
      }
    },
  };
}
