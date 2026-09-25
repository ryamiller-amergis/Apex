const mockGetToken = jest.fn();
const mockAzureCliCredential = jest.fn().mockImplementation(() => ({
  getToken: mockGetToken,
}));
const mockManagedIdentityCredential = jest.fn().mockImplementation(() => ({
  getToken: mockGetToken,
}));

jest.mock('@azure/identity', () => ({
  AzureCliCredential: mockAzureCliCredential,
  ManagedIdentityCredential: mockManagedIdentityCredential,
}));

import {
  createServiceBusCredential,
  getServiceBusPublisher,
  resetServiceBusCredentialCache,
  setServiceBusPublisher,
} from '../services/serviceBusPublisher';
import type { DispatchMessage } from '../../shared/types/agentRunAdmission';

const sampleMessage: DispatchMessage = {
  runId: 'run-1',
  dispatchMessageId: 'dispatch-1',
};

describe('serviceBusPublisher', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalNamespace = process.env.AI_RUNS_SERVICEBUS_NAMESPACE;
  const originalQueueName = process.env.AI_RUNS_BACKGROUND_QUEUE_NAME;
  const originalPublisher = process.env.AI_RUNS_DISPATCH_PUBLISHER;
  const originalAzureClientId = process.env.AZURE_CLIENT_ID;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    setServiceBusPublisher(null);
    resetServiceBusCredentialCache();
    delete process.env.AI_RUNS_SERVICEBUS_NAMESPACE;
    delete process.env.AI_RUNS_BACKGROUND_QUEUE_NAME;
    delete process.env.AI_RUNS_DISPATCH_PUBLISHER;
    mockGetToken.mockResolvedValue({
      token: 'test-token',
      expiresOnTimestamp: Date.now() + 60_000,
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      statusText: 'Created',
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    restoreEnv('AI_RUNS_SERVICEBUS_NAMESPACE', originalNamespace);
    restoreEnv('AI_RUNS_BACKGROUND_QUEUE_NAME', originalQueueName);
    restoreEnv('AI_RUNS_DISPATCH_PUBLISHER', originalPublisher);
    restoreEnv('AZURE_CLIENT_ID', originalAzureClientId);
    setServiceBusPublisher(null);
    global.fetch = originalFetch;
  });

  test('BR-006/VT-05/security: publishes exactly the payload-free contract and dispatch MessageId', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AI_RUNS_SERVICEBUS_NAMESPACE = 'sbns-apex-ai-dev';

    const runtimeMessage = {
      ...sampleMessage,
      prompt: 'never-publish-this-prompt',
      snapshot: { secret: 'never-publish-this-snapshot' },
      workspace: 'C:\\sensitive\\workspace',
      secret: 'CURSOR_API_KEY',
    } as DispatchMessage;

    await getServiceBusPublisher().publish(runtimeMessage);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, request] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'https://sbns-apex-ai-dev.servicebus.windows.net/ai-runs-background/messages'
    );
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body as string)).toEqual({
      runId: 'run-1',
      dispatchMessageId: 'dispatch-1',
    });
    expect(Object.keys(JSON.parse(request.body as string))).toEqual([
      'runId',
      'dispatchMessageId',
    ]);
    expect(request.headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        BrokerProperties: JSON.stringify({ MessageId: 'dispatch-1' }),
      })
    );
  });

  test('BR-006/security: uses Azure CLI credentials locally', () => {
    process.env.NODE_ENV = 'development';

    createServiceBusCredential();

    expect(mockAzureCliCredential).toHaveBeenCalledTimes(1);
    expect(mockManagedIdentityCredential).not.toHaveBeenCalled();
  });

  test('BR-006/security: uses managed identity credentials in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.AZURE_CLIENT_ID;

    createServiceBusCredential();

    expect(mockManagedIdentityCredential).toHaveBeenCalledTimes(1);
    expect(mockManagedIdentityCredential).toHaveBeenCalledWith();
    expect(mockAzureCliCredential).not.toHaveBeenCalled();
  });

  test('BR-006/security: uses AZURE_CLIENT_ID for user-assigned MI in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.AZURE_CLIENT_ID = '9737cad5-cec1-48e8-b072-5888738e3700';

    createServiceBusCredential();

    expect(mockManagedIdentityCredential).toHaveBeenCalledTimes(1);
    expect(mockManagedIdentityCredential).toHaveBeenCalledWith({
      clientId: '9737cad5-cec1-48e8-b072-5888738e3700',
    });
  });

  test('BR-006/security: fails deterministically when namespace is missing', async () => {
    process.env.NODE_ENV = 'production';

    await expect(
      getServiceBusPublisher().publish(sampleMessage)
    ).rejects.toThrow(
      'AI_RUNS_SERVICEBUS_NAMESPACE is required to publish AI run dispatch messages'
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('BR-006/security: honors the queue override', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AI_RUNS_SERVICEBUS_NAMESPACE =
      'sbns-apex-ai-dev.servicebus.windows.net';
    process.env.AI_RUNS_BACKGROUND_QUEUE_NAME = 'custom-ai-runs';

    await getServiceBusPublisher().publish(sampleMessage);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://sbns-apex-ai-dev.servicebus.windows.net/custom-ai-runs/messages',
      expect.any(Object)
    );
  });

  test('BR-006/security: noop mode does not require namespace or credentials', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AI_RUNS_DISPATCH_PUBLISHER = 'noop';

    await getServiceBusPublisher().publish(sampleMessage);

    expect(mockManagedIdentityCredential).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('BR-006/security: HTTP failures expose status without response content', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AI_RUNS_SERVICEBUS_NAMESPACE = 'sbns-apex-ai-dev';
    const readResponseBody = jest
      .fn()
      .mockResolvedValue('sensitive broker detail');
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: readResponseBody,
    }) as unknown as typeof fetch;

    let thrown: Error | undefined;
    try {
      await getServiceBusPublisher().publish(sampleMessage);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toBe('Service Bus publish failed (503)');
    expect(thrown?.message).not.toContain('sensitive broker detail');
    expect(readResponseBody).not.toHaveBeenCalled();
  });

  test('retries an authorization failure so a queue replacement does not strand the run', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AI_RUNS_SERVICEBUS_NAMESPACE = 'sbns-apex-ai-dev';
    mockGetToken
      .mockResolvedValueOnce({
        token: 'stale-token',
        expiresOnTimestamp: Date.now() + 60_000,
      })
      .mockResolvedValue({
        token: 'refreshed-token',
        expiresOnTimestamp: Date.now() + 60_000,
      });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })
      .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created' }) as unknown as typeof fetch;

    await expect(
      getServiceBusPublisher().publish(sampleMessage)
    ).resolves.toBeUndefined();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockGetToken).toHaveBeenCalledTimes(2);
    expect(mockManagedIdentityCredential).toHaveBeenCalledTimes(2);
    expect((global.fetch as jest.Mock).mock.calls[0][1].headers).toEqual(
      expect.objectContaining({ Authorization: 'Bearer stale-token' }),
    );
    expect((global.fetch as jest.Mock).mock.calls[1][1].headers).toEqual(
      expect.objectContaining({ Authorization: 'Bearer refreshed-token' }),
    );
    expect((global.fetch as jest.Mock).mock.calls[1][1])
      .not.toBe((global.fetch as jest.Mock).mock.calls[0][1]);
  });

  test('rebuilds retry requests while preserving the process credential after a transient failure', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AI_RUNS_SERVICEBUS_NAMESPACE = 'sbns-apex-ai-dev';
    mockGetToken
      .mockResolvedValueOnce({
        token: 'attempt-one-token',
        expiresOnTimestamp: Date.now() + 60_000,
      })
      .mockResolvedValue({
        token: 'attempt-two-token',
        expiresOnTimestamp: Date.now() + 60_000,
      });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Unavailable' })
      .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created' }) as unknown as typeof fetch;

    await expect(
      getServiceBusPublisher().publish(sampleMessage)
    ).resolves.toBeUndefined();

    expect(mockManagedIdentityCredential).toHaveBeenCalledTimes(1);
    expect(mockGetToken).toHaveBeenCalledTimes(2);
    expect((global.fetch as jest.Mock).mock.calls[0][1].headers).toEqual(
      expect.objectContaining({ Authorization: 'Bearer attempt-one-token' }),
    );
    expect((global.fetch as jest.Mock).mock.calls[1][1].headers).toEqual(
      expect.objectContaining({ Authorization: 'Bearer attempt-two-token' }),
    );
    expect((global.fetch as jest.Mock).mock.calls[1][1])
      .not.toBe((global.fetch as jest.Mock).mock.calls[0][1]);
  });

  test.each([
    { status: 401, statusText: 'Unauthorized' },
    { status: 403, statusText: 'Forbidden' },
  ])(
    'limits persistent $status authorization rejection to one credential refresh',
    async ({ status, statusText }) => {
      process.env.NODE_ENV = 'production';
      process.env.AI_RUNS_SERVICEBUS_NAMESPACE = 'sbns-apex-ai-dev';
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status,
        statusText,
      }) as unknown as typeof fetch;

      await expect(
        getServiceBusPublisher().publish(sampleMessage)
      ).rejects.toThrow(`Service Bus publish failed (${status})`);

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(mockGetToken).toHaveBeenCalledTimes(2);
      expect(mockManagedIdentityCredential).toHaveBeenCalledTimes(2);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 201,
        statusText: 'Created',
      }) as unknown as typeof fetch;
      await getServiceBusPublisher().publish(sampleMessage);

      expect(mockManagedIdentityCredential).toHaveBeenCalledTimes(3);
    },
  );

  test.each([
    { status: 429, statusText: 'Too Many Requests' },
    { status: 503, statusText: 'Service Unavailable' },
  ])(
    'preserves the three-attempt retry budget for $status responses',
    async ({ status, statusText }) => {
      process.env.NODE_ENV = 'production';
      process.env.AI_RUNS_SERVICEBUS_NAMESPACE = 'sbns-apex-ai-dev';
      mockGetToken
        .mockResolvedValueOnce({
          token: 'attempt-one-token',
          expiresOnTimestamp: Date.now() + 60_000,
        })
        .mockResolvedValueOnce({
          token: 'attempt-two-token',
          expiresOnTimestamp: Date.now() + 60_000,
        })
        .mockResolvedValue({
          token: 'attempt-three-token',
          expiresOnTimestamp: Date.now() + 60_000,
        });
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status,
        statusText,
      }) as unknown as typeof fetch;

      await expect(
        getServiceBusPublisher().publish(sampleMessage)
      ).rejects.toThrow(`Service Bus publish failed (${status})`);

      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(mockGetToken).toHaveBeenCalledTimes(3);
      expect(mockManagedIdentityCredential).toHaveBeenCalledTimes(1);
      const requests = (global.fetch as jest.Mock).mock.calls
        .map(([, request]) => request);
      expect(requests[1]).not.toBe(requests[0]);
      expect(requests[2]).not.toBe(requests[1]);
      expect(requests[2].headers).toEqual(
        expect.objectContaining({ Authorization: 'Bearer attempt-three-token' }),
      );
    },
  );

  test('does not retry a status the broker will keep rejecting', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AI_RUNS_SERVICEBUS_NAMESPACE = 'sbns-apex-ai-dev';
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
    }) as unknown as typeof fetch;

    await expect(
      getServiceBusPublisher().publish(sampleMessage)
    ).rejects.toThrow('Service Bus publish failed (400)');

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('reuses one credential across publishes so the token cache is used', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AI_RUNS_SERVICEBUS_NAMESPACE = 'sbns-apex-ai-dev';

    await getServiceBusPublisher().publish(sampleMessage);
    await getServiceBusPublisher().publish(sampleMessage);
    await getServiceBusPublisher().publish(sampleMessage);

    expect(mockManagedIdentityCredential).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
