import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersistenceUnavailableError } from '../persistence/index.ts';
import { createReadinessService, NotReadyError } from './readinessService.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('readinessService', () => {
  it('PBI-012 AC-0 resolves when the ping resolves', async () => {
    const service = createReadinessService({
      ping: () => Promise.resolve(),
      timeoutMs: 2000,
    });
    await expect(service.check()).resolves.toBeUndefined();
  });

  it('PBI-012 AC-1 throws NotReadyError with fixed text when the ping rejects', async () => {
    const service = createReadinessService({
      ping: () =>
        Promise.reject(
          new Error('connect postgres://synthetic-user:pw@db.internal:5432')
        ),
      timeoutMs: 2000,
    });
    const error = await service.check().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotReadyError);
    expect((error as Error).message).not.toContain('db.internal');
    expect((error as Error).cause).toBeUndefined();
  });

  it('VT-19 PBI-012 AC-2 throws at the deadline when the ping never settles, and clears its timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const service = createReadinessService({
      ping: () => new Promise<void>(() => {}),
      timeoutMs: 50,
    });
    const outcome = service.check().catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(49);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBeInstanceOf(NotReadyError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('VT-19 clears the timer as soon as the ping settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const service = createReadinessService({
      ping: () => Promise.reject(new PersistenceUnavailableError()),
      timeoutMs: 2000,
    });
    await expect(service.check()).rejects.toBeInstanceOf(NotReadyError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('VT-19 a ping that rejects after the deadline causes no unhandled rejection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let rejectLate: (error: Error) => void = () => {};
    const service = createReadinessService({
      ping: () =>
        new Promise<void>((_resolve, reject) => {
          rejectLate = reject;
        }),
      timeoutMs: 10,
    });
    const outcome = service.check().catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(10);
    expect(await outcome).toBeInstanceOf(NotReadyError);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      rejectLate(new Error('late'));
      await vi.advanceTimersByTimeAsync(0);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('reports not ready during shutdown without pinging', async () => {
    const ping = vi.fn(() => Promise.resolve());
    const service = createReadinessService({
      ping,
      timeoutMs: 2000,
      isShuttingDown: () => true,
    });
    await expect(service.check()).rejects.toBeInstanceOf(NotReadyError);
    expect(ping).not.toHaveBeenCalled();
  });
});
