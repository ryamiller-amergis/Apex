/**
 * FEAT-007 / TBI-010 — per-thread turn serialization primitive (BR-015).
 */
import { createPerThreadTurnQueue } from '../services/interactiveActorHost/perThreadTurnQueue';

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createPerThreadTurnQueue', () => {
  it('runs turns for the same thread one-at-a-time in FIFO order', async () => {
    const queue = createPerThreadTurnQueue();
    const order: string[] = [];
    const gate1 = deferred();

    const t1 = queue.submit('thread-a', async () => {
      order.push('t1:start');
      await gate1.promise;
      order.push('t1:end');
    });
    const t2 = queue.submit('thread-a', async () => {
      order.push('t2:start');
    });

    await Promise.resolve();
    // t2 must not start until t1 finishes.
    expect(order).toEqual(['t1:start']);

    gate1.resolve();
    await Promise.all([t1, t2]);
    expect(order).toEqual(['t1:start', 't1:end', 't2:start']);
  });

  it('runs turns for different threads concurrently', async () => {
    const queue = createPerThreadTurnQueue();
    const order: string[] = [];
    const gateA = deferred();

    const a = queue.submit('thread-a', async () => {
      order.push('a:start');
      await gateA.promise;
      order.push('a:end');
    });
    const b = queue.submit('thread-b', async () => {
      order.push('b:start');
    });

    await b;
    // thread-b completed while thread-a is still blocked.
    expect(order).toEqual(['a:start', 'b:start']);
    gateA.resolve();
    await a;
  });

  it('isolates a failed turn so the next turn on the thread still runs', async () => {
    const queue = createPerThreadTurnQueue();
    const results: string[] = [];

    const failing = queue
      .submit('thread-a', async () => {
        throw new Error('boom');
      })
      .catch((error: Error) => {
        results.push(`rejected:${error.message}`);
      });
    const following = queue.submit('thread-a', async () => {
      results.push('ran-after-failure');
    });

    await Promise.all([failing, following]);
    expect(results).toEqual(['rejected:boom', 'ran-after-failure']);
  });

  it('evicts drained threads to bound memory', async () => {
    const queue = createPerThreadTurnQueue();
    await queue.submit('thread-a', async () => undefined);
    // Allow the post-drain eviction microtask to run.
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.activeThreadCount()).toBe(0);
  });
});
