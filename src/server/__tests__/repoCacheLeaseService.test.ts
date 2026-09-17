import {
  type RepoCacheLeaseStore,
  tryAcquireRepoCacheLease,
  withRepoCacheLease,
} from '../services/repoCacheLeaseService';

function createStore(acquireResults: boolean[] = [true]): RepoCacheLeaseStore {
  let generation = 0;
  return {
    tryAcquire: jest.fn().mockImplementation(async () => {
      const acquired = acquireResults.shift() ?? true;
      generation += acquired ? 1 : 0;
      return acquired ? generation : null;
    }),
    renew: jest.fn().mockResolvedValue(true),
    release: jest.fn().mockResolvedValue(undefined),
  };
}

describe('withRepoCacheLease', () => {
  it('acquires, renews, and releases a lease around the operation', async () => {
    jest.useFakeTimers();
    const store = createStore();
    const operation = jest.fn().mockImplementation(async () => {
      await jest.advanceTimersByTimeAsync(25);
      return 'done';
    });

    const result = await withRepoCacheLease('ado:maxview:development', operation, {
      ownerId: 'instance-1',
      leaseMs: 30,
      heartbeatMs: 10,
      pollMs: 1,
      waitMs: 100,
      store,
    });

    expect(result).toBe('done');
    expect(store.tryAcquire).toHaveBeenCalledWith(
      'ado:maxview:development',
      'instance-1',
      30,
    );
    expect(store.renew).toHaveBeenCalled();
    expect(store.release).toHaveBeenCalledWith('ado:maxview:development', 'instance-1', 1);
    jest.useRealTimers();
  });

  it('waits for another owner before acquiring the lease', async () => {
    const store = createStore([false, false, true]);

    await expect(withRepoCacheLease('github:apex:main', async () => 'ready', {
      ownerId: 'instance-2',
      leaseMs: 1_000,
      heartbeatMs: 500,
      pollMs: 1,
      waitMs: 100,
      store,
    })).resolves.toBe('ready');

    expect(store.tryAcquire).toHaveBeenCalledTimes(3);
  });

  it('times out cleanly when the lease remains owned elsewhere', async () => {
    const store = createStore([false, false, false, false, false]);

    await expect(withRepoCacheLease('ado:maxview:development', async () => 'never', {
      ownerId: 'instance-3',
      leaseMs: 1_000,
      heartbeatMs: 500,
      pollMs: 2,
      waitMs: 5,
      store,
    })).rejects.toThrow('Timed out waiting for repository cache lease');

    expect(store.release).not.toHaveBeenCalled();
  });

  it('releases the lease when the protected operation fails', async () => {
    const store = createStore();

    await expect(withRepoCacheLease('ado:maxview:development', async () => {
      throw new Error('clone failed');
    }, {
      ownerId: 'instance-4',
      leaseMs: 1_000,
      heartbeatMs: 500,
      pollMs: 1,
      waitMs: 100,
      store,
    })).rejects.toThrow('clone failed');

    expect(store.release).toHaveBeenCalledWith('ado:maxview:development', 'instance-4', 1);
  });

  it('aborts the protected operation when lease renewal loses ownership', async () => {
    jest.useFakeTimers();
    const store = createStore();
    (store.renew as jest.Mock).mockResolvedValue(false);

    const protectedWork = withRepoCacheLease(
      'ado:maxview:development',
      async ({ signal }) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          setTimeout(resolve, 1_000);
        });
      },
      {
        ownerId: 'instance-5',
        leaseMs: 30,
        heartbeatMs: 10,
        pollMs: 1,
        waitMs: 100,
        store,
      },
    );
    const rejection = expect(protectedWork).rejects.toThrow('Repository cache lease was lost');

    await jest.advanceTimersByTimeAsync(11);

    await rejection;
    jest.useRealTimers();
  });
  it('can preserve a scheduler lease until expiry after work completes', async () => {
    const store = createStore([true]);

    await expect(withRepoCacheLease(
      'grounding-maintenance:sweep',
      async () => 'done',
      {
        ownerId: 'instance-1',
        leaseMs: 295_000,
        releaseOnComplete: false,
        store,
      },
    )).resolves.toBe('done');

    expect(store.tryAcquire).toHaveBeenCalledWith(
      'grounding-maintenance:sweep',
      'instance-1',
      295_000,
    );
    expect(store.release).not.toHaveBeenCalled();
  });
});

describe('tryAcquireRepoCacheLease', () => {
  it('returns null immediately for a non-blocking loser', async () => {
    const store = createStore([false]);

    await expect(tryAcquireRepoCacheLease('watcher:doc-1:thread-1', {
      ownerId: 'instance-1',
      leaseMs: 30_000,
      heartbeatMs: 10_000,
      waitMs: 0,
      store,
    })).resolves.toBeNull();

    expect(store.tryAcquire).toHaveBeenCalledTimes(1);
    expect(store.renew).not.toHaveBeenCalled();
    expect(store.release).not.toHaveBeenCalled();
  });

  it('renews until released after a successful non-blocking acquire', async () => {
    jest.useFakeTimers();
    const store = createStore([true]);

    const lease = await tryAcquireRepoCacheLease('watcher:doc-2:thread-2', {
      ownerId: 'instance-2',
      leaseMs: 30,
      heartbeatMs: 10,
      waitMs: 0,
      store,
    });

    expect(lease).not.toBeNull();
    await jest.advanceTimersByTimeAsync(11);
    expect(store.renew).toHaveBeenCalledTimes(1);

    await lease!.release();
    expect(store.release).toHaveBeenCalledWith('watcher:doc-2:thread-2', 'instance-2', 1);
    jest.useRealTimers();
  });

  it('stops the heartbeat immediately after renewal loses ownership', async () => {
    jest.useFakeTimers();
    const store = createStore([true]);
    (store.renew as jest.Mock).mockResolvedValue(false);

    const lease = await tryAcquireRepoCacheLease('watcher:doc-3:thread-3', {
      ownerId: 'instance-3',
      leaseMs: 30,
      heartbeatMs: 10,
      renewTimeoutMs: 10,
      waitMs: 0,
      store,
    });

    expect(lease).not.toBeNull();
    await jest.advanceTimersByTimeAsync(11);
    await expect(lease!.assertOwned()).rejects.toThrow('Repository cache lease was lost');

    await jest.advanceTimersByTimeAsync(50);
    expect(store.renew).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('bounds a hung renewal so ownership checks cannot outlive the lease', async () => {
    jest.useFakeTimers();
    const store = createStore([true]);
    (store.renew as jest.Mock).mockImplementation(
      () => new Promise<boolean>(() => undefined),
    );

    const lease = await tryAcquireRepoCacheLease('watcher:doc-4:thread-4', {
      ownerId: 'instance-4',
      leaseMs: 30,
      heartbeatMs: 10,
      renewTimeoutMs: 10,
      waitMs: 0,
      store,
    });

    expect(lease).not.toBeNull();
    const assertOwned = lease!.assertOwned();
    const rejection = expect(assertOwned).rejects.toThrow(
      'Repository cache lease was lost: Repository cache lease renewal timed out',
    );
    await jest.advanceTimersByTimeAsync(11);
    await rejection;
    jest.useRealTimers();
  });

  it('throws from assertOwned after the lease has been released', async () => {
    const store = createStore([true]);
    const lease = await tryAcquireRepoCacheLease('watcher:doc-5:thread-5', {
      ownerId: 'instance-5',
      leaseMs: 30_000,
      heartbeatMs: 10_000,
      waitMs: 0,
      store,
    });

    expect(lease).not.toBeNull();
    await lease!.release();
    await expect(lease!.assertOwned()).rejects.toThrow('Repository cache lease is no longer held');
  });
});
