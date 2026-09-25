import { sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db/drizzle';
import {
  AI_CONTROL_PLANE_LEASE_KEYS,
  isAiControlPlaneLeaseKey,
  type AiControlPlaneLeaseKey,
} from '../../../shared/types/aiRunV2';

export class DistributedLeaseLostError extends Error {
  constructor(detail?: string) {
    super(detail ?? 'Control-plane lease was lost');
    this.name = 'DistributedLeaseLostError';
  }
}

export class DistributedLeaseUnavailableError extends Error {
  leaseKey: AiControlPlaneLeaseKey;

  constructor(leaseKey: AiControlPlaneLeaseKey) {
    super(`Control-plane lease unavailable: ${leaseKey}`);
    this.name = 'DistributedLeaseUnavailableError';
    this.leaseKey = leaseKey;
  }
}

export interface DistributedLeaseRow {
  leaseKey: AiControlPlaneLeaseKey;
  holderId: string | null;
  fencingToken: bigint;
  expiresAt: string;
}

export interface DistributedLeaseStore {
  tryAcquire(
    leaseKey: AiControlPlaneLeaseKey,
    holderId: string,
    leaseMs: number
  ): Promise<bigint | null>;
  renew(
    leaseKey: AiControlPlaneLeaseKey,
    holderId: string,
    fencingToken: bigint,
    leaseMs: number
  ): Promise<boolean>;
  release(
    leaseKey: AiControlPlaneLeaseKey,
    holderId: string,
    fencingToken: bigint
  ): Promise<boolean>;
  getLease(
    leaseKey: AiControlPlaneLeaseKey
  ): Promise<DistributedLeaseRow | null>;
}

export interface DistributedLeaseOptions {
  holderId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  store?: DistributedLeaseStore;
}

export interface HeldDistributedLease {
  leaseKey: AiControlPlaneLeaseKey;
  holderId: string;
  fencingToken: bigint;
  signal: AbortSignal;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

const DEFAULT_LEASE_MS = 55_000;
const DEFAULT_HEARTBEAT_MS = 15_000;

type SqlExecutor = {
  execute(query: unknown): Promise<unknown>;
};

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] } | undefined)?.rows ?? [];
}

function requirePositiveMs(name: string, value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer millisecond duration`);
  }
  return value;
}

function requireLeaseKey(leaseKey: string): AiControlPlaneLeaseKey {
  if (!isAiControlPlaneLeaseKey(leaseKey)) {
    throw new Error(`Unknown control-plane lease key: ${leaseKey}`);
  }
  return leaseKey;
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value))
    return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`Unexpected fencing token value: ${String(value)}`);
}

export function createPostgresDistributedLeaseStore(
  executor: SqlExecutor = db
): DistributedLeaseStore {
  return {
    async tryAcquire(leaseKey, holderId, leaseMs) {
      const key = requireLeaseKey(leaseKey);
      const durationMs = requirePositiveMs('leaseMs', leaseMs);
      const result = await executor.execute(sql`
        UPDATE ai_control_plane_leases
        SET
          holder_id = ${holderId},
          fencing_token = fencing_token + 1,
          expires_at = now() + (${durationMs} * interval '1 millisecond'),
          updated_at = now()
        WHERE lease_key = ${key}
          AND (holder_id IS NULL OR expires_at <= now() OR holder_id = ${holderId})
        RETURNING fencing_token
      `);
      const row = resultRows<{ fencing_token: unknown }>(result)[0];
      return row ? toBigInt(row.fencing_token) : null;
    },

    async renew(leaseKey, holderId, fencingToken, leaseMs) {
      const key = requireLeaseKey(leaseKey);
      const durationMs = requirePositiveMs('leaseMs', leaseMs);
      const result = await executor.execute(sql`
        UPDATE ai_control_plane_leases
        SET
          expires_at = now() + (${durationMs} * interval '1 millisecond'),
          updated_at = now()
        WHERE lease_key = ${key}
          AND holder_id = ${holderId}
          AND fencing_token = ${fencingToken.toString()}::bigint
          AND expires_at > now()
        RETURNING lease_key
      `);
      return resultRows(result).length > 0;
    },

    async release(leaseKey, holderId, fencingToken) {
      const key = requireLeaseKey(leaseKey);
      const result = await executor.execute(sql`
        UPDATE ai_control_plane_leases
        SET
          holder_id = NULL,
          expires_at = 'epoch',
          updated_at = now()
        WHERE lease_key = ${key}
          AND holder_id = ${holderId}
          AND fencing_token = ${fencingToken.toString()}::bigint
        RETURNING lease_key
      `);
      return resultRows(result).length > 0;
    },

    async getLease(leaseKey) {
      const key = requireLeaseKey(leaseKey);
      const result = await executor.execute(sql`
        SELECT lease_key, holder_id, fencing_token, expires_at
        FROM ai_control_plane_leases
        WHERE lease_key = ${key}
      `);
      const row = resultRows<{
        lease_key: string;
        holder_id: string | null;
        fencing_token: unknown;
        expires_at: string | Date;
      }>(result)[0];
      if (!row) return null;
      return {
        leaseKey: requireLeaseKey(row.lease_key),
        holderId: row.holder_id,
        fencingToken: toBigInt(row.fencing_token),
        expiresAt:
          row.expires_at instanceof Date
            ? row.expires_at.toISOString()
            : row.expires_at,
      };
    },
  };
}

const postgresDistributedLeaseStore = createPostgresDistributedLeaseStore();

export async function tryAcquireLease(
  leaseKey: AiControlPlaneLeaseKey,
  options: DistributedLeaseOptions = {}
): Promise<HeldDistributedLease | null> {
  requireLeaseKey(leaseKey);
  const holderId = options.holderId ?? uuidv4();
  const leaseMs = requirePositiveMs(
    'leaseMs',
    options.leaseMs ?? DEFAULT_LEASE_MS
  );
  const heartbeatMs = requirePositiveMs(
    'heartbeatMs',
    options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  );
  if (heartbeatMs >= leaseMs) {
    throw new Error('heartbeatMs must be less than leaseMs');
  }
  const store = options.store ?? postgresDistributedLeaseStore;

  const fencingToken = await store.tryAcquire(leaseKey, holderId, leaseMs);
  if (fencingToken === null) {
    return null;
  }

  const abortController = new AbortController();
  let released = false;
  let heartbeatPromise: Promise<void> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  const stopHeartbeat = (): void => {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const assertOwned = async (): Promise<void> => {
    if (released || abortController.signal.aborted) {
      throw new DistributedLeaseLostError();
    }
    const renewed = await store.renew(
      leaseKey,
      holderId,
      fencingToken,
      leaseMs
    );
    if (!renewed) {
      abortController.abort(new DistributedLeaseLostError());
      throw new DistributedLeaseLostError();
    }
  };

  const scheduleHeartbeat = (): void => {
    stopHeartbeat();
    heartbeatTimer = setTimeout(() => {
      heartbeatPromise = (async () => {
        try {
          await assertOwned();
          if (!released && !abortController.signal.aborted) {
            scheduleHeartbeat();
          }
        } catch (error) {
          if (!abortController.signal.aborted) {
            abortController.abort(
              error instanceof DistributedLeaseLostError
                ? error
                : new DistributedLeaseLostError(
                    error instanceof Error ? error.message : String(error)
                  )
            );
          }
        } finally {
          heartbeatPromise = null;
        }
      })();
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  };

  scheduleHeartbeat();

  return {
    leaseKey,
    holderId,
    fencingToken,
    signal: abortController.signal,
    assertOwned,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      stopHeartbeat();
      if (heartbeatPromise) {
        await heartbeatPromise.catch(() => undefined);
      }
      await store.release(leaseKey, holderId, fencingToken);
    },
  };
}

export async function withDistributedLease<T>(
  leaseKey: AiControlPlaneLeaseKey,
  work: (lease: HeldDistributedLease) => Promise<T>,
  options: DistributedLeaseOptions = {}
): Promise<T> {
  const lease = await tryAcquireLease(leaseKey, options);
  if (!lease) {
    throw new DistributedLeaseUnavailableError(leaseKey);
  }
  try {
    return await work(lease);
  } finally {
    await lease.release();
  }
}

export async function renewLease(
  leaseKey: AiControlPlaneLeaseKey,
  holderId: string,
  fencingToken: bigint,
  options: Pick<DistributedLeaseOptions, 'leaseMs' | 'store'> = {}
): Promise<boolean> {
  const store = options.store ?? postgresDistributedLeaseStore;
  const leaseMs = requirePositiveMs(
    'leaseMs',
    options.leaseMs ?? DEFAULT_LEASE_MS
  );
  return store.renew(leaseKey, holderId, fencingToken, leaseMs);
}

export async function releaseLease(
  leaseKey: AiControlPlaneLeaseKey,
  holderId: string,
  fencingToken: bigint,
  options: Pick<DistributedLeaseOptions, 'store'> = {}
): Promise<boolean> {
  const store = options.store ?? postgresDistributedLeaseStore;
  return store.release(leaseKey, holderId, fencingToken);
}

export async function assertLeaseOwned(
  leaseKey: AiControlPlaneLeaseKey,
  holderId: string,
  fencingToken: bigint,
  options: Pick<DistributedLeaseOptions, 'leaseMs' | 'store'> = {}
): Promise<void> {
  const renewed = await renewLease(leaseKey, holderId, fencingToken, options);
  if (!renewed) {
    throw new DistributedLeaseLostError();
  }
}

export const SEEDED_CONTROL_PLANE_LEASE_KEYS = AI_CONTROL_PLANE_LEASE_KEYS;
