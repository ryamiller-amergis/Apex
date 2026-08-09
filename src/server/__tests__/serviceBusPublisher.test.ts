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
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    setServiceBusPublisher(null);
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

    createServiceBusCredential();

    expect(mockManagedIdentityCredential).toHaveBeenCalledTimes(1);
    expect(mockAzureCliCredential).not.toHaveBeenCalled();
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
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
