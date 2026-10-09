import {
  createInFlightCounter,
  createInteractiveShutdownDrain,
} from '../services/interactiveActorHost/shutdownDrain';

describe('in-flight counter', () => {
  it('counts work from the call until it settles, success or failure', async () => {
    const counter = createInFlightCounter();
    let finish: () => void = () => {};
    const ok = counter.track(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const failed = counter.track(() => Promise.reject(new Error('boom')));
    expect(counter.count()).toBe(2);

    await expect(failed).rejects.toThrow('boom');
    expect(counter.count()).toBe(1);
    finish();
    await ok;
    expect(counter.count()).toBe(0);
  });

  it('releases the count when the work throws synchronously', async () => {
    const counter = createInFlightCounter();
    await expect(
      counter.track(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(counter.count()).toBe(0);
  });
});

describe('interactive actor host shutdown drain', () => {
  let activeTurns: number;
  let dispose: jest.Mock;
  let exit: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    activeTurns = 0;
    dispose = jest.fn().mockResolvedValue(undefined);
    exit = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function createDrain(drainMs: number) {
    return createInteractiveShutdownDrain({
      drainMs,
      activeTurnCount: () => activeTurns,
      dispose,
      exit,
      pollMs: 1_000,
      log: () => {},
    });
  }

  async function flushPromises() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it('disposes at once and keeps running when no drain is configured', async () => {
    activeTurns = 2;
    const drain = createDrain(0);

    drain.shutdown('SIGTERM');
    await flushPromises();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(drain.isDraining()).toBe(false);
  });

  it('waits for turns in flight, then disposes and exits', async () => {
    activeTurns = 1;
    const drain = createDrain(570_000);

    drain.shutdown('SIGTERM');
    expect(drain.isDraining()).toBe(true);
    jest.advanceTimersByTime(5_000);
    await flushPromises();
    expect(dispose).not.toHaveBeenCalled();

    activeTurns = 0;
    jest.advanceTimersByTime(1_000);
    await flushPromises();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits at the drain deadline when a turn is still running', async () => {
    activeTurns = 1;
    const drain = createDrain(10_000);

    drain.shutdown('SIGTERM');
    jest.advanceTimersByTime(9_999);
    await flushPromises();
    expect(exit).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await flushPromises();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits straight away when idle', async () => {
    const drain = createDrain(570_000);

    drain.shutdown('SIGTERM');
    await flushPromises();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('stops draining on a second signal', async () => {
    activeTurns = 1;
    const drain = createDrain(570_000);

    drain.shutdown('SIGTERM');
    drain.shutdown('SIGTERM');
    await flushPromises();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits even when dispose fails', async () => {
    dispose.mockRejectedValue(new Error('checkout busy'));
    const drain = createDrain(570_000);

    drain.shutdown('SIGTERM');
    await flushPromises();

    expect(exit).toHaveBeenCalledWith(0);
  });
});
