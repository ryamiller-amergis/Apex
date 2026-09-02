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
  REPO_CACHE_MIN_IDLE_MS,
  createRepoCacheEvictionService,
} from '../services/repoCacheEvictionService';
import {
  getRepoCacheDir,
  getRepoCacheLeaseKey,
  type RepoCacheIdentity,
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
}) {
  return createRepoCacheEvictionService({
    dataRoot: DATA_ROOT,
    maxBytes: overrides.maxBytes,
    now: () => NOW,
    listActiveGroundings: async () => overrides.activeGroundings ?? [],
    withLease: (overrides.withLease ?? grantLease) as never,
    telemetry: jest.fn(),
  });
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
});
