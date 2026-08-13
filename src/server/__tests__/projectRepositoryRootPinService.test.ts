jest.mock('../services/runGroundingService', () => ({
  runGroundingService: {
    activateGroundings: jest.fn(),
    reground: jest.fn(),
  },
}));

jest.mock('../services/repoCacheService', () => ({
  fetchRepositoryTip: jest.fn(),
}));

jest.mock('../services/grounding/sharedReadCheckoutService', () => ({
  sharedReadCheckoutService: {
    getReady: jest.fn(),
    materialize: jest.fn(),
    retain: jest.fn(),
  },
}));

jest.mock('../services/telemetry', () => ({
  trackEvent: jest.fn(),
}));

jest.mock('../services/featureFlagService', () => ({
  isGroundingEnabledForCaller: jest.fn().mockResolvedValue(true),
  isNativeReadEnabledForCaller: jest.fn().mockResolvedValue(false),
  isSharedReadCheckoutEnabledForCaller: jest.fn().mockResolvedValue(false),
  isProjectRepositoryCheckoutReadinessEnabled: jest.fn().mockResolvedValue(false),
}));

jest.mock('../services/nativeReadCapabilityService', () => ({
  evaluateNativeReadCapability: jest.fn().mockReturnValue({
    proven: false,
    reason: 'harness-not-run',
  }),
}));

jest.mock('../services/groundingProfileResolver', () => ({
  groundingProfileResolver: {
    registerConnectionProfile: jest.fn(),
    revokeProfile: jest.fn(),
  },
}));

jest.mock('../services/runImpactContextRegistry', () => ({
  runImpactContextRegistry: {
    register: jest.fn(),
    unregister: jest.fn(),
  },
}));

jest.mock('../services/runGroundingMaterializer', () => ({
  materializeRunGroundingWithPath: jest.fn(),
}));

jest.mock('../services/repositoryPreparationService', () => ({
  createRepositoryPreparationService: jest.fn().mockReturnValue({
    getReadyReadOnly: jest.fn(),
    prepareReadOnly: jest.fn(),
    prepareWritable: jest.fn(),
  }),
}));

jest.mock('../services/projectSettingsService', () => ({
  listSkillConfigsForProject: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/projectRepositoryCheckoutService', () => ({
  enqueueRepositoryCheckout: jest.fn().mockResolvedValue({ status: 'cloning' }),
}));

import type { RunGrounding, RunRef } from '../../shared/types/runGrounding';
import {
  pinProjectRepositoryRoot,
  ProjectRepositoryFetchError,
  ProjectRepositorySnapshotUnavailableError,
} from '../services/projectRepositoryRootPinService';
import {
  createCallerGroundingService,
  type CallerGroundingDependencies,
} from '../services/callerGroundingService';

const run: RunRef = {
  runType: 'chat',
  runId: 'thread-root-1',
  project: 'Apex',
};

const tipSha = 'c'.repeat(40);
const pinnedSha = 'a'.repeat(40);

const grounding: RunGrounding = {
  ...run,
  id: 'grounding-1',
  repoRole: 'target',
  provider: 'github',
  repository: 'AI-Pilot',
  branch: 'main',
  groundedSha: tipSha,
  groundedAt: '2026-08-02T12:00:00.000Z',
  isActive: true,
  createdAt: '2026-08-02T12:00:00.000Z',
  updatedAt: '2026-08-02T12:00:00.000Z',
};

describe('VT-10/11 — projectRepositoryRootPinService fetch-and-pin', () => {
  it('VT-10: new root uses fetchRepositoryTip, pins an already-ready snapshot, and never materializes', async () => {
    const fetchTip = jest.fn().mockResolvedValue({
      cacheDir: 'C:\\data\\workspaces\\repo-cache\\x',
      baseSha: tipSha,
      stale: false,
      remote: { url: 'https://example.test/repo.git', env: {} },
      mirrorHit: true,
    });
    const getReady = jest.fn().mockReturnValue({
      workspacePath: 'C:\\data\\workspaces\\grounding-shared\\digest',
      outcome: 'hit',
    });
    const materialize = jest.fn();
    const retain = jest.fn();
    const activateGroundings = jest.fn().mockResolvedValue({
      ok: true,
      durableGrounding: true,
      fallback: 'none',
      groundings: [grounding],
    });
    const track = jest.fn();

    const result = await pinProjectRepositoryRoot(
      {
        run,
        repository: {
          provider: 'github',
          project: 'Apex',
          repo: 'AI-Pilot',
          branch: 'main',
        },
        caller: 'chat-agent',
      },
      {
        fetchTip,
        sharedReadCheckout: { getReady, materialize, retain },
        groundingService: { activateGroundings },
        trackEvent: track,
      },
    );

    expect(fetchTip).toHaveBeenCalledWith({
      provider: 'github',
      project: 'Apex',
      repo: 'AI-Pilot',
      branch: 'main',
    });
    expect(materialize).not.toHaveBeenCalled();
    expect(getReady).toHaveBeenCalledWith(
      expect.objectContaining({ sha: tipSha }),
    );
    expect(activateGroundings).toHaveBeenCalledWith({
      run,
      target: {
        provider: 'github',
        repository: 'AI-Pilot',
        branch: 'main',
        groundedSha: tipSha,
      },
    });
    expect(result.sha).toBe(tipSha);
    expect(result.fetched).toBe(true);
    expect(track).toHaveBeenCalledWith(
      'grounding.fast_fetch',
      expect.objectContaining({ outcome: 'success' }),
      expect.any(Object),
    );
    expect(track).toHaveBeenCalledWith(
      'grounding.workflow_pin',
      expect.objectContaining({ outcome: 'success', sha: tipSha.slice(0, 12) }),
      expect.any(Object),
    );
  });

  it('VT-11: fetch failure does not fall back to a stale SHA', async () => {
    const fetchTip = jest.fn().mockRejectedValue(
      new Error('git fetch failed: network unreachable'),
    );
    const materialize = jest.fn();
    const activateGroundings = jest.fn();
    const track = jest.fn();

    await expect(
      pinProjectRepositoryRoot(
        {
          run,
          repository: {
            provider: 'github',
            project: 'Apex',
            repo: 'AI-Pilot',
            branch: 'main',
          },
          caller: 'interview',
        },
        {
          fetchTip,
          sharedReadCheckout: {
            getReady: jest.fn(),
            materialize,
            retain: jest.fn(),
          },
          groundingService: { activateGroundings },
          trackEvent: track,
        },
      ),
    ).rejects.toBeInstanceOf(ProjectRepositoryFetchError);

    expect(materialize).not.toHaveBeenCalled();
    expect(activateGroundings).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith(
      'grounding.fast_fetch',
      expect.objectContaining({ outcome: 'failed' }),
      expect.any(Object),
    );
  });

  it('VT-16: resume with existing grounding never fetches or repins to tip', async () => {
    const existing: RunGrounding = {
      ...grounding,
      groundedSha: pinnedSha,
    };
    const fetchTip = jest.fn();
    const getReady = jest.fn().mockReturnValue({
      workspacePath: 'C:\\data\\workspaces\\grounding-shared\\pinned',
      outcome: 'hit',
    });
    const materialize = jest.fn();
    const activateGroundings = jest.fn();

    const result = await pinProjectRepositoryRoot(
      {
        run,
        repository: {
          provider: 'github',
          project: 'Apex',
          repo: 'AI-Pilot',
          branch: 'main',
        },
        caller: 'chat-agent',
        existingGrounding: existing,
      },
      {
        fetchTip,
        sharedReadCheckout: {
          getReady,
          materialize,
          retain: jest.fn(),
        },
        groundingService: { activateGroundings },
        trackEvent: jest.fn(),
      },
    );

    expect(result.sha).toBe(pinnedSha);
    expect(result.fetched).toBe(false);
    expect(fetchTip).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
    expect(activateGroundings).not.toHaveBeenCalled();
    expect(getReady).toHaveBeenCalledWith(
      expect.objectContaining({ sha: pinnedSha }),
    );
  });

  it('AC-0: snapshot miss enqueues checkout and never calls materialize', async () => {
    const fetchTip = jest.fn().mockResolvedValue({
      cacheDir: 'C:\\data\\workspaces\\repo-cache\\x',
      baseSha: tipSha,
      stale: false,
      remote: { url: 'https://example.test/repo.git', env: {} },
    });
    const materialize = jest.fn();
    const onSnapshotMiss = jest.fn().mockResolvedValue(undefined);

    await expect(
      pinProjectRepositoryRoot(
        {
          run,
          repository: {
            provider: 'github',
            project: 'Apex',
            repo: 'AI-Pilot',
            branch: 'main',
          },
          caller: 'chat-agent',
        },
        {
          fetchTip,
          sharedReadCheckout: {
            getReady: jest.fn().mockReturnValue(null),
            materialize,
            retain: jest.fn(),
          },
          groundingService: { activateGroundings: jest.fn() },
          trackEvent: jest.fn(),
          onSnapshotMiss,
        },
      ),
    ).rejects.toBeInstanceOf(ProjectRepositorySnapshotUnavailableError);

    expect(materialize).not.toHaveBeenCalled();
    expect(onSnapshotMiss).toHaveBeenCalledWith(
      expect.objectContaining({ sha: tipSha }),
    );
  });
});

describe('VT-10/16 — callerGroundingService admin-managed root pin', () => {
  function deps(
    overrides: Partial<CallerGroundingDependencies> = {},
  ): CallerGroundingDependencies {
    return {
      isGroundingEnabledForCaller: jest.fn().mockResolvedValue(true),
      isNativeReadEnabledForCaller: jest.fn().mockResolvedValue(false),
      isSharedReadCheckoutEnabledForCaller: jest.fn().mockResolvedValue(false),
      isProjectRepositoryCheckoutReadinessEnabled: jest
        .fn()
        .mockResolvedValue(true),
      evaluateNativeReadCapability: jest.fn().mockReturnValue({
        proven: false,
        reason: 'harness-not-run',
      }),
      sharedReadCheckout: {
        getReady: jest.fn().mockReturnValue(null),
        materialize: jest.fn(),
        retain: jest.fn(),
        releaseRef: jest.fn(),
      },
      ensureRepoCache: jest.fn(),
      readCachedOriginSha: jest.fn().mockResolvedValue(tipSha),
      groundingService: {
        activateGroundings: jest.fn(),
        getGroundings: jest.fn().mockResolvedValue([]),
        findActiveByRepoBranch: jest.fn().mockResolvedValue([]),
        markTerminalInactive: jest.fn().mockResolvedValue(1),
        reground: jest.fn(),
      },
      materialize: jest.fn(),
      profiles: {
        registerConnectionProfile: jest.fn().mockReturnValue({
          id: 'profile-1',
          expiresAt: Date.now() + 60_000,
        }),
        revokeProfile: jest.fn(),
      },
      impactContexts: {
        register: jest.fn(),
        unregister: jest.fn(),
      },
      trackEvent: jest.fn(),
      pinProjectRepositoryRoot: jest.fn().mockResolvedValue({
        sha: tipSha,
        workspacePath: 'C:\\data\\workspaces\\grounding-shared\\digest',
        grounding,
        identity: {
          provider: 'github',
          project: 'Apex',
          repo: 'AI-Pilot',
          branch: 'main',
          sha: tipSha,
        },
        fetched: true,
      }),
      ...overrides,
    };
  }

  it('VT-10: flag ON new root calls pin helper and never ensureRepoCache', async () => {
    const d = deps();
    const service = createCallerGroundingService(d);
    const selected = await service.start({
      caller: 'chat-agent',
      userId: 'u1',
      run,
      repository: { provider: 'github', repo: 'AI-Pilot', branch: 'main' },
      reauthorize: async () => true,
      readOnlyShareable: true,
    });

    expect(selected.mode).toBe('local');
    if (selected.mode === 'local') {
      expect(selected.resolvedSha).toBe(tipSha);
    }
    expect(d.pinProjectRepositoryRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        run,
        existingGrounding: null,
      }),
    );
    expect(d.ensureRepoCache).not.toHaveBeenCalled();
  });

  it('VT-11: flag ON surfaces fetch failure without ensureRepoCache fallback', async () => {
    const d = deps({
      pinProjectRepositoryRoot: jest
        .fn()
        .mockRejectedValue(
          new ProjectRepositoryFetchError('Repository tip fetch failed'),
        ),
    });
    const service = createCallerGroundingService(d);

    await expect(
      service.start({
        caller: 'interview',
        userId: 'u1',
        run,
        repository: { provider: 'github', repo: 'AI-Pilot', branch: 'main' },
        reauthorize: async () => true,
        readOnlyShareable: true,
      }),
    ).rejects.toBeInstanceOf(ProjectRepositoryFetchError);

    expect(d.ensureRepoCache).not.toHaveBeenCalled();
  });

  it('VT-16: flag ON resume keeps exact pin and does not advance to latest tip', async () => {
    const existing: RunGrounding = { ...grounding, groundedSha: pinnedSha };
    const pinRoot = jest.fn().mockResolvedValue({
      sha: pinnedSha,
      workspacePath: 'C:\\data\\workspaces\\grounding-shared\\pinned',
      grounding: existing,
      identity: {
        provider: 'github',
        project: 'Apex',
        repo: 'AI-Pilot',
        branch: 'main',
        sha: pinnedSha,
      },
      fetched: false,
    });
    const d = deps({
      pinProjectRepositoryRoot: pinRoot,
      groundingService: {
        activateGroundings: jest.fn(),
        getGroundings: jest.fn().mockResolvedValue([existing]),
        findActiveByRepoBranch: jest.fn().mockResolvedValue([]),
        markTerminalInactive: jest.fn().mockResolvedValue(1),
        reground: jest.fn(),
      },
    });
    const service = createCallerGroundingService(d);
    const selected = await service.start({
      caller: 'chat-agent',
      userId: 'u1',
      run,
      repository: { provider: 'github', repo: 'AI-Pilot', branch: 'main' },
      reauthorize: async () => true,
      readOnlyShareable: true,
    });

    expect(selected.mode).toBe('local');
    if (selected.mode === 'local') {
      expect(selected.resolvedSha).toBe(pinnedSha);
    }
    expect(pinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        existingGrounding: existing,
      }),
    );
    expect(d.readCachedOriginSha).not.toHaveBeenCalled();
    expect(d.ensureRepoCache).not.toHaveBeenCalled();
  });

  it('S13: flag ON with shared-read also ON never prepareOnDemand / ensureRepoCache', async () => {
    const d = deps({
      isSharedReadCheckoutEnabledForCaller: jest.fn().mockResolvedValue(true),
      readCachedOriginSha: jest.fn().mockResolvedValue('c'.repeat(40)),
      sharedReadCheckout: {
        getReady: jest.fn().mockReturnValue(null),
        materialize: jest.fn(),
        retain: jest.fn(),
        releaseRef: jest.fn(),
      },
    });
    const service = createCallerGroundingService(d);
    const selected = await service.start({
      caller: 'chat-agent',
      userId: 'u1',
      run,
      repository: { provider: 'github', repo: 'AI-Pilot', branch: 'main' },
      reauthorize: async () => true,
      readOnlyShareable: true,
    });

    expect(selected.mode).toBe('local');
    expect(selected.mode).not.toBe('preparing');
    expect(d.pinProjectRepositoryRoot).toHaveBeenCalled();
    expect(d.ensureRepoCache).not.toHaveBeenCalled();
    expect(d.sharedReadCheckout.materialize).not.toHaveBeenCalled();
    expect(d.readCachedOriginSha).not.toHaveBeenCalled();
  });
});
