import {
  type RepoCacheLeaseStore,
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
});
