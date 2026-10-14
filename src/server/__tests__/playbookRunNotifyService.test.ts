const connect = jest.fn();
const poolQuery = jest.fn();

jest.mock('../db', () => ({
  __esModule: true,
  default: {
    connect: (...args: unknown[]) => connect(...args),
    query: (...args: unknown[]) => poolQuery(...args),
  },
}));

function mockClient(query: jest.Mock) {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    query,
    release: jest.fn(),
    on(event: string, callback: (...args: unknown[]) => void) {
      const list = handlers.get(event) ?? [];
      list.push(callback);
      handlers.set(event, list);
    },
    removeAllListeners(event: string) {
      handlers.delete(event);
    },
    emit(event: string) {
      for (const callback of [...(handlers.get(event) ?? [])]) callback();
    },
  };
}

function loadService() {
  let loaded: typeof import('../services/playbookRunNotifyService') | undefined;
  jest.isolateModules(() => {
    loaded = jest.requireActual('../services/playbookRunNotifyService');
  });
  return loaded!;
}

describe('playbook run notify listener', () => {
  beforeEach(() => {
    connect.mockReset();
    poolQuery.mockReset();
  });

  it('releases the client when LISTEN fails so the next attempt can connect', async () => {
    const { ensurePlaybookRunNotifyListener, shutdownPlaybookRunNotify } = loadService();
    const client = mockClient(jest.fn().mockRejectedValue(new Error('listen failed')));
    connect.mockResolvedValue(client);

    await expect(ensurePlaybookRunNotifyListener()).rejects.toThrow('listen failed');
    expect(client.release).toHaveBeenCalledTimes(1);

    const retry = mockClient(jest.fn().mockResolvedValue({}));
    connect.mockResolvedValue(retry);
    await ensurePlaybookRunNotifyListener();
    expect(connect).toHaveBeenCalledTimes(2);
    await shutdownPlaybookRunNotify();
    expect(retry.release).toHaveBeenCalledTimes(1);
  });

  it('releases the client when the connection errors', async () => {
    jest.useFakeTimers();
    const { ensurePlaybookRunNotifyListener, shutdownPlaybookRunNotify } = loadService();
    const client = mockClient(jest.fn().mockResolvedValue({}));
    connect.mockResolvedValue(client);

    await ensurePlaybookRunNotifyListener();
    client.emit('error');

    expect(client.release).toHaveBeenCalledTimes(1);
    const replacement = mockClient(jest.fn().mockResolvedValue({}));
    connect.mockResolvedValue(replacement);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(connect).toHaveBeenCalledTimes(2);

    await shutdownPlaybookRunNotify();
    expect(replacement.release).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});
