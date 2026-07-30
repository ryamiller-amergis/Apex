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
  createDispatchCredential,
  getDispatchPublisher,
  setDispatchPublisher,
} from '../services/loadTestRunService/dispatchPublisher';
import type { LoadTestDispatchMessage } from '../../shared/types/loadTest';

const sampleMessage: LoadTestDispatchMessage = {
  dispatchMessageId: 'msg-1',
  projectId: 'proj-1',
  runId: 'run-1',
  definitionId: 'def-1',
  targetUrl: 'https://example.test/api',
  environment: 'nonprod',
  script: 'export default function () {}',
  loadProfile: { vus: 1, durationMinutes: 1 },
  clientThresholds: [{ metric: 'http_req_failed', expression: 'rate<0.01' }],
  secretRefs: {},
  callbackBaseUrl: 'https://app-scrum-dev.azurewebsites.net',
};

describe('dispatchPublisher', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalNamespace = process.env.LT_SERVICEBUS_NAMESPACE;
  const originalPublisher = process.env.LT_DISPATCH_PUBLISHER;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    setDispatchPublisher(null);
    delete process.env.LT_DISPATCH_PUBLISHER;
    delete process.env.LT_SERVICEBUS_NAMESPACE;
    mockGetToken.mockResolvedValue({ token: 'test-token', expiresOnTimestamp: Date.now() + 60_000 });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => '',
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalNamespace === undefined) delete process.env.LT_SERVICEBUS_NAMESPACE;
    else process.env.LT_SERVICEBUS_NAMESPACE = originalNamespace;
    if (originalPublisher === undefined) delete process.env.LT_DISPATCH_PUBLISHER;
    else process.env.LT_DISPATCH_PUBLISHER = originalPublisher;
    setDispatchPublisher(null);
    global.fetch = originalFetch;
  });

  test('uses Azure CLI credentials outside production', () => {
    process.env.NODE_ENV = 'development';

    createDispatchCredential();

    expect(mockAzureCliCredential).toHaveBeenCalledTimes(1);
    expect(mockManagedIdentityCredential).not.toHaveBeenCalled();
  });

  test('uses managed identity credentials in production (not AZURE_CLIENT_* SP)', () => {
    process.env.NODE_ENV = 'production';

    createDispatchCredential();

    expect(mockManagedIdentityCredential).toHaveBeenCalledTimes(1);
    expect(mockAzureCliCredential).not.toHaveBeenCalled();
  });

  test('publish in production posts with MI token and requires namespace', async () => {
    process.env.NODE_ENV = 'production';
    process.env.LT_SERVICEBUS_NAMESPACE = 'sbns-apex-lt-dev';

    await getDispatchPublisher().publish(sampleMessage);

    expect(mockManagedIdentityCredential).toHaveBeenCalledTimes(1);
    expect(mockGetToken).toHaveBeenCalledWith('https://servicebus.azure.net/.default');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://sbns-apex-lt-dev.servicebus.windows.net/lt-dispatch/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
  });

  test('publish throws when namespace is missing outside test/noop', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.LT_SERVICEBUS_NAMESPACE;

    await expect(getDispatchPublisher().publish(sampleMessage)).rejects.toThrow(
      'LT_SERVICEBUS_NAMESPACE is required to publish load-test dispatch messages',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('publish is a no-op when LT_DISPATCH_PUBLISHER=noop', async () => {
    process.env.NODE_ENV = 'production';
    process.env.LT_DISPATCH_PUBLISHER = 'noop';
    process.env.LT_SERVICEBUS_NAMESPACE = 'sbns-apex-lt-dev';

    await getDispatchPublisher().publish(sampleMessage);

    expect(mockManagedIdentityCredential).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
