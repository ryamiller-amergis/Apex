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
  it('coalesces concurrent requests for the same writable destination', async () => {
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const rehydrate = jest.fn(async () => {
      await blocked;
      return { status: 'materialized' as const, source: 'bundle' as const };
    });
    const materialize = createRunGroundingMaterializer({
      dataRoot: 'C:\\persistent-data',
      createBundleStore: jest.fn(() => ({ rehydrate })),
    });
    const destinationRun = run('coalesced-thread');

    const first = materialize(grounding, destinationRun);
    const second = materialize(grounding, destinationRun);
    finish();

    await expect(Promise.all([first, second])).resolves.toEqual([
      'materialized',
      'materialized',
    ]);
    expect(rehydrate).toHaveBeenCalledTimes(1);
  });

  it('AC-2 / VT-03 / BR-007 reconciles the same deterministic workspace on re-promotion', async () => {
    const destinations: string[] = [];
    const createBundleStore = jest.fn(() => ({
      rehydrate: jest.fn().mockImplementation(
        async (_identity: unknown, destination: string) => {
          destinations.push(destination);
          return { status: 'materialized', source: 'bundle' };
        },
      ),
    }));
    const materialize = createRunGroundingMaterializer({
      dataRoot: 'C:\\persistent-data',
      createBundleStore,
    });
    const destinationRun = run('re-promoted-thread');

    await expect(materialize(grounding, destinationRun)).resolves.toBe('materialized');
    await expect(materialize(grounding, destinationRun)).resolves.toBe('materialized');

    expect(destinations).toHaveLength(2);
    expect(destinations[1]).toBe(destinations[0]);
  });

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
      new RegExp(`workspaces[\\\\/]grounding[\\\\/]\\w+$`)
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
      expect.stringMatching(/[\\/]workspaces[\\/]grounding[\\/]/),
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
    expect(repairRepoCache).not.toHaveBeenCalled();
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
    expect(runGit).toHaveBeenCalledTimes(3);
    expect(telemetry).toHaveBeenCalledWith(
      'grounding.materialization.fallback',
      expect.objectContaining({
        provider: 'github',
        project: 'Apex',
        repository: 'AI-Pilot',
        branch: 'main',
        reason: 'pinned-sha-unavailable',
        outcome: 'unavailable',
      }),
      expect.objectContaining({ durationMs: expect.any(Number) }),
    );
  });

  it('TBI-002 DoD-0 / VT-10 attempts one 45-second exact-commit fetch after a pinned miss', async () => {
    const exactCommitFetch = jest.fn().mockResolvedValue(undefined);
    let checkoutAttempts = 0;
    const runGit = jest.fn(async (args: string[]) => {
      if (args.includes('checkout') && ++checkoutAttempts === 1) {
        throw new Error('pinned commit missing');
      }
      return '';
    });
    const createBundleStore: GroundingMaterializerDependencies['createBundleStore'] =
      jest.fn((options) => ({
        rehydrate: jest.fn(async (identity, destination) => (
          await options.repairAndMaterialize({ identity, destination })
            ? { status: 'materialized' as const, source: 'repair' as const }
            : { status: 'remote-fallback' as const, reason: 'repair-failed' as const }
        )),
      }));
    const materialize = createRunGroundingMaterializer({
      dataRoot: 'C:\\persistent-data',
      createBundleStore,
      ensureRepoCache: jest.fn().mockResolvedValue({
        cacheDir: 'C:\\cache\\repo.git',
        remote: {
          url: 'https://example.invalid/repo.git',
          env: {},
          secret: 'not-exported',
        },
      }),
      materializeWorkspaceFromCache: jest.fn().mockResolvedValue(undefined),
      runGit,
      exactCommitFetch,
    });

    await expect(materialize(grounding, run('exact-fetch'))).resolves.toBe('materialized');
    expect(exactCommitFetch).toHaveBeenCalledTimes(1);
    expect(exactCommitFetch).toHaveBeenCalledWith(
      expect.objectContaining({ cacheDir: 'C:\\cache\\repo.git' }),
      sha,
      45_000,
    );
  });

  it('TBI-002 DoD-1/DoD-2 reports bounded fallback after exact-commit timeout', async () => {
    const telemetry = jest.fn();
    const createBundleStore: GroundingMaterializerDependencies['createBundleStore'] =
      jest.fn((options) => ({
        rehydrate: jest.fn(async (identity, destination) => (
          await options.repairAndMaterialize({ identity, destination })
            ? { status: 'materialized' as const, source: 'repair' as const }
            : { status: 'remote-fallback' as const, reason: 'repair-failed' as const }
        )),
      }));
    const materialize = createRunGroundingMaterializer({
      dataRoot: 'C:\\persistent-data',
      createBundleStore,
      ensureRepoCache: jest.fn().mockResolvedValue({
        cacheDir: 'C:\\cache\\repo.git',
        remote: {
          url: 'https://user:secret@example.invalid/repo.git',
          env: {},
          secret: 'not-exported',
        },
      }),
      repairRepoCache: jest.fn().mockRejectedValue(new Error('unavailable')),
      materializeWorkspaceFromCache: jest.fn().mockRejectedValue(new Error('missing')),
      exactCommitFetch: jest.fn().mockRejectedValue(new Error('timed out')),
      telemetry,
      now: jest.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(46_000),
    });

    await expect(materialize(grounding, run('exact-timeout'))).resolves.toBe('unavailable');
    expect(telemetry).toHaveBeenCalledWith(
      'grounding.materialization.fallback',
      expect.objectContaining({
        reason: 'pinned-sha-unavailable',
        outcome: 'unavailable',
      }),
      { durationMs: 45_000 },
    );
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain('user:secret');
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain('not-exported');
  });

  it('TBI-002 DoD-3 keeps telemetry export failure from failing materialization', async () => {
    const createBundleStore: GroundingMaterializerDependencies['createBundleStore'] =
      jest.fn((options) => ({
        rehydrate: jest.fn(async (identity, destination) => (
          await options.repairAndMaterialize({ identity, destination })
            ? { status: 'materialized' as const, source: 'repair' as const }
            : { status: 'remote-fallback' as const, reason: 'repair-failed' as const }
        )),
      }));
    const materialize = createRunGroundingMaterializer({
      dataRoot: 'C:\\persistent-data',
      createBundleStore,
      ensureRepoCache: jest.fn().mockResolvedValue({
        cacheDir: 'C:\\cache\\repo.git',
        remote: { url: 'https://example.invalid/repo.git', env: {}, secret: '' },
      }),
      repairRepoCache: jest.fn().mockRejectedValue(new Error('unavailable')),
      materializeWorkspaceFromCache: jest.fn().mockRejectedValue(new Error('missing')),
      exactCommitFetch: jest.fn().mockRejectedValue(new Error('unavailable')),
      telemetry: jest.fn(() => {
        throw new Error('Application Insights unavailable');
      }),
    });

    await expect(materialize(grounding, run('telemetry-failure'))).resolves.toBe('unavailable');
  });

  it('S13: checkout readiness ON skips Blob rehydrate and publish', async () => {
    const rehydrate = jest.fn();
    const publishBundle = jest.fn();
    const ensureRepoCache = jest.fn().mockResolvedValue({
      cacheDir: 'C:\\cache\\repo.git',
      remote: { url: 'https://example.invalid/repo.git', env: {}, secret: '' },
    });
    const materializeWorkspaceFromCache = jest.fn().mockResolvedValue(undefined);
    const runGit = jest.fn().mockResolvedValue('');
    const materialize = createRunGroundingMaterializer({
      dataRoot: 'C:\\persistent-data',
      isCheckoutReadinessEnabled: jest.fn().mockResolvedValue(true),
      createBundleStore: jest.fn(() => ({ rehydrate })),
      publishBundle,
      ensureRepoCache,
      materializeWorkspaceFromCache,
      runGit,
      telemetry: jest.fn(),
    });

    await expect(materialize(grounding, run('s13-local-only'))).resolves.toBe(
      'materialized',
    );

    expect(rehydrate).not.toHaveBeenCalled();
    expect(publishBundle).not.toHaveBeenCalled();
    expect(ensureRepoCache).toHaveBeenCalled();
    expect(materializeWorkspaceFromCache).toHaveBeenCalled();
  });

  it('readiness ON reuses the local shared read checkout on a pinned-SHA miss (no cold clone, no fetch)', async () => {
    const repairRepoCache = jest.fn();
    const exactCommitFetch = jest.fn();
    // Warm-mirror materialize can't serve the pinned SHA from its branch tip.
    const materializeWorkspaceFromCache = jest
      .fn()
      .mockRejectedValue(new Error('pinned commit not on branch tip'));
    const runGit = jest.fn().mockResolvedValue('');
    const telemetry = jest.fn();
    const materialize = createRunGroundingMaterializer({
      dataRoot: 'C:\\persistent-data',
      isCheckoutReadinessEnabled: jest.fn().mockResolvedValue(true),
      createBundleStore: jest.fn(() => ({ rehydrate: jest.fn() })),
      ensureRepoCache: jest.fn().mockResolvedValue({
        cacheDir: 'C:\\cache\\repo.git',
        remote: { url: 'https://example.invalid/repo.git', env: {}, secret: '' },
      }),
      repairRepoCache,
      exactCommitFetch,
      materializeWorkspaceFromCache,
      getReadySharedCheckoutPath: jest.fn().mockReturnValue('C:\\shared\\pinned'),
      runGit,
      telemetry,
    });

    await expect(
      materialize(grounding, run('reuse-local-sha')),
    ).resolves.toBe('materialized');

    // Never cold-cloned or network-fetched during generation.
    expect(repairRepoCache).not.toHaveBeenCalled();
    expect(exactCommitFetch).not.toHaveBeenCalled();
    // Seeded via a purely local clone of the already-materialized shared tree.
    const cloneCall = runGit.mock.calls.find(([args]) => args.includes('clone'));
    expect(cloneCall?.[0]).toEqual(
      expect.arrayContaining(['clone', '--local', 'C:\\shared\\pinned']),
    );
    expect(runGit).toHaveBeenCalledWith(
      expect.arrayContaining(['checkout', '--detach', sha]),
      expect.objectContaining({ cwd: expect.any(String) }),
    );
    expect(telemetry).toHaveBeenCalledWith(
      'grounding.materialization.local-reuse',
      expect.objectContaining({ source: 'shared-read-checkout', outcome: 'materialized' }),
      expect.objectContaining({ durationMs: expect.any(Number) }),
    );
  });

  it('readiness ON fails fast to unavailable when no local SHA exists (still no cold clone)', async () => {
    const repairRepoCache = jest.fn();
    const exactCommitFetch = jest.fn();
    const telemetry = jest.fn();
    const materialize = createRunGroundingMaterializer({
      dataRoot: 'C:\\persistent-data',
      isCheckoutReadinessEnabled: jest.fn().mockResolvedValue(true),
      createBundleStore: jest.fn(() => ({ rehydrate: jest.fn() })),
      ensureRepoCache: jest.fn().mockResolvedValue({
        cacheDir: 'C:\\cache\\repo.git',
        remote: { url: 'https://example.invalid/repo.git', env: {}, secret: '' },
      }),
      repairRepoCache,
      exactCommitFetch,
      materializeWorkspaceFromCache: jest
        .fn()
        .mockRejectedValue(new Error('pinned commit missing')),
      getReadySharedCheckoutPath: jest.fn().mockReturnValue(null),
      runGit: jest.fn().mockResolvedValue(''),
      telemetry,
    });

    await expect(
      materialize(grounding, run('no-local-sha')),
    ).resolves.toBe('unavailable');
    expect(repairRepoCache).not.toHaveBeenCalled();
    expect(exactCommitFetch).not.toHaveBeenCalled();
    expect(telemetry).toHaveBeenCalledWith(
      'grounding.materialization.fallback',
      expect.objectContaining({
        reason: 'pinned-sha-unavailable',
        outcome: 'unavailable',
      }),
      expect.objectContaining({ durationMs: expect.any(Number) }),
    );
  });
});
