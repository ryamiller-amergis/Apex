jest.mock('../db/drizzle', () => ({ db: {} }));

import {
  createRunGroundingMaterializer,
  type GroundingMaterializerDependencies,
} from '../services/runGroundingMaterializer';
import type { RunGrounding, RunRef } from '../../shared/types/runGrounding';

const sha = 'a'.repeat(40);
const groundedAt = '2026-08-02T14:00:00.000Z';
const grounding: RunGrounding = {
  id: 'grounding-1',
  runType: 'chat',
  runId: 'source-thread',
  project: 'Apex',
  repoRole: 'target',
  provider: 'github',
  repository: 'AI-Pilot',
  branch: 'main',
  groundedSha: sha,
  groundedAt,
  isActive: true,
  createdAt: groundedAt,
  updatedAt: groundedAt,
};

function run(runId: string): RunRef {
  return { runType: 'chat', runId, project: 'Apex' };
}

describe('TBI-004 default independent grounding materializer', () => {
  it('DoD-0/DoD-1 uses distinct opaque destinations and passes the exact copied SHA', async () => {
    // Arrange
    const rehydrate = jest.fn().mockResolvedValue({
      status: 'materialized',
      source: 'bundle',
    });
    const createBundleStore = jest.fn(() => ({ rehydrate }));
    const materialize = createRunGroundingMaterializer({
      dataRoot: 'C:\\persistent-data',
      createBundleStore,
    });

    // Act
    const first = await materialize(grounding, run('prd-thread'));
    const second = await materialize(grounding, run('design-doc-thread'));

    // Assert
    expect(first).toBe('materialized');
    expect(second).toBe('materialized');
    expect(rehydrate).toHaveBeenCalledTimes(2);
    const [firstIdentity, firstDestination] = rehydrate.mock.calls[0];
    const [secondIdentity, secondDestination] = rehydrate.mock.calls[1];
    expect(firstIdentity).toEqual({
      provider: 'github',
      project: 'Apex',
      repo: 'AI-Pilot',
      sha,
    });
    expect(secondIdentity.sha).toBe(sha);
    expect(firstDestination).not.toBe(secondDestination);
    expect(firstDestination).toMatch(
      new RegExp(`grounding-workspaces[\\\\/]\\w+$`)
    );
    expect(firstDestination).not.toContain('prd-thread');
    expect(secondDestination).not.toContain('design-doc-thread');
  });

  it('DoD-0/DoD-1 returns controlled unavailable when bundle materialization falls back', async () => {
    // Arrange
    const createBundleStore = jest.fn(() => ({
      rehydrate: jest.fn().mockResolvedValue({
        status: 'remote-fallback',
        reason: 'repair-failed',
      }),
    }));
    const materialize = createRunGroundingMaterializer({
      dataRoot: 'C:\\persistent-data',
      createBundleStore,
    });

    // Act
    const result = await materialize(grounding, run('prd-thread'));

    // Assert
    expect(result).toBe('unavailable');
    expect(grounding.groundedSha).toBe(sha);
  });

  it('DoD-0/DoD-1 repair clones cache then detach-checks out the copied SHA', async () => {
    // Arrange
    const createBundleStore: GroundingMaterializerDependencies['createBundleStore'] =
      jest.fn((options) => {
        return {
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
        };
      });
    const ensureRepoCache = jest.fn().mockResolvedValue({
      cacheDir: 'C:\\cache\\repo.git',
      remote: { url: 'https://example.invalid/repo.git' },
    });
    const materializeWorkspaceFromCache = jest
      .fn()
      .mockResolvedValue(undefined);
    const runGit = jest.fn().mockResolvedValue('');
    const materialize = createRunGroundingMaterializer({
      dataRoot: 'C:\\persistent-data',
      createBundleStore,
      ensureRepoCache,
      materializeWorkspaceFromCache,
      runGit,
    });

    // Act
    const repaired = await materialize(grounding, run('prd-thread'));

    // Assert
    expect(repaired).toBe('materialized');
    expect(ensureRepoCache).toHaveBeenCalledWith({
      provider: 'github',
      project: 'Apex',
      repo: 'AI-Pilot',
      branch: 'main',
    });
    expect(materializeWorkspaceFromCache).toHaveBeenCalledWith(
      'C:\\cache\\repo.git',
      expect.stringMatching(/grounding-workspaces/),
      'main',
      'https://example.invalid/repo.git'
    );
    const destination = materializeWorkspaceFromCache.mock.calls[0][1];
    expect(runGit).toHaveBeenCalledWith(
      expect.arrayContaining(['checkout', '--detach', sha]),
      { cwd: destination }
    );
  });

  it('writes through a repaired mirror without delaying materialization', async () => {
    // Arrange
    const publishBundle = jest.fn().mockResolvedValue('published');
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
    const materialize = createRunGroundingMaterializer({
      dataRoot: 'C:\\persistent-data',
      createBundleStore,
      ensureRepoCache: jest.fn().mockResolvedValue({
        cacheDir: 'C:\\cache\\repo.git',
        remote: { url: 'https://example.invalid/repo.git' },
      }),
      materializeWorkspaceFromCache: jest.fn().mockResolvedValue(undefined),
      runGit: jest.fn().mockResolvedValue(''),
      publishBundle,
    });

    // Act
    await expect(materialize(grounding, run('write-through'))).resolves.toBe(
      'materialized'
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Assert
    expect(publishBundle).toHaveBeenCalledWith({
      identity: {
        provider: 'github',
        project: 'Apex',
        repo: 'AI-Pilot',
        sha,
      },
      cacheDir: 'C:\\cache\\repo.git',
      branch: 'main',
    });
  });

  it('TBI-007 DoD-1 repairs a verified mirror then retries the exact pinned SHA', async () => {
    // Arrange
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
    const ensureRepoCache = jest.fn().mockResolvedValue({
      cacheDir: 'C:\\cache\\repo.git',
      remote: { url: 'https://example.invalid/repo.git' },
    });
    const repairRepoCache = jest.fn().mockResolvedValue({
      cacheDir: 'C:\\cache\\repo.git',
      remote: { url: 'https://example.invalid/repo.git' },
    });
    const materializeWorkspaceFromCache = jest
      .fn()
      .mockResolvedValue(undefined);
    let checkoutAttempts = 0;
    const runGit = jest.fn(async (args: string[]) => {
      if (args.includes('checkout') && ++checkoutAttempts === 1) {
        throw new Error('missing pinned object');
      }
      return '';
    });
    const materialize = createRunGroundingMaterializer({
      dataRoot: 'C:\\persistent-data',
      createBundleStore,
      ensureRepoCache,
      repairRepoCache,
      materializeWorkspaceFromCache,
      runGit,
      telemetry: jest.fn(),
    });

    // Act
    const result = await materialize(grounding, run('repair-thread'));

    // Assert
    expect(result).toBe('materialized');
    expect(repairRepoCache).toHaveBeenCalledTimes(1);
    expect(materializeWorkspaceFromCache).toHaveBeenCalledTimes(2);
    expect(
      runGit.mock.calls.filter(([args]) => args.includes('checkout'))
    ).toEqual([
      [
        expect.arrayContaining(['checkout', '--detach', sha]),
        expect.anything(),
      ],
      [
        expect.arrayContaining(['checkout', '--detach', sha]),
        expect.anything(),
      ],
    ]);
  });

  it('TBI-007 DoD-1 uses controlled remote fallback telemetry only after exact-SHA retry fails', async () => {
    // Arrange
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
      cacheDir: 'C:\\cache\\repo.git',
      remote: { url: 'https://example.invalid/repo.git' },
    });
    const runGit = jest
      .fn()
      .mockRejectedValue(new Error('missing pinned object'));
    const telemetry = jest.fn();
    const materialize = createRunGroundingMaterializer({
      dataRoot: 'C:\\persistent-data',
      createBundleStore,
      ensureRepoCache: jest.fn().mockResolvedValue({
        cacheDir: 'C:\\cache\\repo.git',
        remote: { url: 'https://example.invalid/repo.git' },
      }),
      repairRepoCache,
      materializeWorkspaceFromCache: jest.fn().mockResolvedValue(undefined),
      runGit,
      telemetry,
    });

    // Act
    const result = await materialize(grounding, run('fallback-thread'));

    // Assert
    expect(result).toBe('unavailable');
    expect(repairRepoCache).toHaveBeenCalledTimes(1);
    expect(runGit).toHaveBeenCalledTimes(2);
    expect(telemetry).toHaveBeenCalledWith(
      'grounding.materialization.fallback',
      {
        provider: 'github',
        project: 'Apex',
        repository: 'AI-Pilot',
        branch: 'main',
        reason: 'pinned-sha-unavailable',
      }
    );
  });
});
