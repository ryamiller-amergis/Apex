jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../services/groundingImpactEvaluatorService', () => ({
  groundingImpactEvaluatorService: {
    enqueue: jest.fn(),
  },
}));
jest.mock('../services/grounding/sharedReadCheckoutService', () => ({
  sharedReadCheckoutService: {
    materialize: jest.fn().mockResolvedValue({
      workspacePath: 'shared-checkout',
      outcome: 'materialized',
    }),
  },
}));
jest.mock('../services/featureFlagService', () => ({
  isProjectRepositoryCheckoutReadinessEnabledForProject: jest
    .fn()
    .mockResolvedValue(false),
}));

import type { PreWarmTarget } from '../../shared/types/runGrounding';
import {
  configuredPreWarmTargets,
  createGroundingPreWarmService,
  IDLE_REMOTE_PROBE_INTERVAL_MS,
  type GroundingPreWarmDependencies,
} from '../services/groundingPreWarmService';

const target: PreWarmTarget = {
  provider: 'github',
  project: 'Apex',
  repository: 'AI-Pilot',
  branch: 'main',
};

const flushAsyncWork = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

function createService(
  overrides: GroundingPreWarmDependencies = {},
) {
  return createGroundingPreWarmService({
    readRemoteTip: async () => null,
    listPinnedTargets: async () => [target],
    ...overrides,
  });
}

describe('TBI-007 groundingPreWarmService', () => {
  it('prepares configured project repositories before their first active run', () => {
    expect(
      configuredPreWarmTargets([
        {
          id: 'github-default',
          project: 'Apex',
          friendlyName: 'Apex',
          isDefault: true,
          skillProvider: 'github',
          skillRepo: 'amergis/AI-Pilot',
          skillBranch: 'main',
        },
        {
          id: 'github-duplicate',
          project: 'Apex',
          friendlyName: 'Apex duplicate',
          isDefault: false,
          skillProvider: 'github',
          skillRepo: 'AI-Pilot',
          skillBranch: 'main',
        },
        {
          id: 'ado-default',
          project: 'MaxView',
          friendlyName: 'MaxView',
          isDefault: true,
          skillProvider: 'ado',
          skillRepo: 'Platform/MaxView',
          skillBranch: 'develop',
        },
      ])
    ).toEqual([
      {
        provider: 'github',
        project: 'Apex',
        repository: 'AI-Pilot',
        branch: 'main',
      },
      {
        provider: 'azure_devops',
        project: 'MaxView',
        repository: 'Platform/MaxView',
        branch: 'develop',
      },
    ]);
  });

  it.each([false, true])(
    'PLAN-S1-DoD-0 preWarm publishes then materializes the exact SHA identity after coalesced=%s',
    async (coalesced) => {
      // Arrange
      const sha = 'b'.repeat(40);
      let leaseActive = false;
      const publishBundle = jest.fn(async () => {
        expect(leaseActive).toBe(false);
        return 'published' as const;
      });
      const materializeSharedCheckout = jest.fn(async () => {
        expect(leaseActive).toBe(false);
        return {
          workspacePath: 'shared-checkout',
          outcome: 'materialized' as const,
        };
      });
      const service = createService({
        withLease: jest.fn(async (_key, operation) => {
          leaseActive = true;
          await operation({
            signal: new AbortController().signal,
            assertOwned: jest.fn().mockResolvedValue(undefined),
          });
          leaseActive = false;
        }),
        refreshUnderLease: jest.fn().mockResolvedValue(undefined),
        wasRefreshedSince: jest.fn().mockReturnValue(coalesced),
        readCachedSha: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(sha),
        publishBundle,
        materializeSharedCheckout,
        telemetry: jest.fn(),
      });

      // Act
      await service.preWarm(target);

      // Assert
      expect(publishBundle).toHaveBeenCalledWith({
        identity: {
          provider: 'github',
          project: 'Apex',
          repo: 'AI-Pilot',
          sha,
        },
        cacheDir: expect.stringMatching(/repo-cache/),
        branch: 'main',
      });
      expect(materializeSharedCheckout).toHaveBeenCalledTimes(1);
      expect(materializeSharedCheckout).toHaveBeenCalledWith({
        provider: 'github',
        project: 'Apex',
        repo: 'AI-Pilot',
        branch: 'main',
        sha,
      });
      expect(publishBundle.mock.invocationCallOrder[0]).toBeLessThan(
        materializeSharedCheckout.mock.invocationCallOrder[0]
      );
    }
  );

  it('treats shared checkout prewarm failure as optional after mirror and bundle succeed', async () => {
    // Arrange
    const sha = 'b'.repeat(40);
    const refreshUnderLease = jest.fn().mockResolvedValue(undefined);
    const publishBundle = jest.fn().mockResolvedValue('published');
    const materializeSharedCheckout = jest
      .fn()
      .mockRejectedValue(new Error('shared checkout unavailable'));
    const telemetry = jest.fn();
    const service = createService({
      withLease: jest.fn(async (_key, operation) =>
        operation({
          signal: new AbortController().signal,
          assertOwned: jest.fn().mockResolvedValue(undefined),
        })
      ),
      refreshUnderLease,
      wasRefreshedSince: jest.fn().mockReturnValue(false),
      readCachedSha: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(sha),
      publishBundle,
      materializeSharedCheckout,
      telemetry,
    });

    // Act / Assert
    await expect(service.preWarm(target)).resolves.toBeUndefined();
    expect(refreshUnderLease).toHaveBeenCalledTimes(1);
    expect(publishBundle).toHaveBeenCalledTimes(1);
    expect(materializeSharedCheckout).toHaveBeenCalledTimes(1);
    expect(telemetry).toHaveBeenCalledWith(
      'grounding.shared.prewarm',
      expect.objectContaining({ outcome: 'failed' }),
    );
  });

  it('keeps a usable mirror warm when bundle publication fails', async () => {
    // Arrange
    const telemetry = jest.fn();
    const service = createService({
      withLease: jest.fn(async (_key, operation) =>
        operation({
          signal: new AbortController().signal,
          assertOwned: jest.fn().mockResolvedValue(undefined),
        })
      ),
      refreshUnderLease: jest.fn().mockResolvedValue(undefined),
      wasRefreshedSince: jest.fn().mockReturnValue(false),
      readCachedSha: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('b'.repeat(40)),
      publishBundle: jest.fn().mockRejectedValue(new Error('Blob unavailable')),
      telemetry,
    });

    // Act / Assert
    await expect(service.preWarm(target)).resolves.toBeUndefined();
    expect(telemetry).toHaveBeenCalledWith(
      'grounding.bundle.publish',
      expect.objectContaining({ outcome: 'failed' })
    );
  });

  it('DoD-0 coalesces concurrent refreshes and sweeps distinct active targets under a repository lease', async () => {
    // Arrange
    let releaseRefresh!: () => void;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshUnderLease = jest.fn(async () => refreshBlocked);
    const withLease = jest.fn(async (_key, operation) =>
      operation({
        signal: new AbortController().signal,
        assertOwned: jest.fn().mockResolvedValue(undefined),
      })
    );
    const listActiveTargets = jest.fn().mockResolvedValue([target]);
    const service = createService({
      listActiveTargets,
      withLease,
      refreshUnderLease,
      wasRefreshedSince: jest.fn().mockReturnValue(false),
      telemetry: jest.fn(),
      now: () => 100,
    });

    // Act
    const first = service.preWarm(target);
    const second = service.preWarm(target);
    releaseRefresh();
    await Promise.all([first, second]);
    await service.sweep();

    // Assert
    expect(withLease).toHaveBeenCalledTimes(2);
    expect(refreshUnderLease).toHaveBeenCalledTimes(2);
    expect(listActiveTargets).toHaveBeenCalledTimes(1);
    expect(withLease.mock.calls[0][0]).toMatch(/^repo-cache:/);
  });

  it('DoD-4 aborts on lease loss without retrying the mirror write', async () => {
    // Arrange
    const controller = new AbortController();
    const refreshUnderLease = jest.fn(async (_target, lease) => {
      controller.abort(new Error('lease lost'));
      lease.signal.throwIfAborted();
    });
    const service = createService({
      listActiveTargets: jest.fn().mockResolvedValue([]),
      withLease: jest.fn(async (_key, operation) =>
        operation({
          signal: controller.signal,
          assertOwned: jest.fn().mockRejectedValue(new Error('lease lost')),
        })
      ),
      refreshUnderLease,
      wasRefreshedSince: jest.fn().mockReturnValue(false),
      telemetry: jest.fn(),
    });

    // Act
    const result = service.preWarm(target);

    // Assert
    await expect(result).rejects.toThrow('lease lost');
    expect(refreshUnderLease).toHaveBeenCalledTimes(1);
  });

  it('DoD-0 coalesces queued cross-instance sweeps after the lease owner refreshes', async () => {
    // Arrange
    let refreshed = false;
    let leaseQueue = Promise.resolve();
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
    const refreshUnderLease = jest.fn(async () => {
      refreshed = true;
    });
    const dependencies = {
      listActiveTargets: jest.fn().mockResolvedValue([target]),
      withLease,
      refreshUnderLease,
      wasRefreshedSince: jest.fn(() => refreshed),
      telemetry: jest.fn(),
      now: () => 100,
    };
    const firstInstance = createService(dependencies);
    const secondInstance = createService(dependencies);

    // Act
    await Promise.all([firstInstance.sweep(), secondInstance.sweep()]);

    // Assert
    expect(withLease).toHaveBeenCalledTimes(2);
    expect(refreshUnderLease).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'AC-2 / TBI-008 DoD-2 enqueues a bounded branch move after %s coalesced refresh',
    async (coalesced) => {
      // Arrange
      const fromSha = 'a'.repeat(40);
      const toSha = 'b'.repeat(40);
      const readCachedSha = jest
        .fn()
        .mockResolvedValueOnce(fromSha)
        .mockResolvedValueOnce(toSha);
      const listChangedPaths = jest
        .fn()
        .mockResolvedValue(['src/server/a.ts', 'README.md']);
      const enqueueImpact = jest.fn();
      const refreshUnderLease = jest.fn().mockResolvedValue(undefined);
      const service = createService({
        withLease: jest.fn(async (_key, operation) =>
          operation({
            signal: new AbortController().signal,
            assertOwned: jest.fn().mockResolvedValue(undefined),
          })
        ),
        refreshUnderLease,
        wasRefreshedSince: jest.fn().mockReturnValue(coalesced),
        readCachedSha,
        listChangedPaths,
        enqueueImpact,
        telemetry: jest.fn(),
        now: () => 100,
      });

      // Act
      await service.preWarm(target);
      await flushAsyncWork();

      // Assert
      expect(refreshUnderLease).toHaveBeenCalledTimes(coalesced ? 0 : 1);
      expect(readCachedSha).toHaveBeenCalledTimes(2);
      expect(listChangedPaths).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'github',
          project: 'Apex',
          repo: 'AI-Pilot',
          branch: 'main',
        }),
        fromSha,
        toSha
      );
      expect(enqueueImpact).toHaveBeenCalledWith({
        provider: 'github',
        project: 'Apex',
        repository: 'AI-Pilot',
        branch: 'main',
        fromSha,
        toSha,
        changedFiles: ['src/server/a.ts', 'README.md'],
      });
    }
  );

  it.each([
    ['unchanged', 'a'.repeat(40), 'a'.repeat(40)],
    ['missing old SHA', null, 'b'.repeat(40)],
    ['missing new SHA', 'a'.repeat(40), null],
  ])(
    'AC-3 / TBI-008 DoD-2 ignores %s branch state',
    async (_label, fromSha, toSha) => {
      // Arrange
      const enqueueImpact = jest.fn();
      const service = createService({
        withLease: jest.fn(async (_key, operation) =>
          operation({
            signal: new AbortController().signal,
            assertOwned: jest.fn().mockResolvedValue(undefined),
          })
        ),
        refreshUnderLease: jest.fn().mockResolvedValue(undefined),
        wasRefreshedSince: jest.fn().mockReturnValue(false),
        readCachedSha: jest
          .fn()
          .mockResolvedValueOnce(fromSha)
          .mockResolvedValueOnce(toSha),
        listChangedPaths: jest.fn(),
        enqueueImpact,
        telemetry: jest.fn(),
      });

      // Act
      await service.preWarm(target);
      await flushAsyncWork();

      // Assert
      expect(enqueueImpact).not.toHaveBeenCalled();
    }
  );

  it('AC-3 keeps pre-warm non-blocking and successful when impact diff fails', async () => {
    // Arrange
    const fromSha = 'a'.repeat(40);
    const toSha = 'b'.repeat(40);
    let rejectDiff!: (reason: Error) => void;
    const pendingDiff = new Promise<string[]>((_resolve, reject) => {
      rejectDiff = reject;
    });
    const enqueueImpact = jest.fn();
    const service = createService({
      withLease: jest.fn(async (_key, operation) =>
        operation({
          signal: new AbortController().signal,
          assertOwned: jest.fn().mockResolvedValue(undefined),
        })
      ),
      refreshUnderLease: jest.fn().mockResolvedValue(undefined),
      wasRefreshedSince: jest.fn().mockReturnValue(false),
      readCachedSha: jest
        .fn()
        .mockResolvedValueOnce(fromSha)
        .mockResolvedValueOnce(toSha),
      listChangedPaths: jest.fn().mockReturnValue(pendingDiff),
      enqueueImpact,
      telemetry: jest.fn(),
    });

    // Act / Assert
    await expect(service.preWarm(target)).resolves.toBeUndefined();
    rejectDiff(new Error('diff unavailable'));
    await flushAsyncWork();
    expect(enqueueImpact).not.toHaveBeenCalled();
  });

  it('AC-2 bounds and sanitizes changed paths before impact enqueue', async () => {
    // Arrange
    const enqueueImpact = jest.fn();
    const safePaths = Array.from(
      { length: 205 },
      (_, index) => `src/file-${index}.ts`
    );
    const service = createService({
      withLease: jest.fn(async (_key, operation) =>
        operation({
          signal: new AbortController().signal,
          assertOwned: jest.fn().mockResolvedValue(undefined),
        })
      ),
      refreshUnderLease: jest.fn().mockResolvedValue(undefined),
      wasRefreshedSince: jest.fn().mockReturnValue(false),
      readCachedSha: jest
        .fn()
        .mockResolvedValueOnce('a'.repeat(40))
        .mockResolvedValueOnce('b'.repeat(40)),
      listChangedPaths: jest
        .fn()
        .mockResolvedValue([
          'C:\\private\\checkout.ts',
          '../outside.ts',
          '/absolute.ts',
          ...safePaths,
        ]),
      enqueueImpact,
      telemetry: jest.fn(),
    });

    // Act
    await service.preWarm(target);
    await flushAsyncWork();

    // Assert
    const changedFiles = enqueueImpact.mock.calls[0][0]
      .changedFiles as string[];
    expect(changedFiles).toHaveLength(200);
    expect(changedFiles[0]).toBe('src/file-0.ts');
    expect(changedFiles).not.toEqual(
      expect.arrayContaining([
        'C:\\private\\checkout.ts',
        '../outside.ts',
        '/absolute.ts',
      ])
    );
  });

  it('S13: checkout readiness ON makes preWarm a no-op (no publish / refresh)', async () => {
    const publishBundle = jest.fn();
    const refreshUnderLease = jest.fn();
    const materializeSharedCheckout = jest.fn();
    const service = createService({
      isCheckoutReadinessEnabled: jest.fn().mockResolvedValue(true),
      publishBundle,
      refreshUnderLease,
      materializeSharedCheckout,
      withLease: jest.fn(async (_key, operation) =>
        operation({
          signal: { throwIfAborted: () => undefined },
        } as never),
      ),
      wasRefreshedSince: jest.fn(),
      readCachedSha: jest.fn(),
      telemetry: jest.fn(),
    });

    await expect(service.preWarm(target)).resolves.toBeUndefined();

    expect(publishBundle).not.toHaveBeenCalled();
    expect(refreshUnderLease).not.toHaveBeenCalled();
    expect(materializeSharedCheckout).not.toHaveBeenCalled();
  });

  it('skips object fetch when ls-remote tip matches the cached SHA', async () => {
    const sha = 'b'.repeat(40);
    const refreshUnderLease = jest.fn();
    const publishBundle = jest.fn();
    const telemetry = jest.fn();
    const service = createService({
      readCachedSha: jest.fn().mockResolvedValue(sha),
      readRemoteTip: jest.fn().mockResolvedValue(sha),
      refreshUnderLease,
      publishBundle,
      withLease: jest.fn(async (_key, operation) =>
        operation({
          signal: new AbortController().signal,
          assertOwned: jest.fn().mockResolvedValue(undefined),
        }),
      ),
      telemetry,
    });

    await service.preWarm(target);

    expect(refreshUnderLease).not.toHaveBeenCalled();
    expect(publishBundle).not.toHaveBeenCalled();
    expect(telemetry).toHaveBeenCalledWith(
      'grounding.mirror.prewarm',
      expect.objectContaining({ outcome: 'unchanged' }),
      expect.any(Object),
    );
  });

  it('defers idle configured repos between probes and always probes active pins', async () => {
    const refreshUnderLease = jest.fn().mockResolvedValue(undefined);
    let nowMs = 1_000;
    const idleService = createService({
      listPinnedTargets: async () => [],
      now: () => nowMs,
      refreshUnderLease,
      withLease: jest.fn(async (_key, operation) =>
        operation({
          signal: new AbortController().signal,
          assertOwned: jest.fn().mockResolvedValue(undefined),
        }),
      ),
      wasRefreshedSince: jest.fn().mockReturnValue(false),
      readCachedSha: jest.fn().mockResolvedValue(null),
      telemetry: jest.fn(),
    });

    await idleService.preWarm(target);
    expect(refreshUnderLease).toHaveBeenCalledTimes(1);

    nowMs += IDLE_REMOTE_PROBE_INTERVAL_MS - 1;
    await idleService.preWarm(target);
    expect(refreshUnderLease).toHaveBeenCalledTimes(1);

    const activeRefresh = jest.fn().mockResolvedValue(undefined);
    const activeService = createService({
      listPinnedTargets: async () => [target],
      now: () => nowMs,
      refreshUnderLease: activeRefresh,
      withLease: jest.fn(async (_key, operation) =>
        operation({
          signal: new AbortController().signal,
          assertOwned: jest.fn().mockResolvedValue(undefined),
        }),
      ),
      wasRefreshedSince: jest.fn().mockReturnValue(false),
      readCachedSha: jest.fn().mockResolvedValue(null),
      telemetry: jest.fn(),
    });
    await activeService.preWarm(target);
    await activeService.preWarm(target);
    expect(activeRefresh).toHaveBeenCalledTimes(2);
  });
});
