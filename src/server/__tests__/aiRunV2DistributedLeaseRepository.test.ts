import {
  DistributedLeaseLostError,
  DistributedLeaseUnavailableError,
  tryAcquireLease,
  withDistributedLease,
  type DistributedLeaseStore,
} from '../services/aiRunV2/distributedLeaseRepository';

function createMemoryStore(initialToken = 0n): DistributedLeaseStore & {
  rows: Map<string, {
    holderId: string | null;
    fencingToken: bigint;
    expiresAtMs: number;
  }>;
} {
  const rows = new Map<string, {
    holderId: string | null;
    fencingToken: bigint;
    expiresAtMs: number;
  }>();
  for (const key of ['admission', 'recovery', 'reaper', 'outbox'] as const) {
    rows.set(key, {
      holderId: null,
      fencingToken: initialToken,
      expiresAtMs: 0,
    });
  }

  return {
    rows,
    async tryAcquire(leaseKey, holderId, leaseMs) {
      const row = rows.get(leaseKey);
      if (!row) return null;
      const now = Date.now();
      if (row.holderId && row.expiresAtMs > now && row.holderId !== holderId) {
        return null;
      }
      row.holderId = holderId;
      row.fencingToken += 1n;
      row.expiresAtMs = now + leaseMs;
      return row.fencingToken;
    },
    async renew(leaseKey, holderId, fencingToken, leaseMs) {
      const row = rows.get(leaseKey);
      if (!row) return false;
      if (
        row.holderId !== holderId
        || row.fencingToken !== fencingToken
        || row.expiresAtMs <= Date.now()
      ) {
        return false;
      }
      row.expiresAtMs = Date.now() + leaseMs;
      return true;
    },
    async release(leaseKey, holderId, fencingToken) {
      const row = rows.get(leaseKey);
      if (!row) return false;
      if (row.holderId !== holderId || row.fencingToken !== fencingToken) {
        return false;
      }
      row.holderId = null;
      row.expiresAtMs = 0;
      return true;
    },
    async getLease(leaseKey) {
      const row = rows.get(leaseKey);
      if (!row) return null;
      return {
        leaseKey,
        holderId: row.holderId,
        fencingToken: row.fencingToken,
        expiresAt: new Date(row.expiresAtMs).toISOString(),
      };
    },
  };
}

describe('AI-run V2 distributed leases', () => {
  it('acquires a seeded lease with an incremented fencing token', async () => {
    const store = createMemoryStore(4n);
    const lease = await tryAcquireLease('reaper', {
      holderId: 'owner-a',
      leaseMs: 1_000,
      heartbeatMs: 200,
      store,
    });
    expect(lease).not.toBeNull();
    expect(lease?.fencingToken).toBe(5n);
    await lease?.release();
    expect(store.rows.get('reaper')?.holderId).toBeNull();
  });

  it('rejects a second owner while the lease is unexpired', async () => {
    const store = createMemoryStore();
    const first = await tryAcquireLease('admission', {
      holderId: 'owner-a',
      leaseMs: 5_000,
      heartbeatMs: 1_000,
      store,
    });
    const second = await tryAcquireLease('admission', {
      holderId: 'owner-b',
      leaseMs: 5_000,
      heartbeatMs: 1_000,
      store,
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    await first?.release();
  });

  it('allows takeover after expiry with a larger fencing token', async () => {
    const store = createMemoryStore(1n);
    const first = await tryAcquireLease('outbox', {
      holderId: 'owner-a',
      leaseMs: 5_000,
      heartbeatMs: 4_000,
      store,
    });
    expect(first?.fencingToken).toBe(2n);
    const row = store.rows.get('outbox');
    if (!row) throw new Error('missing outbox lease row');
    row.expiresAtMs = Date.now() - 1;
    const second = await tryAcquireLease('outbox', {
      holderId: 'owner-b',
      leaseMs: 1_000,
      heartbeatMs: 100,
      store,
    });
    expect(second?.fencingToken).toBe(3n);
    await expect(first!.assertOwned()).rejects.toBeInstanceOf(DistributedLeaseLostError);
    await second?.release();
  });

  it('rejects invalid durations and unknown lease keys', async () => {
    const store = createMemoryStore();
    await expect(tryAcquireLease('reaper', {
      leaseMs: 0,
      heartbeatMs: 10,
      store,
    })).rejects.toThrow(/leaseMs/);
    await expect(tryAcquireLease('reaper', {
      leaseMs: 100,
      heartbeatMs: 100,
      store,
    })).rejects.toThrow(/heartbeatMs must be less than leaseMs/);
    await expect(tryAcquireLease('watcher' as 'reaper', {
      leaseMs: 100,
      heartbeatMs: 10,
      store,
    })).rejects.toThrow(/Unknown control-plane lease key/);
  });

  it('withDistributedLease releases on success and surfaces unavailability', async () => {
    const store = createMemoryStore();
    const held = await tryAcquireLease('recovery', {
      holderId: 'owner-a',
      leaseMs: 5_000,
      heartbeatMs: 1_000,
      store,
    });
    await expect(withDistributedLease('recovery', async () => 'ok', {
      holderId: 'owner-b',
      leaseMs: 5_000,
      heartbeatMs: 1_000,
      store,
    })).rejects.toBeInstanceOf(DistributedLeaseUnavailableError);

    await held?.release();
    const value = await withDistributedLease('recovery', async (lease) => {
      expect(lease.leaseKey).toBe('recovery');
      return 'done';
    }, {
      holderId: 'owner-b',
      leaseMs: 5_000,
      heartbeatMs: 1_000,
      store,
    });
    expect(value).toBe('done');
    expect(store.rows.get('recovery')?.holderId).toBeNull();
  });
});
