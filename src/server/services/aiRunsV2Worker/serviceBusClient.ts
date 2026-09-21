/**
 * Worker-side Service Bus transport for the V2 lanes.
 *
 * Deliberately self-contained: a worker process must not import anything that
 * reaches PostgreSQL, so this does not share the orchestrator's client.
 */
import type { TokenCredential } from '@azure/identity';
import {
  createServiceBusCredential,
  resetServiceBusCredentialCache,
} from '../serviceBusPublisher';

const SERVICE_BUS_SCOPE = 'https://servicebus.azure.net/.default';

export type WorkerPeekLockedMessage = Readonly<{
  lockToken: string;
  messageId: string;
  body: Record<string, unknown>;
  deliveryCount: number;
}>;

export type WorkerServiceBusOptions = Readonly<{
  namespace: string;
  commandQueue: string;
  checkpointQueue: string;
  resultQueue: string;
  credential?: TokenCredential;
  fetchImpl?: typeof fetch;
  /** Skip every network call — used by tests and by local dry runs. */
  noop?: boolean;
}>;

export type WorkerServiceBusClient = {
  receiveCommand(options?: {
    timeoutSeconds?: number;
  }): Promise<WorkerPeekLockedMessage | null>;
  completeCommand(lockToken: string): Promise<void>;
  abandonCommand(lockToken: string): Promise<void>;
  deadLetterCommand(
    lockToken: string,
    reason: string,
    detail: string,
  ): Promise<void>;
  sendCheckpoint(messageId: string, body: unknown): Promise<void>;
  sendResult(messageId: string, body: unknown): Promise<void>;
};

function resolveHost(namespace: string): string {
  return namespace.includes('.')
    ? namespace
    : `${namespace}.servicebus.windows.net`;
}

function parseBrokerProperties(header: string | null): {
  lockToken?: string;
  messageId?: string;
  deliveryCount?: number;
} {
  if (!header) return {};
  try {
    const parsed = JSON.parse(header) as Record<string, unknown>;
    return {
      lockToken:
        typeof parsed.LockToken === 'string' ? parsed.LockToken : undefined,
      messageId:
        typeof parsed.MessageId === 'string' ? parsed.MessageId : undefined,
      deliveryCount:
        typeof parsed.DeliveryCount === 'number'
          ? parsed.DeliveryCount
          : undefined,
    };
  } catch {
    return {};
  }
}

export function createWorkerServiceBusClient(
  options: WorkerServiceBusOptions,
): WorkerServiceBusClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const host = resolveHost(options.namespace);
  const credential = options.credential ?? createServiceBusCredential();
  const inert = options.noop || process.env.NODE_ENV === 'test';

  async function authorized(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const token = await credential.getToken(SERVICE_BUS_SCOPE);
    if (!token?.token) {
      throw new Error('Failed to acquire Service Bus access token');
    }
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${token.token}`,
      },
    });
    if (response.status === 401 || response.status === 403) {
      resetServiceBusCredentialCache();
    }
    return response;
  }

  function lockUrl(lockToken: string): string {
    return `https://${host}/${encodeURIComponent(
      options.commandQueue,
    )}/messages/${encodeURIComponent(lockToken)}/${encodeURIComponent(
      lockToken,
    )}`;
  }

  async function send(
    queueName: string,
    messageId: string,
    body: unknown,
  ): Promise<void> {
    if (inert) return;
    const response = await authorized(
      `https://${host}/${encodeURIComponent(queueName)}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          BrokerProperties: JSON.stringify({ MessageId: messageId }),
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Service Bus send to ${queueName} failed (${response.status})`,
      );
    }
  }

  return {
    async receiveCommand(receiveOptions) {
      if (inert) return null;
      const timeout = receiveOptions?.timeoutSeconds ?? 30;
      const response = await authorized(
        `https://${host}/${encodeURIComponent(
          options.commandQueue,
        )}/messages/head?timeout=${timeout}`,
        { method: 'POST' },
      );
      if (response.status === 204) return null;
      if (!response.ok) {
        throw new Error(`Service Bus receive failed (${response.status})`);
      }
      const broker = parseBrokerProperties(
        response.headers.get('BrokerProperties'),
      );
      if (!broker.lockToken) {
        throw new Error('Service Bus receive returned no lock token');
      }
      const text = await response.text();
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = {};
      }
      return {
        lockToken: broker.lockToken,
        messageId: broker.messageId ?? broker.lockToken,
        body,
        deliveryCount: broker.deliveryCount ?? 1,
      };
    },

    async completeCommand(lockToken) {
      if (inert) return;
      const response = await authorized(lockUrl(lockToken), {
        method: 'DELETE',
      });
      if (!response.ok) {
        throw new Error(`Service Bus complete failed (${response.status})`);
      }
    },

    async abandonCommand(lockToken) {
      if (inert) return;
      const response = await authorized(lockUrl(lockToken), { method: 'PUT' });
      if (!response.ok) {
        throw new Error(`Service Bus abandon failed (${response.status})`);
      }
    },

    async deadLetterCommand(lockToken, reason, detail) {
      if (inert) return;
      const response = await authorized(`${lockUrl(lockToken)}?deadletter`, {
        method: 'PUT',
        headers: {
          DeadLetterReason: reason,
          DeadLetterErrorDescription: detail,
        },
      });
      if (!response.ok) {
        throw new Error(`Service Bus dead-letter failed (${response.status})`);
      }
    },

    sendCheckpoint(messageId, body) {
      return send(options.checkpointQueue, messageId, body);
    },

    sendResult(messageId, body) {
      return send(options.resultQueue, messageId, body);
    },
  };
}
