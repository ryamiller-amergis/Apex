const mockGetToken = jest.fn();
const mockManagedIdentityCredential = jest.fn().mockImplementation(() => ({
  getToken: mockGetToken,
}));

jest.mock('@azure/identity', () => ({
  ManagedIdentityCredential: mockManagedIdentityCredential,
}));

import {
  __resetAiRunnerCallbackTokenStateForTests,
  getAiRunnerCallbackToken,
} from '../services/aiRunsCallbackToken';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv(): void {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.AI_RUNS_CALLBACK_TOKEN_AUDIENCE;
  delete process.env.AI_RUNS_RUNNER_CALLBACK_TOKEN;
  delete process.env.AI_RUNS_ALLOW_STATIC_CALLBACK_TOKEN;
  delete process.env.AZURE_CLIENT_ID;
}

describe('getAiRunnerCallbackToken', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    restoreEnv();
    __resetAiRunnerCallbackTokenStateForTests();
    mockGetToken.mockResolvedValue({
      token: 'mi-jwt',
      expiresOnTimestamp: Date.now() + 3_600_000,
    });
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('uses managed identity getToken(scope) when audience is set and ignores static env', async () => {
    process.env.AI_RUNS_CALLBACK_TOKEN_AUDIENCE = 'api://apex';
    process.env.AI_RUNS_RUNNER_CALLBACK_TOKEN = 'static-secret';
    process.env.NODE_ENV = 'development';
    process.env.AZURE_CLIENT_ID = 'uami-1';

    await expect(getAiRunnerCallbackToken()).resolves.toBe('mi-jwt');

    expect(mockManagedIdentityCredential).toHaveBeenCalledWith({ clientId: 'uami-1' });
    expect(mockGetToken).toHaveBeenCalledWith('api://apex/.default');
  });

  it('reuses the credential instance and cached JWT across calls', async () => {
    process.env.AI_RUNS_CALLBACK_TOKEN_AUDIENCE = 'api://apex';

    await expect(getAiRunnerCallbackToken()).resolves.toBe('mi-jwt');
    await expect(getAiRunnerCallbackToken()).resolves.toBe('mi-jwt');

    expect(mockManagedIdentityCredential).toHaveBeenCalledTimes(1);
    expect(mockGetToken).toHaveBeenCalledTimes(1);
  });

  it('throws when the credential fails and does not return the static token', async () => {
    process.env.AI_RUNS_CALLBACK_TOKEN_AUDIENCE = 'api://apex';
    process.env.AI_RUNS_RUNNER_CALLBACK_TOKEN = 'static-secret';
    process.env.NODE_ENV = 'development';
    mockGetToken.mockRejectedValue(new Error('IMDS credential unavailable'));

    await expect(getAiRunnerCallbackToken()).rejects.toThrow(
      'IMDS credential unavailable',
    );
  });

  it('throws when the credential returns an empty token and does not return static', async () => {
    process.env.AI_RUNS_CALLBACK_TOKEN_AUDIENCE = 'api://apex';
    process.env.AI_RUNS_RUNNER_CALLBACK_TOKEN = 'static-secret';
    process.env.NODE_ENV = 'development';
    mockGetToken.mockResolvedValue({
      token: '',
      expiresOnTimestamp: Date.now() + 3_600_000,
    });

    await expect(getAiRunnerCallbackToken()).rejects.toThrow(
      'Managed identity returned an empty AI runner callback token',
    );
  });

  it('returns the static token when audience is unset and static is allowed', async () => {
    process.env.NODE_ENV = 'development';
    process.env.AI_RUNS_RUNNER_CALLBACK_TOKEN = 'static-secret';
    delete process.env.AI_RUNS_CALLBACK_TOKEN_AUDIENCE;

    await expect(getAiRunnerCallbackToken()).resolves.toBe('static-secret');
    expect(mockManagedIdentityCredential).not.toHaveBeenCalled();
  });

  it('returns the static token in production only when the allow flag is set', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AI_RUNS_RUNNER_CALLBACK_TOKEN = 'static-secret';
    process.env.AI_RUNS_ALLOW_STATIC_CALLBACK_TOKEN = 'true';
    delete process.env.AI_RUNS_CALLBACK_TOKEN_AUDIENCE;

    await expect(getAiRunnerCallbackToken()).resolves.toBe('static-secret');
    expect(mockManagedIdentityCredential).not.toHaveBeenCalled();
  });

  it('retries transient getToken failures then succeeds', async () => {
    process.env.AI_RUNS_CALLBACK_TOKEN_AUDIENCE = 'api://apex';
    const timeout = Object.assign(new Error('IMDS timeout'), { code: 'ETIMEDOUT' });
    mockGetToken
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({
        token: 'mi-jwt-after-retry',
        expiresOnTimestamp: Date.now() + 3_600_000,
      });

    await expect(getAiRunnerCallbackToken()).resolves.toBe('mi-jwt-after-retry');
    expect(mockGetToken).toHaveBeenCalledTimes(2);
  });

  it('forceRefresh skips the local cache and recreates the credential', async () => {
    process.env.AI_RUNS_CALLBACK_TOKEN_AUDIENCE = 'api://apex';
    mockGetToken
      .mockResolvedValueOnce({
        token: 'first-jwt',
        expiresOnTimestamp: Date.now() + 3_600_000,
      })
      .mockResolvedValueOnce({
        token: 'second-jwt',
        expiresOnTimestamp: Date.now() + 3_600_000,
      });

    await expect(getAiRunnerCallbackToken()).resolves.toBe('first-jwt');
    await expect(getAiRunnerCallbackToken({ forceRefresh: true })).resolves.toBe(
      'second-jwt',
    );
    expect(mockManagedIdentityCredential).toHaveBeenCalledTimes(2);
    expect(mockGetToken).toHaveBeenCalledTimes(2);
  });
});
