import { AUTH_STATUS_TIMEOUT_MS, fetchAuthStatus } from '../fetchAuthStatus';

describe('fetchAuthStatus', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('aborts the request after AUTH_STATUS_TIMEOUT_MS', async () => {
    global.fetch = jest.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const pending = fetchAuthStatus();
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    await jest.advanceTimersByTimeAsync(AUTH_STATUS_TIMEOUT_MS);

    await rejection;
    expect(global.fetch).toHaveBeenCalledWith(
      '/auth/status',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('does not abort when the response arrives in time', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ authenticated: false }),
    });

    const response = await fetchAuthStatus();
    expect(response.ok).toBe(true);
    await jest.advanceTimersByTimeAsync(AUTH_STATUS_TIMEOUT_MS);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
