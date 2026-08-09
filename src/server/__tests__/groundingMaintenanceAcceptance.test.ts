import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

jest.mock('../db/drizzle', () => ({ db: {} }));

import type {
  PreWarmTarget,
  RunGrounding,
  RunRef,
} from '../../shared/types/runGrounding';
import { createGroundingEvictionService } from '../services/groundingEvictionService';
import { createGroundingPreWarmService } from '../services/groundingPreWarmService';
import { createGroundingStalenessService } from '../services/groundingStalenessService';
import {
  createRunGroundingMaterializer,
  resolveRunGroundingWorkspacePath,
  type GroundingMaterializerDependencies,
} from '../services/runGroundingMaterializer';
import { type RunGroundingRepository } from '../services/runGroundingRepository';
import { createRunGroundingService } from '../services/runGroundingService';

const NOW = Date.parse('2026-08-02T16:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const SHA = 'a'.repeat(40);
const target: PreWarmTarget = {
  provider: 'github',
  project: 'Apex',
  repository: 'AI-Pilot',
  branch: 'main',
};

function grounding(
  runId: string,
  ageMs: number,
  overrides: Partial<RunGrounding> = {}
): RunGrounding {
  const groundedAt = new Date(NOW - ageMs).toISOString();
  return {
    id: `grounding-${runId}`,
    runType: 'chat',
    runId,
    project: 'Apex',
    repoRole: 'target',
    provider: 'github',
    repository: 'AI-Pilot',
    branch: 'main',
    groundedSha: SHA,
    groundedAt,
    isActive: true,
    createdAt: groundedAt,
    updatedAt: groundedAt,
    ...overrides,
  };
}

function repositoryFor(
  rows: RunGrounding[]
): jest.Mocked<RunGroundingRepository> {
  return {
    createGrounding: jest.fn(),
    activateGroundings: jest.fn(),
    copyGrounding: jest.fn(),
    findByRun: jest.fn(async (ref: RunRef) =>
      rows.filter(
        (row) =>
          row.runType === ref.runType &&
          row.runId === ref.runId &&
          row.project === ref.project
      )
    ),
    findActiveByRepoBranch: jest.fn(),
    listActiveGroundings: jest.fn(),
    listActiveTargets: jest.fn(),
    reground: jest.fn(),
    deactivateByRun: jest.fn(),
  };
}

describe('PBI-007 grounding maintenance acceptance', () => {
  it('AC-0 Given active repository rows, When concurrent sweeps and a later warm-cache request execute, Then one lease owner refreshes and coalescing is observable', async () => {
    // Arrange
    let refreshed = false;
    let leaseQueue = Promise.resolve();
    const telemetry = jest.fn();
    const lease = {
      signal: new AbortController().signal,
      assertOwned: jest.fn().mockResolvedValue(undefined),
    };
    const withLease = jest.fn(
      (_key: string, operation: (context: typeof lease) => Promise<void>) => {
        const queued = leaseQueue.then(() => operation(lease));
        leaseQueue = queued.then(() => undefined);
        return queued;
      }
    );
    const dependencies = {
      listActiveTargets: jest.fn().mockResolvedValue([target]),
      withLease,
      refreshUnderLease: jest.fn(async () => {
        refreshed = true;
      }),
      wasRefreshedSince: jest.fn(() => refreshed),
      telemetry,
      now: () => NOW,
    };
    const firstInstance = createGroundingPreWarmService(dependencies);
    const secondInstance = createGroundingPreWarmService(dependencies);

    // Act
    await Promise.all([firstInstance.sweep(), secondInstance.sweep()]);
    await secondInstance.preWarm(target);

    // Assert
    expect(dependencies.refreshUnderLease).toHaveBeenCalledTimes(1);
    expect(withLease).toHaveBeenCalledTimes(3);
    expect(telemetry).toHaveBeenCalledWith(
      'grounding.mirror.prewarm',
      expect.objectContaining({ outcome: 'refreshed' }),
      expect.any(Object)
    );
    expect(telemetry).toHaveBeenCalledWith(
      'grounding.mirror.prewarm',
      expect.objectContaining({ outcome: 'coalesced' }),
      expect.any(Object)
    );
  });

  it('AC-1 Given a failed exact-SHA materialization, When repair and retry also fail, Then controlled fallback is redacted and an unrelated workspace is untouched', async () => {
    // Arrange
    const dataRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'grounding-acceptance-repair-')
    );
    const unrelatedWorkspace = path.join(
      dataRoot,
      'grounding-workspaces',
      'unrelated-workspace'
    );
    await fs.mkdir(unrelatedWorkspace, { recursive: true });
    await fs.writeFile(path.join(unrelatedWorkspace, 'keep.txt'), 'untouched');
    const credential = 'ghp_acceptance_secret';
    const taintedRepository = `https://user:${credential}@github.example/ASM/AI-Pilot.git`;
    const source = grounding('repair-source', 0, {
      repository: taintedRepository,
    });
    const destinationRun: RunRef = {
      runType: 'chat',
      runId: 'repair-destination',
      project: 'Apex',
    };
    const createBundleStore: GroundingMaterializerDependencies['createBundleStore'] =
      jest.fn((options) => ({
        rehydrate: jest.fn(async (identity, destination) => {
          const repaired = await options.repairAndMaterialize({
            identity,
            destination,
          });
          return repaired
            ? { status: 'materialized' as const, source: 'repair' as const }
            : {
                status: 'remote-fallback' as const,
                reason: 'repair-failed' as const,
              };
        }),
      }));
    const repairRepoCache = jest.fn().mockResolvedValue({
      cacheDir: 'C:\\opaque-cache\\repo.git',
      remote: { url: 'https://example.invalid/repo.git' },
    });
    const telemetry = jest.fn();
    const runGit = jest
      .fn()
      .mockRejectedValue(new Error('missing pinned object'));
    const materialize = createRunGroundingMaterializer({
      dataRoot,
      createBundleStore,
      ensureRepoCache: jest.fn().mockResolvedValue({
        cacheDir: 'C:\\opaque-cache\\repo.git',
        remote: { url: 'https://example.invalid/repo.git' },
      }),
      repairRepoCache,
      materializeWorkspaceFromCache: jest.fn().mockResolvedValue(undefined),
      runGit,
      telemetry,
    });

    try {
      // Act
      const result = await materialize(source, destinationRun);

      // Assert
      expect(result).toBe('unavailable');
      expect(repairRepoCache).toHaveBeenCalledTimes(1);
      expect(
        runGit.mock.calls.filter(([args]) => args.includes('checkout'))
      ).toEqual([
        [
          expect.arrayContaining(['checkout', '--detach', SHA]),
          expect.anything(),
        ],
        [
          expect.arrayContaining(['checkout', '--detach', SHA]),
          expect.anything(),
        ],
      ]);
      expect(telemetry).toHaveBeenCalledWith(
        'grounding.materialization.fallback',
        expect.objectContaining({ reason: 'pinned-sha-unavailable' }),
        expect.objectContaining({ durationMs: expect.any(Number) }),
      );
      const operationalMetadata = JSON.stringify(telemetry.mock.calls);
      expect(operationalMetadata).not.toContain(credential);
      expect(operationalMetadata).not.toContain(
        resolveRunGroundingWorkspacePath(source, destinationRun, dataRoot)
      );
      await expect(
        fs.readFile(path.join(unrelatedWorkspace, 'keep.txt'), 'utf8')
      ).resolves.toBe('untouched');
    } finally {
      await fs.rm(dataRoot, { recursive: true, force: true });
    }
  });

  it('AC-2 Given runs exactly at 7 days, 50 commits, and 14 days, When status is evaluated, Then soft/soft/hard states are carried without changing or re-grounding pins', async () => {
    // Arrange
    const sevenDays = grounding('seven-days', 7 * DAY_MS);
    const fiftyCommits = grounding('fifty-commits', 0);
    const fourteenDays = grounding('fourteen-days', 14 * DAY_MS);
    const rows = [sevenDays, fiftyCommits, fourteenDays];
    const snapshots = rows.map((row) => ({ ...row }));
    const countCommitsBehind = jest.fn(async (row: RunGrounding) =>
      row.runId === 'fifty-commits' ? 50 : 0
    );
    const staleness = createGroundingStalenessService({
      now: () => NOW,
      countCommitsBehind,
      telemetry: jest.fn(),
    });
    const repository = repositoryFor(rows);
    const service = createRunGroundingService(repository, {
      readCachedOriginSha: jest.fn().mockResolvedValue(SHA),
      evaluateStaleness: staleness.evaluate,
    });

    // Act
    const statuses = await Promise.all(
      rows.map((row) =>
        service.getStatus(
          {
            runType: row.runType,
            runId: row.runId,
            project: row.project,
          },
          'target',
          true
        )
      )
    );

    // Assert
    expect(statuses.map((status) => status?.stalenessState)).toEqual([
      'soft-stale',
      'soft-stale',
      'hard-checkpoint',
    ]);
    expect(rows).toEqual(snapshots);
    expect(repository.reground).not.toHaveBeenCalled();
    expect(countCommitsBehind).toHaveBeenCalledTimes(2);
  });

  it('AC-3 Given active, recent inactive, and idle inactive worktrees, When eviction runs, Then only idle inactive storage is removed and the durable bundle remains', async () => {
    // Arrange
    const dataRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'grounding-acceptance-eviction-')
    );
    const active = grounding('active', 0);
    const activePath = resolveRunGroundingWorkspacePath(
      active,
      active,
      dataRoot
    );
    const workspacesRoot = path.join(dataRoot, 'workspaces', 'grounding');
    const idleInactive = path.join(workspacesRoot, 'idle-inactive');
    const recentInactive = path.join(workspacesRoot, 'recent-inactive');
    const durableBundle = path.join(
      dataRoot,
      'repo-grounding',
      'github',
      'apex',
      'ai-pilot',
      `${SHA}.bundle`
    );
    await Promise.all([
      fs.mkdir(activePath, { recursive: true }),
      fs.mkdir(idleInactive, { recursive: true }),
      fs.mkdir(recentInactive, { recursive: true }),
      fs.mkdir(path.dirname(durableBundle), { recursive: true }),
    ]);
    await fs.writeFile(durableBundle, 'durable');
    const idle = new Date(NOW - 30 * 60 * 1000 - 1);
    const recent = new Date(NOW - 30 * 60 * 1000 + 1);
    await fs.utimes(activePath, idle, idle);
    await fs.utimes(idleInactive, idle, idle);
    await fs.utimes(recentInactive, recent, recent);
    const service = createGroundingEvictionService({
      dataRoot,
      now: () => NOW,
      listActiveGroundings: jest.fn().mockResolvedValue([active]),
      telemetry: jest.fn(),
    });

    try {
      // Act
      const result = await service.evictIdle();

      // Assert
      expect(result).toEqual({ scanned: 3, evicted: 1, protected: 1 });
      await expect(fs.stat(activePath)).resolves.toBeDefined();
      await expect(fs.stat(idleInactive)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(fs.stat(recentInactive)).resolves.toBeDefined();
      await expect(fs.readFile(durableBundle, 'utf8')).resolves.toBe('durable');
    } finally {
      await fs.rm(dataRoot, { recursive: true, force: true });
    }
  });
});
