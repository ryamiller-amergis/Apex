import { and, eq, lt, or, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/drizzle';
import { repoCacheLeases } from '../db/schema';

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 60 * 1000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_WAIT_MS = 65 * 60 * 1000;
/** Bound for chat/generation paths. Must stay below GROUNDING_PREPARATION_TIMEOUT_MS (2 min). */
export const USER_FACING_REPO_CACHE_LEASE_WAIT_MS = 90 * 1000;

export interface RepoCacheLeaseStore {
  tryAcquire(cacheKey: string, ownerId: string, leaseMs: number): Promise<number | null>;
  renew(cacheKey: string, ownerId: string, generation: number, leaseMs: number): Promise<boolean>;
  release(cacheKey: string, ownerId: string, generation: number): Promise<void>;
}

export interface RepoCacheLeaseOptions {
  ownerId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  renewTimeoutMs?: number;
  pollMs?: number;
  waitMs?: number;
  /** Keep the lease row until expiry instead of releasing after success/failure. */
  releaseOnComplete?: boolean;
  store?: RepoCacheLeaseStore;
}

export interface RepoCacheLeaseContext {
  signal: AbortSignal;
  assertOwned(): Promise<void>;
}

export interface HeldRepoCacheLease extends RepoCacheLeaseContext {
  cacheKey: string;
  ownerId: string;
  generation: number;
  release(): Promise<void>;
}

const postgresLeaseStore: RepoCacheLeaseStore = {
  async tryAcquire(cacheKey, ownerId, leaseMs) {
    const [row] = await db
      .insert(repoCacheLeases)
      .values({
        cacheKey,
        ownerId,
        generation: 1,
        expiresAt: sql`now() + (${leaseMs} * interval '1 millisecond')`,
        updatedAt: sql`now()`,
      })
      .onConflictDoUpdate({
        target: repoCacheLeases.cacheKey,
        set: {
          ownerId,
          generation: sql`${repoCacheLeases.generation} + 1`,
          expiresAt: sql`now() + (${leaseMs} * interval '1 millisecond')`,
          updatedAt: sql`now()`,
        },
        setWhere: or(
          lt(repoCacheLeases.expiresAt, sql`now()`),
          eq(repoCacheLeases.ownerId, ownerId),
        ),
      })
      .returning({
        ownerId: repoCacheLeases.ownerId,
        generation: repoCacheLeases.generation,
      });
    return row?.ownerId === ownerId ? row.generation : null;
  },

  async renew(cacheKey, ownerId, generation, leaseMs) {
    const [row] = await db
      .update(repoCacheLeases)
      .set({
        expiresAt: sql`now() + (${leaseMs} * interval '1 millisecond')`,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(repoCacheLeases.cacheKey, cacheKey),
        eq(repoCacheLeases.ownerId, ownerId),
        eq(repoCacheLeases.generation, generation),
      ))
      .returning({ ownerId: repoCacheLeases.ownerId });
    return row?.ownerId === ownerId;
  },

  async release(cacheKey, ownerId, generation) {
    await db
      .delete(repoCacheLeases)
      .where(and(
        eq(repoCacheLeases.cacheKey, cacheKey),
        eq(repoCacheLeases.ownerId, ownerId),
        eq(repoCacheLeases.generation, generation),
      ));
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveRenewTimeoutMs(
  options: RepoCacheLeaseOptions,
  leaseMs: number,
  heartbeatMs: number,
): number {
  const configured = options.renewTimeoutMs;
  if (configured && configured > 0) {
    return Math.min(configured, leaseMs);
  }
  return Math.min(leaseMs, heartbeatMs);
}

function timeoutError(prefix: string, timeoutMs: number): Error {
  return new Error(`${prefix} timed out after ${timeoutMs}ms`);
}

async function runWithTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  prefix: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(timeoutError(prefix, timeoutMs));
    }, timeoutMs);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function tryAcquireRepoCacheLease(
  cacheKey: string,
  options: RepoCacheLeaseOptions = {},
): Promise<HeldRepoCacheLease | null> {
  const ownerId = options.ownerId ?? uuidv4();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const renewTimeoutMs = resolveRenewTimeoutMs(options, leaseMs, heartbeatMs);
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const store = options.store ?? postgresLeaseStore;
  const deadline = Date.now() + waitMs;

  let generation: number | null = null;
  while (generation === null) {
    generation = await store.tryAcquire(cacheKey, ownerId, leaseMs);
    if (generation !== null) break;
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(pollMs);
  }

  const controller = new AbortController();
  let heartbeatPromise: Promise<void> | null = null;
  let released = false;
  let heartbeatStopped = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stopHeartbeat = (): void => {
    if (heartbeatStopped) return;
    heartbeatStopped = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const abortForLostLease = (cause?: unknown) => {
    if (controller.signal.aborted) return;
    stopHeartbeat();
    const detail = cause instanceof Error ? `: ${cause.message}` : '';
    controller.abort(new Error(`Repository cache lease was lost${detail}`));
  };

  const renewLease = async (): Promise<void> => {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (released || heartbeatStopped) {
      throw new Error('Repository cache lease is no longer held');
    }
    try {
      const renewed = await runWithTimeout(
        store.renew(cacheKey, ownerId, generation!, leaseMs),
        renewTimeoutMs,
        'Repository cache lease renewal',
      );
      if (!renewed) abortForLostLease();
    } catch (err) {
      console.error('[repo-cache] lease renewal failed:', (err as Error).message);
      abortForLostLease(err);
    }
    if (controller.signal.aborted) throw controller.signal.reason;
  };

  heartbeat = setInterval(() => {
    if (released || heartbeatPromise) return;
    heartbeatPromise = renewLease()
      .catch(() => {
        // The AbortSignal carries the failure to the lease holder.
      })
      .finally(() => {
        heartbeatPromise = null;
      });
  }, heartbeatMs);
  heartbeat.unref?.();

  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    stopHeartbeat();
    if (heartbeatPromise) await heartbeatPromise;
    try {
      await store.release(cacheKey, ownerId, generation!);
    } catch (err) {
      console.error('[repo-cache] lease release failed; expiry will recover it:', (err as Error).message);
    }
  };

  return {
    cacheKey,
    ownerId,
    generation: generation!,
    signal: controller.signal,
    assertOwned: renewLease,
    release,
  };
}

export async function withRepoCacheLease<T>(
  cacheKey: string,
  operation: (lease: RepoCacheLeaseContext) => Promise<T>,
  options: RepoCacheLeaseOptions = {},
): Promise<T> {
  const ownerId = options.ownerId ?? uuidv4();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const renewTimeoutMs = resolveRenewTimeoutMs(options, leaseMs, heartbeatMs);
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const store = options.store ?? postgresLeaseStore;
  const deadline = Date.now() + waitMs;

  let generation: number | null = null;
  while (generation === null) {
    generation = await store.tryAcquire(cacheKey, ownerId, leaseMs);
    if (generation === null) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for repository cache lease: ${cacheKey}`);
      }
      await sleep(pollMs);
    }
  }

  const controller = new AbortController();
  let heartbeatPromise: Promise<void> | null = null;
  let heartbeatStopped = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stopHeartbeat = (): void => {
    if (heartbeatStopped) return;
    heartbeatStopped = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };
  const abortForLostLease = (cause?: unknown) => {
    if (controller.signal.aborted) return;
    stopHeartbeat();
    const detail = cause instanceof Error ? `: ${cause.message}` : '';
    controller.abort(new Error(`Repository cache lease was lost${detail}`));
  };
  const renewLease = async (): Promise<void> => {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (heartbeatStopped) {
      throw new Error('Repository cache lease is no longer held');
    }
    try {
      const renewed = await runWithTimeout(
        store.renew(cacheKey, ownerId, generation!, leaseMs),
        renewTimeoutMs,
        'Repository cache lease renewal',
      );
      if (!renewed) abortForLostLease();
    } catch (err) {
      console.error('[repo-cache] lease renewal failed:', (err as Error).message);
      abortForLostLease(err);
    }
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  heartbeat = setInterval(() => {
    if (heartbeatPromise) return;
    heartbeatPromise = renewLease()
      .catch(() => {
        // The AbortSignal carries the failure to the protected operation.
      })
      .finally(() => {
        heartbeatPromise = null;
      });
  }, heartbeatMs);
  heartbeat.unref?.();

  try {
    const result = await operation({
      signal: controller.signal,
      assertOwned: renewLease,
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    return result;
  } finally {
    stopHeartbeat();
    if (heartbeatPromise) await heartbeatPromise;
    if (options.releaseOnComplete !== false) {
      try {
        await store.release(cacheKey, ownerId, generation);
      } catch (err) {
        console.error('[repo-cache] lease release failed; expiry will recover it:', (err as Error).message);
      }
    }
  }
}
