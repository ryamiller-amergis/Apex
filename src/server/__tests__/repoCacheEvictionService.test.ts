import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_ROOT = path.join(
  os.tmpdir(),
  `repo-cache-eviction-${process.pid}-${Date.now()}`,
);
const CACHE_ROOT = path.join(DATA_ROOT, 'repo-cache');

jest.mock('../utils/dataDir', () => ({
  resolveDataRoot: () => DATA_ROOT,
}));
jest.mock('../utils/asyncGit', () => ({
  git: jest.fn(),
  safeArgs: (dir: string, args: string[]) => [
    '-c',
    `safe.directory=${dir}`,
    ...args,
  ],
}));
jest.mock('../services/repoCacheLeaseService', () => ({
  withRepoCacheLease: jest.fn(),
  USER_FACING_REPO_CACHE_LEASE_WAIT_MS: 90_000,
}));
jest.mock('../services/runGroundingRepository', () => ({
  runGroundingRepository: { listActiveGroundings: jest.fn() },
}));
jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn() }));

import type { RunGrounding } from '../../shared/types/runGrounding';
import {
  REPO_CACHE_COMPACT_MAX_PACKS,
  REPO_CACHE_MIN_IDLE_MS,
  createRepoCacheEvictionService,
  mirrorNeedsCompaction,
} from '../services/repoCacheEvictionService';
import {
  COLD_CACHE_TIMEOUT_MS,
  getRepoCacheDir,
  getRepoCacheLeaseKey,
  type RepoCacheCompactionResult,
  type RepoCacheIdentity,
  type RepoCachePackStats,
} from '../services/repoCacheService';

const NOW = 1_800_000_000_000;
const MB = 1024 * 1024;

/** Runs the operation immediately, as an uncontended lease would. */
const grantLease = jest.fn(
  async (_key: string, operation: () => Promise<unknown>) => operation(),
);

function makeMirror(options: {
  identity: RepoCacheIdentity | null;
  branch: string;
  bytes: number;
  idleMs: number;
}): string {
  const dir = options.identity
    ? getRepoCacheDir({ ...options.identity, branch: options.branch })
    : path.join(CACHE_ROOT, 'legacy-orphan-000000000000.git');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(dir, 'objects.pack'), Buffer.alloc(options.bytes));
  if (options.identity) {
    fs.writeFileSync(
      path.join(dir, 'apex-cache-identity.json'),
      JSON.stringify(options.identity),
    );
  }
  const lastUsed = path.join(dir, 'apex-last-used');
  fs.writeFileSync(lastUsed, `${NOW - options.idleMs}\n`);
  const stamp = new Date(NOW - options.idleMs);
  fs.utimesSync(lastUsed, stamp, stamp);
  return dir;
}

function service(overrides: {
  maxBytes: number;
  activeGroundings?: RunGrounding[];
  withLease?: typeof grantLease;
  freeBytes?: number;
  readPackStats?: (dir: string) => RepoCachePackStats;
  compactMirror?: jest.Mock;
  telemetry?: jest.Mock;
}) {
  return createRepoCacheEvictionService({
    dataRoot: DATA_ROOT,
    maxBytes: overrides.maxBytes,
    now: () => NOW,
    listActiveGroundings: async () => overrides.activeGroundings ?? [],
    withLease: (overrides.withLease ?? grantLease) as never,
    telemetry: overrides.telemetry ?? jest.fn(),
    readFreeBytes: async () => overrides.freeBytes ?? 100 * 1024 * MB,
    ...(overrides.readPackStats ? { readPackStats: overrides.readPackStats } : {}),
    ...(overrides.compactMirror ? { compactMirror: overrides.compactMirror } : {}),
  });
}

const KB = 1024;
/** 160 duplicate refetch packs, shaped like the bloated MatterWorx mirror at 1/10,000 scale. */
const BLOATED_PACKS: RepoCachePackStats = {
  packCount: 160,
  packBytes: 160 * 35 * KB,
  largestPackBytes: 55 * KB,
};
const HEALTHY_PACKS: RepoCachePackStats = {
  packCount: 3,
  packBytes: 60 * KB,
  largestPackBytes: 50 * KB,
};
const COMPACTED_PACKS: RepoCachePackStats = {
  packCount: 1,
  packBytes: 50 * KB,
  largestPackBytes: 50 * KB,
};
const RECLAIMED = BLOATED_PACKS.packBytes - COMPACTED_PACKS.packBytes;

function compactTo(after: RepoCachePackStats): jest.Mock {
  return jest.fn(async (): Promise<RepoCacheCompactionResult> => ({
    compacted: true,
    before: BLOATED_PACKS,
    after,
    freeBytes: 100 * 1024 * MB,
    requiredFreeBytes: 10 * MB,
    durationMs: 1,
  }));
}

function makeAbandonedClone(ageMs: number): string {
  const dir = path.join(
    CACHE_ROOT,
    'ado-maxview-maxview-main-0123456789ab.git.tmp-3f2b8c1e-9a4d-4c7e-8b21-5d6f7a8b9c0d',
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'partial.pack'), Buffer.alloc(MB));
  const stamp = new Date(NOW - ageMs);
  fs.utimesSync(dir, stamp, stamp);
  return dir;
}

const ADO_MAXVIEW: RepoCacheIdentity = {
  provider: 'ado',
  project: 'MaxView',
  repo: 'MaxView',
};
const ADO_MATTERWORX: RepoCacheIdentity = {
  provider: 'ado',
  project: 'MatterWorx',
  repo: 'MatterWorx',
};
const GITHUB_APEX: RepoCacheIdentity = {
  provider: 'github',
  project: 'apex',
  repo: 'apex',
};

describe('repoCacheEvictionService', () => {
  beforeEach(() => {
    fs.rmSync(CACHE_ROOT, { recursive: true, force: true });
    fs.mkdirSync(CACHE_ROOT, { recursive: true });
    grantLease.mockClear();
  });

  afterAll(() => {
    fs.rmSync(DATA_ROOT, { recursive: true, force: true });
  });

  it('removes a clone abandoned past the cold-clone timeout', async () => {
    const dir = makeAbandonedClone(COLD_CACHE_TIMEOUT_MS + 60_000);

    const result = await service({ maxBytes: 100 * MB }).evictOverBudget();

    expect(fs.existsSync(dir)).toBe(false);
    expect(result).toMatchObject({ abandonedClonesRemoved: 1, bytesBefore: 0 });
  });

  it('keeps a clone that may still be running', async () => {
    const dir = makeAbandonedClone(COLD_CACHE_TIMEOUT_MS - 60_000);

    const result = await service({ maxBytes: 100 * MB }).evictOverBudget();

    expect(fs.existsSync(dir)).toBe(true);
    expect(result.abandonedClonesRemoved).toBe(0);
  });

  it('reports free space and logs when it is below what a clone needs', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await service({ maxBytes: 100 * MB, freeBytes: 2 * 1024 * MB })
      .evictOverBudget();

    expect(result.freeBytes).toBe(2 * 1024 * MB);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[repo-cache] disk-low'));
    error.mockRestore();
  });

  it('returns an empty result when the cache directory does not exist', async () => {
    fs.rmSync(CACHE_ROOT, { recursive: true, force: true });
    const result = await service({ maxBytes: MB }).evictOverBudget();
    expect(result).toMatchObject({ scanned: 0, evicted: 0, bytesBefore: 0 });
  });

  it('keeps every mirror when the total is within budget', async () => {
    const dir = makeMirror({
      identity: ADO_MAXVIEW,
      branch: 'main',
      bytes: 4 * MB,
      idleMs: REPO_CACHE_MIN_IDLE_MS * 10,
    });

    const result = await service({ maxBytes: 8 * MB }).evictOverBudget();

    expect(result.evicted).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('evicts least recently used mirrors until the total fits the budget', async () => {
    const oldest = makeMirror({
      identity: ADO_MAXVIEW,
      branch: 'main',
      bytes: 4 * MB,
      idleMs: REPO_CACHE_MIN_IDLE_MS * 10,
    });
    const middle = makeMirror({
      identity: ADO_MATTERWORX,
      branch: 'main',
      bytes: 4 * MB,
      idleMs: REPO_CACHE_MIN_IDLE_MS * 5,
    });
    const newest = makeMirror({
      identity: GITHUB_APEX,
      branch: 'main',
      bytes: 4 * MB,
      idleMs: REPO_CACHE_MIN_IDLE_MS * 2,
    });

    const result = await service({ maxBytes: 9 * MB }).evictOverBudget();

    expect(result.evicted).toBe(1);
    expect(fs.existsSync(oldest)).toBe(false);
    expect(fs.existsSync(middle)).toBe(true);
    expect(fs.existsSync(newest)).toBe(true);
    expect(result.bytesAfter).toBeLessThanOrEqual(9 * MB);
  });

  it('deletes each mirror under its own lease', async () => {
    makeMirror({
      identity: ADO_MAXVIEW,
      branch: 'main',
      bytes: 4 * MB,
      idleMs: REPO_CACHE_MIN_IDLE_MS * 10,
    });

    await service({ maxBytes: MB }).evictOverBudget();

    expect(grantLease).toHaveBeenCalledWith(
      getRepoCacheLeaseKey(ADO_MAXVIEW),
      expect.any(Function),
      { waitMs: 0 },
    );
  });

  it('never evicts a mirror backing an active grounding', async () => {
    const dir = makeMirror({
      identity: ADO_MAXVIEW,
      branch: 'main',
      bytes: 4 * MB,
      idleMs: REPO_CACHE_MIN_IDLE_MS * 10,
    });
    const active = {
      provider: 'azure_devops',
      project: ADO_MAXVIEW.project,
      repository: ADO_MAXVIEW.repo,
      branch: 'main',
    } as RunGrounding;

    const result = await service({
      maxBytes: MB,
      activeGroundings: [active],
    }).evictOverBudget();

    expect(result.evicted).toBe(0);
    expect(result.protected).toBe(1);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('never evicts a mirror used within the idle window', async () => {
    const dir = makeMirror({
      identity: ADO_MAXVIEW,
      branch: 'main',
      bytes: 4 * MB,
      idleMs: REPO_CACHE_MIN_IDLE_MS / 2,
    });

    const result = await service({ maxBytes: MB }).evictOverBudget();

    expect(result.evicted).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('re-checks idle under the lease and keeps a mirror used since the scan', async () => {
    const dir = makeMirror({
      identity: ADO_MAXVIEW,
      branch: 'main',
      bytes: 4 * MB,
      idleMs: REPO_CACHE_MIN_IDLE_MS * 10,
    });
    const leaseAfterUse = jest.fn(
      async (_key: string, operation: () => Promise<unknown>) => {
        const stamp = new Date(NOW - 1_000);
        fs.utimesSync(path.join(dir, 'apex-last-used'), stamp, stamp);
        return operation();
      },
    );

    const result = await service({
      maxBytes: MB,
      withLease: leaseAfterUse as never,
    }).evictOverBudget();

    expect(leaseAfterUse).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(dir)).toBe(true);
    expect(result.evicted).toBe(0);
  });

  it('never deletes a mirror without an identity sidecar', async () => {
    const dir = makeMirror({
      identity: null,
      branch: 'main',
      bytes: 4 * MB,
      idleMs: REPO_CACHE_MIN_IDLE_MS * 100,
    });

    const result = await service({ maxBytes: MB }).evictOverBudget();

    expect(result.evicted).toBe(0);
    expect(result.protected).toBe(1);
    expect(fs.existsSync(dir)).toBe(true);
    expect(grantLease).not.toHaveBeenCalled();
  });

  it('skips eviction when active groundings cannot be listed', async () => {
    const dir = makeMirror({
      identity: ADO_MAXVIEW,
      branch: 'main',
      bytes: 4 * MB,
      idleMs: REPO_CACHE_MIN_IDLE_MS * 10,
    });
    const eviction = createRepoCacheEvictionService({
      dataRoot: DATA_ROOT,
      maxBytes: MB,
      now: () => NOW,
      listActiveGroundings: async () => {
        throw new Error('database unavailable');
      },
      withLease: grantLease as never,
      telemetry: jest.fn(),
    });

    const result = await eviction.evictOverBudget();

    expect(result.evicted).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
    expect(grantLease).not.toHaveBeenCalled();
  });

  it('leaves a mirror in place when its lease is already held', async () => {
    const dir = makeMirror({
      identity: ADO_MAXVIEW,
      branch: 'main',
      bytes: 4 * MB,
      idleMs: REPO_CACHE_MIN_IDLE_MS * 10,
    });
    const busyLease = jest.fn(async (key: string) => {
      throw new Error(`Timed out waiting for repository cache lease: ${key}`);
    });

    const result = await service({
      maxBytes: MB,
      withLease: busyLease as never,
    }).evictOverBudget();

    expect(result.evicted).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });

  describe('compaction', () => {
    it('flags many packs or several full copies, and leaves a healthy mirror alone', () => {
      expect(mirrorNeedsCompaction(BLOATED_PACKS)).toBe(true);
      expect(mirrorNeedsCompaction(HEALTHY_PACKS)).toBe(false);
      expect(mirrorNeedsCompaction({
        packCount: REPO_CACHE_COMPACT_MAX_PACKS + 1,
        packBytes: 60 * KB,
        largestPackBytes: 50 * KB,
      })).toBe(true);
      expect(mirrorNeedsCompaction({
        packCount: 1,
        packBytes: 500 * KB,
        largestPackBytes: 500 * KB,
      })).toBe(false);
    });

    it('compacts an idle bloated mirror even when it backs an active grounding', async () => {
      const dir = makeMirror({
        identity: ADO_MATTERWORX,
        branch: 'main',
        bytes: 8 * MB,
        idleMs: REPO_CACHE_MIN_IDLE_MS * 10,
      });
      const compactMirror = compactTo(COMPACTED_PACKS);
      const telemetry = jest.fn();
      const active = {
        provider: 'azure_devops',
        project: ADO_MATTERWORX.project,
        repository: ADO_MATTERWORX.repo,
        branch: 'main',
      } as RunGrounding;

      const result = await service({
        maxBytes: 10 * 1024 * MB,
        activeGroundings: [active],
        readPackStats: () => BLOATED_PACKS,
        compactMirror,
        telemetry,
      }).evictOverBudget();

      expect(compactMirror).toHaveBeenCalledWith(dir, undefined);
      expect(grantLease).toHaveBeenCalledWith(
        getRepoCacheLeaseKey(ADO_MATTERWORX),
        expect.any(Function),
        { waitMs: 0 },
      );
      expect(result).toMatchObject({
        compacted: 1,
        compactionBytesReclaimed: RECLAIMED,
        evicted: 0,
        protected: 1,
      });
      expect(result.bytesAfter).toBe(result.bytesBefore - RECLAIMED);
      expect(fs.existsSync(dir)).toBe(true);
      expect(telemetry).toHaveBeenCalledWith(
        'repo-cache.compaction',
        expect.objectContaining({ outcome: 'compacted' }),
        expect.objectContaining({ packsBefore: 160, packsAfter: 1 }),
      );
    });

    it('compacts before evicting, so a mirror that shrinks under budget saves the others', async () => {
      makeMirror({
        identity: ADO_MATTERWORX,
        branch: 'main',
        bytes: 8 * MB,
        idleMs: REPO_CACHE_MIN_IDLE_MS * 10,
      });
      const idle = makeMirror({
        identity: ADO_MAXVIEW,
        branch: 'main',
        bytes: 4 * MB,
        idleMs: REPO_CACHE_MIN_IDLE_MS * 10,
      });
      const matterworxDir = getRepoCacheDir({ ...ADO_MATTERWORX, branch: 'main' });

      // 12 MB before compaction, about 6.5 MB after.
      const result = await service({
        maxBytes: 10 * MB,
        readPackStats: (dir) => (dir === matterworxDir ? BLOATED_PACKS : HEALTHY_PACKS),
        compactMirror: compactTo(COMPACTED_PACKS),
      }).evictOverBudget();

      expect(result.compacted).toBe(1);
      expect(result.evicted).toBe(0);
      expect(fs.existsSync(idle)).toBe(true);
    });

    it('skips a recently used oversized mirror and compacts an idle one', async () => {
      const recent = makeMirror({
        identity: ADO_MATTERWORX,
        branch: 'main',
        bytes: 8 * MB,
        idleMs: REPO_CACHE_MIN_IDLE_MS / 2,
      });
      const idle = makeMirror({
        identity: ADO_MAXVIEW,
        branch: 'main',
        bytes: 8 * MB,
        idleMs: REPO_CACHE_MIN_IDLE_MS * 10,
      });
      const compactMirror = compactTo(COMPACTED_PACKS);

      const result = await service({
        maxBytes: 10 * 1024 * MB,
        readPackStats: () => BLOATED_PACKS,
        compactMirror,
      }).evictOverBudget();

      expect(compactMirror).toHaveBeenCalledTimes(1);
      expect(compactMirror).toHaveBeenCalledWith(idle, undefined);
      expect(compactMirror).not.toHaveBeenCalledWith(recent, expect.anything());
      expect(grantLease).toHaveBeenCalledTimes(1);
      expect(result.compacted).toBe(1);
    });

    it('re-checks idle under the lease and skips a mirror used while the sweep waited', async () => {
      const dir = makeMirror({
        identity: ADO_MATTERWORX,
        branch: 'main',
        bytes: 8 * MB,
        idleMs: REPO_CACHE_MIN_IDLE_MS * 10,
      });
      const compactMirror = compactTo(COMPACTED_PACKS);
      const leaseAfterUse = jest.fn(
        async (_key: string, operation: () => Promise<unknown>) => {
          const lastUsed = path.join(dir, 'apex-last-used');
          const stamp = new Date(NOW - 1_000);
          fs.utimesSync(lastUsed, stamp, stamp);
          return operation();
        },
      );
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

      const result = await service({
        maxBytes: 10 * 1024 * MB,
        withLease: leaseAfterUse,
        readPackStats: () => BLOATED_PACKS,
        compactMirror,
      }).evictOverBudget();

      expect(leaseAfterUse).toHaveBeenCalledTimes(1);
      expect(compactMirror).not.toHaveBeenCalled();
      expect(result.compacted).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('compact-deferred reason=oversized'));
      log.mockRestore();
    });

    it('skips a mirror whose lease is busy and leaves it for the next sweep', async () => {
      const dir = makeMirror({
        identity: ADO_MATTERWORX,
        branch: 'main',
        bytes: 8 * MB,
        idleMs: REPO_CACHE_MIN_IDLE_MS * 10,
      });
      const compactMirror = compactTo(HEALTHY_PACKS);
      const busyLease = jest.fn(async (key: string) => {
        throw new Error(`Timed out waiting for repository cache lease: ${key}`);
      });

      const result = await service({
        maxBytes: 10 * 1024 * MB,
        withLease: busyLease as never,
        readPackStats: () => BLOATED_PACKS,
        compactMirror,
      }).evictOverBudget();

      expect(busyLease).toHaveBeenCalledTimes(1);
      expect(compactMirror).not.toHaveBeenCalled();
      expect(result.compacted).toBe(0);
      expect(fs.existsSync(dir)).toBe(true);
    });

    it('keeps sweeping when one mirror fails to compact', async () => {
      makeMirror({
        identity: ADO_MATTERWORX,
        branch: 'main',
        bytes: 8 * MB,
        idleMs: REPO_CACHE_MIN_IDLE_MS * 10,
      });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      const result = await service({
        maxBytes: 10 * 1024 * MB,
        readPackStats: () => BLOATED_PACKS,
        compactMirror: jest.fn().mockRejectedValue(new Error('git repack timed out')),
      }).evictOverBudget();

      expect(result.compacted).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('phase=compact-failed reason=oversized'));
      warn.mockRestore();
    });

    it('does not touch a mirror without an identity sidecar', async () => {
      makeMirror({ identity: null, branch: 'main', bytes: 8 * MB, idleMs: REPO_CACHE_MIN_IDLE_MS * 10 });
      const compactMirror = compactTo(HEALTHY_PACKS);

      const result = await service({
        maxBytes: 10 * 1024 * MB,
        readPackStats: () => BLOATED_PACKS,
        compactMirror,
      }).evictOverBudget();

      expect(compactMirror).not.toHaveBeenCalled();
      expect(grantLease).not.toHaveBeenCalled();
      expect(result.compacted).toBe(0);
    });
  });
});
