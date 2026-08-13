import type { RunGrounding, RunRef } from '../../shared/types/runGrounding';
import type { GroundingProfileId } from '../../shared/types/repoReader';
import type { GroundingBinding } from '../../shared/types/chat';
import {
  callerGroundingSelectionToBinding,
  createCallerGroundingService,
  evaluateBindingContinuity,
  type CallerGroundingDependencies,
} from '../services/callerGroundingService';
import { USER_FACING_REPO_CACHE_LEASE_WAIT_MS } from '../services/repoCacheLeaseService';

const run: RunRef = {
  runType: 'chat',
  runId: 'thread-1',
  project: 'Apex',
};
const grounding: RunGrounding = {
  ...run,
  id: 'grounding-1',
  repoRole: 'target',
  provider: 'github',
  repository: 'AI-Pilot',
  branch: 'main',
  groundedSha: 'a'.repeat(40),
  groundedAt: '2026-08-02T12:00:00.000Z',
  isActive: true,
  createdAt: '2026-08-02T12:00:00.000Z',
  updatedAt: '2026-08-02T12:00:00.000Z',
};
const profileId = 'opaque-profile' as GroundingProfileId;

function dependencies(
  overrides: Partial<CallerGroundingDependencies> = {}
): CallerGroundingDependencies {
  return {
    isGroundingEnabledForCaller: jest.fn().mockResolvedValue(true),
    isNativeReadEnabledForCaller: jest.fn().mockResolvedValue(false),
    isSharedReadCheckoutEnabledForCaller: jest.fn().mockResolvedValue(false),
    isProjectRepositoryCheckoutReadinessEnabled: jest.fn().mockResolvedValue(false),
    evaluateNativeReadCapability: jest.fn().mockReturnValue({
      proven: false,
      reason: 'harness-not-run',
    }),
    isUsableBareMirror: jest.fn().mockReturnValue(false),
    sharedReadCheckout: {
      getReady: jest.fn().mockReturnValue(null),
      materialize: jest.fn().mockResolvedValue({
        workspacePath: 'C:\\data\\workspaces\\grounding-shared\\digest',
        outcome: 'materialized',
      }),
      retain: jest.fn(),
      releaseRef: jest.fn(),
    },
    ensureRepoCache: jest.fn().mockResolvedValue({
      baseSha: grounding.groundedSha,
    }),
    readCachedOriginSha: jest.fn().mockResolvedValue(grounding.groundedSha),
    groundingService: {
      activateGroundings: jest.fn().mockResolvedValue({
        ok: true,
        durableGrounding: true,
        fallback: 'none',
        groundings: [grounding],
      }),
      getGroundings: jest.fn().mockResolvedValue([grounding]),
      findActiveByRepoBranch: jest.fn().mockResolvedValue([grounding]),
      markTerminalInactive: jest.fn().mockResolvedValue(1),
      reground: jest.fn().mockImplementation(async (_run, _role, newSha) => ({
        ...grounding,
        groundedSha: newSha,
      })),
    },
    materialize: jest.fn().mockResolvedValue({
      state: 'materialized',
      workspacePath: 'C:\\data\\grounding-workspaces\\opaque',
    }),
    profiles: {
      registerConnectionProfile: jest.fn().mockReturnValue({
        id: profileId,
        expiresAt: Date.now() + 60_000,
      }),
      revokeProfile: jest.fn(),
    },
    impactContexts: {
      register: jest.fn(),
      unregister: jest.fn(),
    },
    trackEvent: jest.fn(),
    ...overrides,
  };
}

describe('PBI-005 shared caller grounding startup', () => {
  it('AC-0 resolves one profile checkout for chatAgentService-backed callers', async () => {
    // Arrange
    const deps = dependencies();
    const service = createCallerGroundingService(deps);

    // Act
    const selected = await service.start({
      caller: 'chat-agent',
      userId: 'developer-1',
      run,
      repository: {
        provider: 'github',
        repo: 'AI-Pilot',
        branch: 'main',
      },
      reauthorize: async () => true,
    });

    // Assert
    expect(selected).toMatchObject({
      mode: 'local',
      cwd: 'C:\\data\\grounding-workspaces\\opaque',
      profileId,
    });
    expect(deps.isGroundingEnabledForCaller).toHaveBeenCalledWith(
      {
        caller: 'chat-agent',
        project: 'Apex',
        userId: 'developer-1',
      },
      expect.any(Function)
    );
    expect(deps.groundingService.getGroundings).toHaveBeenCalledWith(run);
    expect(deps.materialize).toHaveBeenCalledWith(grounding, run);
    expect(deps.profiles.registerConnectionProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        runRef: 'chat:thread-1',
        checkoutPath: 'C:\\data\\grounding-workspaces\\opaque',
        repo: 'AI-Pilot',
        sha: grounding.groundedSha,
      }),
      {
        userId: 'developer-1',
        runRef: 'chat:thread-1',
        project: 'Apex',
      },
      expect.any(Function)
    );
    expect(deps.impactContexts.register).toHaveBeenCalledWith(run, {
      authorId: 'developer-1',
      title: 'Chat agent run',
      link: '/home',
      caller: 'chat-agent',
    });

    await selected.release();
    expect(deps.groundingService.markTerminalInactive).toHaveBeenCalledWith(
      run
    );
    expect(deps.profiles.revokeProfile).toHaveBeenCalledWith(profileId);
    expect(deps.impactContexts.unregister).toHaveBeenCalledWith(run);

    const persistDeps = dependencies();
    const persistService = createCallerGroundingService(persistDeps);
    const persistSelected = await persistService.start({
      caller: 'chat-agent',
      userId: 'developer-1',
      run,
      repository: {
        provider: 'github',
        repo: 'AI-Pilot',
        branch: 'main',
      },
      reauthorize: async () => true,
    });
    if (persistSelected.mode !== 'local') {
      throw new Error(`expected local grounding, got ${persistSelected.mode}`);
    }
    await persistSelected.release({ persistPin: true });
    expect(persistDeps.groundingService.markTerminalInactive).not.toHaveBeenCalled();
  });

  it('AC-0 creates a run grounding when the caller has no existing pin', async () => {
    // Arrange
    const deps = dependencies();
    jest.mocked(deps.groundingService.getGroundings).mockResolvedValue([]);
    const service = createCallerGroundingService(deps);

    // Act
    const selected = await service.start({
      caller: 'walkthrough-generation',
      userId: 'developer-1',
      run,
      repository: {
        provider: 'github',
        repo: 'AI-Pilot',
        branch: 'main',
      },
      reauthorize: async () => true,
    });

    // Assert
    expect(selected.mode).toBe('local');
    expect(deps.ensureRepoCache).toHaveBeenCalledWith(
      {
        provider: 'github',
        project: 'Apex',
        repo: 'AI-Pilot',
        branch: 'main',
      },
      { waitMs: USER_FACING_REPO_CACHE_LEASE_WAIT_MS },
    );
    expect(deps.groundingService.activateGroundings).toHaveBeenCalledWith({
      run,
      target: {
        provider: 'github',
        repository: 'AI-Pilot',
        branch: 'main',
        groundedSha: grounding.groundedSha,
      },
    });
  });

  it('AC-0 normalizes a qualified GitHub kickoff repo before cache, activation, and profile registration', async () => {
    // Given a GitHub chat kickoff uses the existing org/repository shape.
    const deps = dependencies();
    jest.mocked(deps.groundingService.getGroundings).mockResolvedValue([]);
    const service = createCallerGroundingService(deps);

    // When caller grounding starts.
    const selected = await service.start({
      caller: 'chat-agent',
      userId: 'developer-1',
      run,
      repository: {
        provider: 'github',
        repo: 'org/AI-Pilot',
        branch: 'main',
      },
      reauthorize: async () => true,
    });

    // Then the GitHub organization remains environment-owned and only the repo name flows downstream.
    expect(selected.mode).toBe('local');
    expect(deps.ensureRepoCache).toHaveBeenCalledWith(
      {
        provider: 'github',
        project: 'Apex',
        repo: 'AI-Pilot',
        branch: 'main',
      },
      { waitMs: USER_FACING_REPO_CACHE_LEASE_WAIT_MS },
    );
    expect(deps.groundingService.activateGroundings).toHaveBeenCalledWith({
      run,
      target: {
        provider: 'github',
        repository: 'AI-Pilot',
        branch: 'main',
        groundedSha: grounding.groundedSha,
      },
    });
    expect(deps.profiles.registerConnectionProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'github',
        project: 'Apex',
        repo: 'AI-Pilot',
      }),
      expect.anything(),
      expect.any(Function)
    );
  });

  it('AC-0 preserves ADO repository names containing slashes', async () => {
    // Given an ADO repository name that contains a slash.
    const adoGrounding = {
      ...grounding,
      provider: 'azure_devops' as const,
      repository: 'Platform/AI-Pilot',
    };
    const deps = dependencies();
    jest.mocked(deps.groundingService.getGroundings).mockResolvedValue([]);
    jest.mocked(deps.groundingService.activateGroundings).mockResolvedValue({
      ok: true,
      durableGrounding: true,
      fallback: 'none',
      groundings: [adoGrounding],
    });
    const service = createCallerGroundingService(deps);

    // When caller grounding starts.
    await service.start({
      caller: 'chat-agent',
      userId: 'developer-1',
      run,
      repository: {
        provider: 'ado',
        repo: 'Platform/AI-Pilot',
        branch: 'main',
      },
      reauthorize: async () => true,
    });

    // Then ADO receives the original repository name without GitHub normalization.
    expect(deps.ensureRepoCache).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'ado',
        repo: 'Platform/AI-Pilot',
      }),
      { waitMs: USER_FACING_REPO_CACHE_LEASE_WAIT_MS },
    );
    expect(deps.groundingService.activateGroundings).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          provider: 'azure_devops',
          repository: 'Platform/AI-Pilot',
        }),
      })
    );
  });

  it.each([
    {
      label: 'cold',
      existing: [] as RunGrounding[],
      mirrorHit: true,
      expectedMode: 'cold',
    },
    {
      label: 'warm',
      existing: [grounding],
      mirrorHit: undefined,
      expectedMode: 'warm',
    },
  ])(
    'TBI-008 DoD-0 emits one $label materialization for an enabled successful caller',
    async ({ existing, mirrorHit, expectedMode }) => {
      // Arrange
      const deps = dependencies({
        now: jest.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_125),
      });
      jest
        .mocked(deps.groundingService.getGroundings)
        .mockResolvedValue(existing);
      jest.mocked(deps.ensureRepoCache).mockResolvedValue({
        baseSha: grounding.groundedSha,
        mirrorHit,
      });
      const service = createCallerGroundingService(deps);

      // Act
      await service.start({
        caller: 'interview',
        userId: 'developer-1',
        run,
        repository: {
          provider: 'github',
          repo: 'AI-Pilot',
          branch: 'main',
        },
        reauthorize: async () => true,
      });

      // Assert
      expect(deps.trackEvent).toHaveBeenCalledWith(
        'grounding.materialize',
        expect.objectContaining({
          caller: 'interview',
          project: 'Apex',
          runId: 'thread-1',
          mode: expectedMode,
          outcome: 'success',
        }),
        { durationMs: 125 }
      );
      expect(
        jest
          .mocked(deps.trackEvent)
          .mock.calls.filter(([name]) => name === 'grounding.materialize')
      ).toHaveLength(1);
      if (mirrorHit !== undefined) {
        expect(deps.trackEvent).toHaveBeenCalledWith(
          'grounding.mirror',
          expect.objectContaining({
            caller: 'interview',
            project: 'Apex',
            runId: 'thread-1',
            result: mirrorHit ? 'hit' : 'miss',
          }),
          { hit: mirrorHit ? 1 : 0 }
        );
      }
      expect(deps.profiles.registerConnectionProfile).toHaveBeenCalledWith(
        expect.objectContaining({ caller: 'interview' }),
        expect.anything(),
        expect.any(Function)
      );
    }
  );

  it('TBI-008 DoD-0 emits same-cohort mirror miss and failed materialization once', async () => {
    // Arrange
    const deps = dependencies({
      now: jest.fn().mockReturnValueOnce(2_000).mockReturnValueOnce(2_250),
      materialize: jest.fn().mockResolvedValue({ state: 'unavailable' }),
    });
    jest.mocked(deps.groundingService.getGroundings).mockResolvedValue([]);
    jest.mocked(deps.ensureRepoCache).mockResolvedValue({
      baseSha: grounding.groundedSha,
      mirrorHit: false,
    });
    const service = createCallerGroundingService(deps);

    // Act
    await service.start({
      caller: 'interview',
      userId: 'developer-1',
      run,
      repository: {
        provider: 'github',
        repo: 'AI-Pilot',
        branch: 'main',
      },
      reauthorize: async () => true,
    });

    // Assert
    expect(deps.trackEvent).toHaveBeenCalledWith(
      'grounding.mirror',
      expect.objectContaining({
        caller: 'interview',
        project: 'Apex',
        runId: 'thread-1',
        result: 'miss',
      }),
      { hit: 0 }
    );
    expect(deps.trackEvent).toHaveBeenCalledWith(
      'grounding.materialize',
      expect.objectContaining({
        caller: 'interview',
        project: 'Apex',
        runId: 'thread-1',
        mode: 'cold',
        outcome: 'failure',
      }),
      { durationMs: 250 }
    );
    expect(deps.trackEvent).toHaveBeenCalledWith(
      'grounding.failure',
      expect.objectContaining({
        caller: 'interview',
        project: 'Apex',
        runId: 'thread-1',
      }),
      { failureCount: 1 }
    );
  });

  it('AC-1 flag-off selects legacy remote behavior without a failure event', async () => {
    // Given the grounding feature is intentionally disabled for this cohort.
    const deps = dependencies({
      isGroundingEnabledForCaller: jest.fn().mockResolvedValue(false),
    });
    const service = createCallerGroundingService(deps);

    // When the caller starts.
    const selected = await service.start({
      caller: 'chat-agent',
      userId: 'developer-1',
      run,
      repository: {
        provider: 'github',
        repo: 'AI-Pilot',
        branch: 'main',
      },
      reauthorize: async () => true,
    });

    // Then it uses the normal existing remote path without failure telemetry.
    expect(selected).toMatchObject({ mode: 'remote' });
    expect(deps.trackEvent).toHaveBeenCalledWith(
      'native-read.flag.evaluated',
      expect.objectContaining({
        flag: 'native-read',
        outcome: 'disabled',
        reason: 'default-off',
      }),
      { evaluationCount: 1 }
    );
    expect(deps.groundingService.getGroundings).not.toHaveBeenCalled();
    expect(deps.profiles.registerConnectionProfile).not.toHaveBeenCalled();
    expect(deps.impactContexts.register).not.toHaveBeenCalled();
  });

  it('AC-1 materialization unavailability selects remote and emits exactly one failure event', async () => {
    // Given grounding is enabled but profile materialization is unavailable.
    const deps = dependencies({
      materialize: jest.fn().mockResolvedValue({ state: 'unavailable' }),
    });
    const service = createCallerGroundingService(deps);

    // When the caller starts.
    const selected = await service.start({
      caller: 'chat-agent',
      userId: 'developer-1',
      run,
      repository: {
        provider: 'github',
        repo: 'AI-Pilot',
        branch: 'main',
      },
      reauthorize: async () => true,
    });

    // Then controlled remote fallback emits exactly one failure event.
    expect(selected).toMatchObject({ mode: 'remote' });
    expect(deps.trackEvent).toHaveBeenCalledWith(
      'grounding.fallback',
      {
        caller: 'chat-agent',
        project: 'Apex',
        runId: 'thread-1',
        runType: 'chat',
        reason: 'materialization-unavailable',
      },
      { fallbackCount: 1 }
    );
    expect(
      jest
        .mocked(deps.trackEvent)
        .mock.calls.filter(([name]) => name === 'grounding.fallback')
    ).toHaveLength(1);
    expect(deps.profiles.registerConnectionProfile).not.toHaveBeenCalled();
  });

  it('AC-1 flag-evaluation failure selects remote and emits exactly one sanitized failure event', async () => {
    // Given the feature-flag service fails instead of returning an intentional disabled result.
    const deps = dependencies({
      isGroundingEnabledForCaller: jest
        .fn()
        .mockImplementation(async (_ctx, onEvaluationError) => {
          onEvaluationError?.();
          return false;
        }),
    });
    const service = createCallerGroundingService(deps);

    // When the caller starts.
    const selected = await service.start({
      caller: 'chat-agent',
      userId: 'developer-1',
      run,
      repository: {
        provider: 'github',
        repo: 'AI-Pilot',
        branch: 'main',
      },
      reauthorize: async () => true,
    });

    // Then remote fallback emits exactly one failure event for the evaluation failure.
    expect(selected).toMatchObject({ mode: 'remote' });
    expect(deps.trackEvent).toHaveBeenCalledWith(
      'grounding.fallback',
      {
        caller: 'chat-agent',
        project: 'Apex',
        runId: 'thread-1',
        runType: 'chat',
        reason: 'flag-evaluation-failed',
      },
      { fallbackCount: 1 }
    );
    expect(
      jest
        .mocked(deps.trackEvent)
        .mock.calls.filter(([name]) => name === 'grounding.fallback')
    ).toHaveLength(1);
    expect(deps.groundingService.getGroundings).not.toHaveBeenCalled();
  });

  it('AC-1 / VT-02 selects remote and emits exactly one fallback event when materialization throws', async () => {
    // Given grounding is enabled, fallback is permitted, and materialization fails.
    const deps = dependencies({
      materialize: jest
        .fn()
        .mockRejectedValue(new Error('checkout unavailable')),
    });
    const service = createCallerGroundingService(deps);

    // When the repository-reading caller starts.
    const selected = await service.start({
      caller: 'ask-apex',
      userId: 'developer-1',
      run,
      repository: {
        provider: 'github',
        repo: 'AI-Pilot',
        branch: 'main',
      },
      reauthorize: async () => true,
    });

    // Then the remote reader path is selected with one sanitized fallback event.
    expect(selected).toMatchObject({ mode: 'remote' });
    expect(deps.trackEvent).toHaveBeenCalledWith(
      'grounding.fallback',
      {
        caller: 'ask-apex',
        project: 'Apex',
        runId: 'thread-1',
        runType: 'chat',
        reason: 'startup-failed',
      },
      { fallbackCount: 1 }
    );
    expect(
      jest
        .mocked(deps.trackEvent)
        .mock.calls.filter(([name]) => name === 'grounding.fallback')
    ).toHaveLength(1);
    expect(deps.profiles.registerConnectionProfile).not.toHaveBeenCalled();
  });
});

describe('TBI-005 / PBI-004 guarded native-read startup', () => {
  const startInput = {
    caller: 'chat-agent',
    userId: 'developer-1',
    run,
    repository: {
      provider: 'github' as const,
      repo: 'AI-Pilot',
      branch: 'main',
    },
    reauthorize: async () => true,
  };

  it.each([
    ['local', true, 'local'],
    ['remote', false, 'remote'],
  ])(
    'AC-0 / VT-01 preserves the existing MCP-backed %s selection when native-read is disabled',
    async (_scenario, baseGroundingEnabled, expectedMode) => {
      const deps = dependencies({
        isGroundingEnabledForCaller: jest
          .fn()
          .mockResolvedValue(baseGroundingEnabled),
      });
      const service = createCallerGroundingService(deps);

      const selected = await service.start(startInput);

      expect(selected.mode).toBe(expectedMode);
      expect(deps.isNativeReadEnabledForCaller).toHaveBeenCalledTimes(1);
      expect(deps.evaluateNativeReadCapability).not.toHaveBeenCalled();
      expect(deps.trackEvent).toHaveBeenCalledWith(
        'native-read.flag.evaluated',
        expect.objectContaining({
          flag: 'native-read',
          outcome: 'disabled',
          reason: 'default-off',
        }),
        { evaluationCount: 1 }
      );
      expect(
        jest
          .mocked(deps.trackEvent)
          .mock.calls.some(([name]) => name === 'native-read.engaged')
      ).toBe(false);
    }
  );

  it.each([
    [
      'callback-reported failure',
      jest.fn().mockImplementation(async (_context, onError) => {
        onError?.();
        return false;
      }),
    ],
    [
      'thrown evaluation',
      jest
        .fn()
        .mockRejectedValue(
          new Error('secret=flag-value C:\\private\\repo --raw-argument')
        ),
    ],
  ])(
    'AC-1 / VT-02 keeps the existing MCP selection after %s',
    async (_scenario, nativeFlag) => {
      const deps = dependencies({
        isNativeReadEnabledForCaller: nativeFlag,
      });
      const service = createCallerGroundingService(deps);

      const selected = await service.start(startInput);

      expect(selected.mode).toBe('local');
      expect(nativeFlag).toHaveBeenCalledTimes(1);
      expect(deps.evaluateNativeReadCapability).not.toHaveBeenCalled();
      expect(deps.trackEvent).toHaveBeenCalledWith(
        'native-read.flag.evaluated',
        expect.objectContaining({
          outcome: 'error',
          reason: 'evaluation-failed',
        }),
        { evaluationCount: 1 }
      );
      const serialized = JSON.stringify(
        jest.mocked(deps.trackEvent).mock.calls
      );
      expect(serialized).not.toContain('flag-value');
      expect(serialized).not.toContain('private');
      expect(serialized).not.toContain('raw-argument');
    }
  );

  it.each([
    [
      'thrown self-check',
      jest.fn().mockImplementation(() => {
        throw new Error('Bearer credential C:\\private\\repo --raw-argument');
      }),
      'evaluation-failed',
    ],
    [
      'malformed self-check',
      jest.fn().mockReturnValue({
        proven: 'yes',
        reason: 'C:\\private\\repo --raw-argument',
      }),
      'malformed-result',
    ],
  ])(
    'AC-1 / VT-03 keeps the existing MCP selection after a %s',
    async (_scenario, capabilityCheck, expectedReason) => {
      const deps = dependencies({
        isNativeReadEnabledForCaller: jest.fn().mockResolvedValue(true),
        evaluateNativeReadCapability: capabilityCheck,
      });
      const service = createCallerGroundingService(deps);

      const selected = await service.start(startInput);

      expect(selected.mode).toBe('local');
      expect(deps.isNativeReadEnabledForCaller).toHaveBeenCalledTimes(1);
      expect(capabilityCheck).toHaveBeenCalledTimes(1);
      expect(deps.trackEvent).toHaveBeenCalledWith(
        'native-read.capability.self-check',
        expect.objectContaining({
          outcome: 'error',
          selfCheckReason: expectedReason,
        }),
        { selfCheckCount: 1 }
      );
      const serialized = JSON.stringify(
        jest.mocked(deps.trackEvent).mock.calls
      );
      expect(serialized).not.toContain('Bearer');
      expect(serialized).not.toContain('private');
      expect(serialized).not.toContain('raw-argument');
    }
  );

  it('AC-2 / VT-04 keeps MCP when targeted on but capability is not proven', async () => {
    const deps = dependencies({
      isNativeReadEnabledForCaller: jest.fn().mockResolvedValue(true),
      evaluateNativeReadCapability: jest.fn().mockReturnValue({
        proven: false,
        reason: 'harness-not-run',
      }),
    });
    const service = createCallerGroundingService(deps);

    const selected = await service.start(startInput);

    expect(selected.mode).toBe('local');
    expect(deps.isNativeReadEnabledForCaller).toHaveBeenCalledTimes(1);
    expect(deps.evaluateNativeReadCapability).toHaveBeenCalledTimes(1);
    expect(deps.trackEvent).toHaveBeenCalledWith(
      'native-read.flag.evaluated',
      expect.objectContaining({
        outcome: 'enabled',
        reason: 'targeted-rollout',
      }),
      { evaluationCount: 1 }
    );
    expect(deps.trackEvent).toHaveBeenCalledWith(
      'native-read.capability.self-check',
      expect.objectContaining({
        outcome: 'not-proven',
        selfCheckReason: 'harness-not-run',
      }),
      { selfCheckCount: 1 }
    );
    expect(
      jest
        .mocked(deps.trackEvent)
        .mock.calls.some(([name]) => name === 'native-read.engaged')
    ).toBe(false);
  });
});

describe('TBI-006 / PBI-005 S1 native-read activation', () => {
  const startInput = {
    caller: 'chat-agent',
    userId: 'developer-1',
    run,
    repository: {
      provider: 'github' as const,
      repo: 'AI-Pilot',
      branch: 'main',
    },
    reauthorize: async () => true,
  };

  it('VT-01 activates native reads only after usable SHA-pinned checkout and capability proof', async () => {
    // Arrange
    const deps = dependencies({
      isNativeReadEnabledForCaller: jest.fn().mockResolvedValue(true),
      evaluateNativeReadCapability: jest.fn().mockReturnValue({
        proven: true,
        reason: 'pinned-checkout-confined',
      }),
    });
    const service = createCallerGroundingService(deps);

    // Act
    const selected = await service.start(startInput);

    // Assert
    expect(selected).toMatchObject({
      mode: 'local',
      cwd: 'C:\\data\\grounding-workspaces\\opaque',
      resolvedSha: grounding.groundedSha,
      nativeReads: true,
    });
    expect(
      jest.mocked(deps.materialize).mock.invocationCallOrder[0]
    ).toBeLessThan(
      jest.mocked(deps.evaluateNativeReadCapability).mock.invocationCallOrder[0]
    );
    expect(deps.evaluateNativeReadCapability).toHaveBeenCalledWith({
      usableShaPinnedCheckout: true,
      pathConfinementGuardsActive: true,
    });
    expect(deps.trackEvent).toHaveBeenCalledWith(
      'native-read.engaged',
      {
        caller: 'chat-agent',
        project: 'Apex',
        runId: 'thread-1',
        runType: 'chat',
      },
      { engagementCount: 1 }
    );
  });

  it.each([
    {
      scenario: 'flag off',
      nativeFlag: jest.fn().mockResolvedValue(false),
      capability: jest.fn().mockReturnValue({
        proven: true,
        reason: 'pinned-checkout-confined',
      }),
      fallbackReason: 'native-read-flag-off',
      capabilityCalls: 0,
    },
    {
      scenario: 'flag evaluation error',
      nativeFlag: jest.fn().mockImplementation(async (_context, onError) => {
        onError?.();
        return false;
      }),
      capability: jest.fn().mockReturnValue({
        proven: true,
        reason: 'pinned-checkout-confined',
      }),
      fallbackReason: 'native-read-flag-evaluation-failed',
      capabilityCalls: 0,
    },
    {
      scenario: 'capability unproven',
      nativeFlag: jest.fn().mockResolvedValue(true),
      capability: jest.fn().mockReturnValue({
        proven: false,
        reason: 'path-confinement-unproven',
      }),
      fallbackReason: 'native-read-capability-unproven',
      capabilityCalls: 1,
    },
    {
      scenario: 'capability evaluation error',
      nativeFlag: jest.fn().mockResolvedValue(true),
      capability: jest.fn().mockImplementation(() => {
        throw new Error('secret=capability C:\\private\\repo --raw-argument');
      }),
      fallbackReason: 'native-read-capability-evaluation-failed',
      capabilityCalls: 1,
    },
  ])(
    'VT-02 fails closed for $scenario with sanitized deterministic telemetry',
    async ({ nativeFlag, capability, fallbackReason, capabilityCalls }) => {
      // Arrange
      const deps = dependencies({
        isNativeReadEnabledForCaller: nativeFlag,
        evaluateNativeReadCapability: capability,
      });
      const service = createCallerGroundingService(deps);

      // Act
      const selected = await service.start(startInput);

      // Assert
      expect(selected).toMatchObject({
        mode: 'local',
        nativeReads: false,
      });
      expect(capability).toHaveBeenCalledTimes(capabilityCalls);
      expect(deps.trackEvent).toHaveBeenCalledWith(
        'grounding.fallback',
        {
          caller: 'chat-agent',
          project: 'Apex',
          runId: 'thread-1',
          runType: 'chat',
          reason: fallbackReason,
        },
        { fallbackCount: 1 }
      );
      expect(
        jest
          .mocked(deps.trackEvent)
          .mock.calls.some(([name]) => name === 'native-read.engaged')
      ).toBe(false);
      const serialized = JSON.stringify(
        jest.mocked(deps.trackEvent).mock.calls
      );
      expect(serialized).not.toContain('private');
      expect(serialized).not.toContain('raw-argument');
      expect(serialized).not.toContain('secret=capability');
    }
  );

  it('VT-02 keeps remote fallback and skips capability evaluation for an unusable checkout', async () => {
    // Arrange
    const deps = dependencies({
      isNativeReadEnabledForCaller: jest.fn().mockResolvedValue(true),
      evaluateNativeReadCapability: jest.fn().mockReturnValue({
        proven: true,
        reason: 'pinned-checkout-confined',
      }),
      materialize: jest.fn().mockResolvedValue({ state: 'unavailable' }),
    });
    const service = createCallerGroundingService(deps);

    // Act
    const selected = await service.start(startInput);

    // Assert
    expect(selected).toEqual({
      mode: 'remote',
      release: expect.any(Function),
    });
    expect(deps.evaluateNativeReadCapability).not.toHaveBeenCalled();
    expect(deps.trackEvent).toHaveBeenCalledWith(
      'grounding.fallback',
      expect.objectContaining({ reason: 'materialization-unavailable' }),
      { fallbackCount: 1 }
    );
  });
});

describe('TBI-003 grounding binding continuity', () => {
  it('TBI-003 DoD-0 / VT-08 exposes the SHA acquired during the same local start operation', async () => {
    // Arrange
    const deps = dependencies();
    const service = createCallerGroundingService(deps);

    // Act
    const selected = await service.start({
      caller: 'chat-agent',
      userId: 'developer-1',
      run,
      repository: {
        provider: 'github',
        repo: 'AI-Pilot',
        branch: 'main',
      },
      reauthorize: async () => true,
    });

    // Assert
    expect(selected).toMatchObject({
      mode: 'local',
      resolvedSha: grounding.groundedSha,
    });
    expect(deps.groundingService.getGroundings).toHaveBeenCalledTimes(1);
    expect(callerGroundingSelectionToBinding(selected)).toEqual({
      mode: 'local',
      sha: grounding.groundedSha,
    });
  });

  it('TBI-003 DoD-1 / VT-09 converts a remote selection to a null-SHA binding', async () => {
    // Arrange
    const deps = dependencies({
      isGroundingEnabledForCaller: jest.fn().mockResolvedValue(false),
    });
    const service = createCallerGroundingService(deps);

    // Act
    const selected = await service.start({
      caller: 'chat-agent',
      userId: 'developer-1',
      run,
      repository: {
        provider: 'github',
        repo: 'AI-Pilot',
        branch: 'main',
      },
      reauthorize: async () => true,
    });

    // Assert
    expect(selected.mode).toBe('remote');
    expect(callerGroundingSelectionToBinding(selected)).toEqual({
      mode: 'remote',
      sha: null,
    });
  });

  it('TBI-003 DoD-0 / VT-08 never exposes a blank acquired SHA as local', async () => {
    // Arrange
    const deps = dependencies();
    jest
      .mocked(deps.groundingService.getGroundings)
      .mockResolvedValue([{ ...grounding, groundedSha: '   ' }]);
    const service = createCallerGroundingService(deps);

    // Act
    const selected = await service.start({
      caller: 'chat-agent',
      userId: 'developer-1',
      run,
      repository: {
        provider: 'github',
        repo: 'AI-Pilot',
        branch: 'main',
      },
      reauthorize: async () => true,
    });

    // Assert
    expect(selected.mode).toBe('remote');
    expect(deps.materialize).not.toHaveBeenCalled();
    expect(callerGroundingSelectionToBinding(selected)).toEqual({
      mode: 'remote',
      sha: null,
    });
  });

  const localX: GroundingBinding = { mode: 'local', sha: 'sha-x' };
  const localY: GroundingBinding = { mode: 'local', sha: 'sha-y' };
  const remote: GroundingBinding = { mode: 'remote', sha: null };

  it.each([
    {
      boundary: 'matching local SHA',
      stored: localX,
      resolved: localX,
      expected: { decision: 'resume' },
      criterion: 'AC-0 / VT-01',
    },
    {
      boundary: 'matching remote mode',
      stored: remote,
      resolved: remote,
      expected: { decision: 'resume' },
      criterion: 'AC-0 / VT-01',
    },
    {
      boundary: 'null legacy binding',
      stored: null,
      resolved: localX,
      expected: {
        decision: 'recreate',
        reason: 'legacy-binding-missing',
      },
      criterion: 'AC-1 / VT-02',
    },
    {
      boundary: 'invalid stored mode',
      stored: { mode: 'hybrid', sha: null },
      resolved: remote,
      expected: { decision: 'recreate', reason: 'binding-malformed' },
      criterion: 'AC-1 / VT-03',
    },
    {
      boundary: 'local null SHA',
      stored: { mode: 'local', sha: null },
      resolved: localX,
      expected: { decision: 'recreate', reason: 'binding-malformed' },
      criterion: 'AC-1 / VT-03',
    },
    {
      boundary: 'local blank SHA',
      stored: { mode: 'local', sha: '   ' },
      resolved: localX,
      expected: { decision: 'recreate', reason: 'binding-malformed' },
      criterion: 'AC-1 / VT-03',
    },
    {
      boundary: 'remote non-null SHA',
      stored: { mode: 'remote', sha: 'unexpected-sha' },
      resolved: remote,
      expected: { decision: 'recreate', reason: 'binding-malformed' },
      criterion: 'AC-1 / VT-03',
    },
    {
      boundary: 'changed local SHA',
      stored: localX,
      resolved: localY,
      expected: { decision: 'recreate', reason: 'sha-changed' },
      criterion: 'AC-2 / VT-04',
    },
    {
      boundary: 'local to remote mode change',
      stored: localX,
      resolved: remote,
      expected: { decision: 'recreate', reason: 'mode-changed' },
      criterion: 'AC-3 / VT-05',
    },
    {
      boundary: 'remote to local mode change',
      stored: remote,
      resolved: localX,
      expected: { decision: 'recreate', reason: 'mode-changed' },
      criterion: 'AC-3 / VT-05',
    },
  ])(
    'TBI-003 DoD-2/DoD-3 $criterion deterministically evaluates $boundary',
    ({ stored, resolved, expected }) => {
      // Act
      const first = evaluateBindingContinuity(stored, resolved);
      const second = evaluateBindingContinuity(stored, resolved);

      // Assert
      expect(first).toEqual(expected);
      expect(second).toEqual(expected);
    }
  );
});

describe('Bundle B fast shared grounding selection', () => {
  const SHARED_PATH = 'C:\\data\\workspaces\\grounding-shared\\digest';

  function sharedDeps(
    overrides: Partial<CallerGroundingDependencies> = {}
  ): CallerGroundingDependencies {
    return dependencies({
      isSharedReadCheckoutEnabledForCaller: jest.fn().mockResolvedValue(true),
      sharedReadCheckout: {
        getReady: jest.fn().mockReturnValue({
          workspacePath: SHARED_PATH,
          outcome: 'hit',
        }),
        materialize: jest.fn().mockResolvedValue({
          workspacePath: SHARED_PATH,
          outcome: 'materialized',
        }),
        retain: jest.fn(),
        releaseRef: jest.fn(),
      },
      readCachedOriginSha: jest.fn().mockResolvedValue(grounding.groundedSha),
      ...overrides,
    } as Partial<CallerGroundingDependencies>);
  }

  const startArgs = {
    caller: 'chat-agent',
    userId: 'developer-1',
    run,
    repository: {
      provider: 'github' as const,
      repo: 'AI-Pilot',
      branch: 'main',
    },
    reauthorize: async () => true,
    readOnlyShareable: true,
  };

  it('PLAN-S2-AC-0 Given exact ready local SHA, When starting, Then selects it without network or materialization', async () => {
    // Given
    const deps = sharedDeps();
    jest.mocked(deps.groundingService.getGroundings).mockResolvedValue([]);
    const service = createCallerGroundingService(deps);

    // When
    const selected = await service.start(startArgs);

    // Then
    expect(selected).toMatchObject({
      mode: 'local',
      cwd: SHARED_PATH,
      profileId,
      resolvedSha: grounding.groundedSha,
    });
    expect(deps.sharedReadCheckout.getReady).toHaveBeenCalledWith({
      provider: 'github',
      project: 'Apex',
      repo: 'AI-Pilot',
      branch: grounding.branch,
      sha: grounding.groundedSha,
    });
    expect(deps.ensureRepoCache).not.toHaveBeenCalled();
    expect(deps.readCachedOriginSha).toHaveBeenCalledWith({
      provider: 'github',
      project: 'Apex',
      repository: 'AI-Pilot',
      branch: 'main',
    });
    expect(deps.groundingService.activateGroundings).toHaveBeenCalledWith({
      run,
      target: {
        provider: 'github',
        repository: 'AI-Pilot',
        branch: 'main',
        groundedSha: grounding.groundedSha,
      },
    });
    expect(deps.sharedReadCheckout.materialize).not.toHaveBeenCalled();
    expect(deps.materialize).not.toHaveBeenCalled();
  });

  it('does not auto-advance an existing pin to a ready latest SHA', async () => {
    const latestSha = 'c'.repeat(40);
    const deps = sharedDeps({
      readCachedOriginSha: jest.fn().mockResolvedValue(latestSha),
      sharedReadCheckout: {
        getReady: jest.fn().mockImplementation((identity) =>
          identity.sha === latestSha
            ? { workspacePath: SHARED_PATH, outcome: 'hit' }
            : null
        ),
        materialize: jest.fn().mockResolvedValue({
          workspacePath: SHARED_PATH,
          outcome: 'materialized',
        }),
        retain: jest.fn(),
        releaseRef: jest.fn(),
      },
    });
    const service = createCallerGroundingService(deps);

    const selected = await service.start(startArgs);

    expect(selected.mode).toBe('preparing');
    expect(deps.groundingService.reground).not.toHaveBeenCalled();
    if (selected.mode === 'preparing') {
      await selected.waitUntilReady?.();
    }
    expect(deps.sharedReadCheckout.materialize).toHaveBeenCalledWith(
      expect.objectContaining({ sha: grounding.groundedSha }),
    );
  });

  it('PLAN-S2-AC-1 Given exact cold and prior ready SHA, When starting, Then pins and selects the prior SHA', async () => {
    // Given
    const previousSha = 'b'.repeat(40);
    const previousGrounding: RunGrounding = {
      ...grounding,
      id: 'grounding-previous',
      runId: 'another-thread',
      groundedSha: previousSha,
      groundedAt: '2026-08-02T11:00:00.000Z',
    };
    const deps = sharedDeps({
      sharedReadCheckout: {
        getReady: jest
          .fn()
          .mockImplementation((identity) =>
            identity.sha === previousSha
              ? { workspacePath: SHARED_PATH, outcome: 'hit' }
              : null
          ),
        materialize: jest.fn(),
        retain: jest.fn(),
        releaseRef: jest.fn(),
      },
    });
    jest
      .mocked(deps.groundingService.findActiveByRepoBranch)
      .mockResolvedValue([grounding, previousGrounding]);
    jest
      .mocked(deps.groundingService.reground)
      .mockResolvedValue({ ...grounding, groundedSha: previousSha });
    const service = createCallerGroundingService(deps);

    // When
    const selected = await service.start(startArgs);

    // Then
    expect(selected).toMatchObject({
      mode: 'local',
      cwd: SHARED_PATH,
      resolvedSha: previousSha,
    });
    expect(deps.groundingService.reground).toHaveBeenCalledWith(
      run,
      'target',
      previousSha
    );
    expect(deps.ensureRepoCache).not.toHaveBeenCalled();
    expect(deps.sharedReadCheckout.materialize).not.toHaveBeenCalled();
    expect(deps.materialize).not.toHaveBeenCalled();
  });

  it('PLAN-S2-AC-2 Given no ready checkout, When starting, Then starts shared materialization without pinning early', async () => {
    // Given
    const deps = sharedDeps({
      isNativeReadEnabledForCaller: jest.fn().mockResolvedValue(true),
      sharedReadCheckout: {
        getReady: jest.fn().mockReturnValue(null),
        materialize: jest.fn().mockResolvedValue({
          workspacePath: SHARED_PATH,
          outcome: 'materialized',
        }),
        retain: jest.fn(),
        releaseRef: jest.fn(),
      },
    });
    jest
      .mocked(deps.groundingService.findActiveByRepoBranch)
      .mockResolvedValue([grounding]);
    const service = createCallerGroundingService(deps);

    // When
    const selected = await service.start(startArgs);

    // Then
    expect(selected).toMatchObject({
      mode: 'preparing',
      retryAfterMs: expect.any(Number),
      waitUntilReady: expect.any(Function),
      release: expect.any(Function),
    });
    if (selected.mode === 'preparing') {
      await selected.waitUntilReady?.();
    }
    expect(selected.mode).not.toBe('remote');
    expect(deps.ensureRepoCache).not.toHaveBeenCalled();
    expect(deps.sharedReadCheckout.materialize).toHaveBeenCalledWith({
      provider: 'github',
      project: 'Apex',
      repo: 'AI-Pilot',
      branch: 'main',
      sha: grounding.groundedSha,
    });
    expect(deps.materialize).not.toHaveBeenCalled();
    expect(deps.evaluateNativeReadCapability).not.toHaveBeenCalled();
  });

  it('Given no mirror or checkout, When Home starts, Then clones the mirror and materializes its SHA on demand', async () => {
    // Given
    const deps = sharedDeps({
      readCachedOriginSha: jest.fn().mockResolvedValue(null),
      sharedReadCheckout: {
        getReady: jest.fn().mockReturnValue(null),
        materialize: jest.fn().mockResolvedValue({
          workspacePath: SHARED_PATH,
          outcome: 'materialized',
        }),
        retain: jest.fn(),
        releaseRef: jest.fn(),
      },
    });
    jest.mocked(deps.groundingService.getGroundings).mockResolvedValue([]);
    jest
      .mocked(deps.groundingService.findActiveByRepoBranch)
      .mockResolvedValue([]);
    const service = createCallerGroundingService(deps);

    // When
    const selected = await service.start(startArgs);
    expect(selected.mode).toBe('preparing');
    if (selected.mode === 'preparing') {
      await selected.waitUntilReady?.();
    }

    // Then
    expect(deps.ensureRepoCache).toHaveBeenCalledWith(
      {
        provider: 'github',
        project: 'Apex',
        repo: 'AI-Pilot',
        branch: 'main',
      },
      { waitMs: USER_FACING_REPO_CACHE_LEASE_WAIT_MS },
    );
    expect(deps.sharedReadCheckout.materialize).toHaveBeenCalledWith({
      provider: 'github',
      project: 'Apex',
      repo: 'AI-Pilot',
      branch: 'main',
      sha: grounding.groundedSha,
    });
    expect(deps.groundingService.activateGroundings).not.toHaveBeenCalled();
  });

  it('PLAN-S2-AC-3 Given shared grounding is intentionally disabled, When starting, Then preserves per-run behavior', async () => {
    // Given
    const deps = sharedDeps({
      isSharedReadCheckoutEnabledForCaller: jest.fn().mockResolvedValue(false),
    });
    const service = createCallerGroundingService(deps);

    // When
    const selected = await service.start(startArgs);

    // Then
    expect(selected).toMatchObject({
      mode: 'local',
      cwd: 'C:\\data\\grounding-workspaces\\opaque',
    });
    expect(deps.sharedReadCheckout.getReady).not.toHaveBeenCalled();
    expect(deps.materialize).toHaveBeenCalledWith(grounding, run);
  });

  it('PLAN-S2-DoD-0 Given preparing selection, When converted, Then no durable grounding binding is produced', () => {
    // Given
    const preparing = {
      mode: 'preparing',
      retryAfterMs: 1_000,
      release: async () => undefined,
    } as unknown as Parameters<typeof callerGroundingSelectionToBinding>[0];

    // When
    const binding = callerGroundingSelectionToBinding(preparing);

    // Then
    expect(binding).toBeNull();
    expect(binding).not.toEqual({
      mode: 'remote',
      sha: null,
    });
  });
});

describe('Stage 6 bare-mirror skip of working-tree materialization', () => {
  const mirrorPath = 'C:\\data\\repo-cache\\warm.git';
  const sandbox = 'C:\\data\\threads\\thread-1';

  it('skips shared and per-run checkouts when native reads and a usable mirror exist', async () => {
    const deps = dependencies({
      isNativeReadEnabledForCaller: jest.fn().mockResolvedValue(true),
      isSharedReadCheckoutEnabledForCaller: jest.fn().mockResolvedValue(true),
      isUsableBareMirror: jest.fn().mockReturnValue(true),
      getRepoCacheDir: jest.fn().mockReturnValue(mirrorPath),
      evaluateNativeReadCapability: jest.fn().mockReturnValue({
        proven: true,
        reason: 'pinned-checkout-confined',
      }),
    });
    const service = createCallerGroundingService(deps);

    const selected = await service.start({
      caller: 'chat-agent',
      userId: 'developer-1',
      run,
      repository: {
        provider: 'github',
        repo: 'AI-Pilot',
        branch: 'main',
      },
      reauthorize: async () => true,
      readOnlyShareable: true,
      sandboxCwd: sandbox,
    });

    expect(selected).toMatchObject({
      mode: 'local',
      cwd: sandbox,
      profileId,
      resolvedSha: grounding.groundedSha,
      nativeReads: true,
      workingTree: false,
    });
    expect(deps.materialize).not.toHaveBeenCalled();
    expect(deps.sharedReadCheckout.getReady).not.toHaveBeenCalled();
    expect(deps.ensureRepoCache).not.toHaveBeenCalled();
    expect(deps.profiles.registerConnectionProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: grounding.groundedSha,
        checkoutPath: sandbox,
        mirrorPath,
      }),
      expect.anything(),
      expect.anything()
    );
  });

  it('uses the mirror path as cwd when no sandbox is provided', async () => {
    const deps = dependencies({
      isNativeReadEnabledForCaller: jest.fn().mockResolvedValue(true),
      isUsableBareMirror: jest.fn().mockReturnValue(true),
      getRepoCacheDir: jest.fn().mockReturnValue(mirrorPath),
      evaluateNativeReadCapability: jest.fn().mockReturnValue({
        proven: true,
        reason: 'pinned-checkout-confined',
      }),
    });
    const service = createCallerGroundingService(deps);

    const selected = await service.start({
      caller: 'chat-agent',
      userId: 'developer-1',
      run,
      repository: {
        provider: 'github',
        repo: 'AI-Pilot',
        branch: 'main',
      },
      reauthorize: async () => true,
    });

    expect(selected).toMatchObject({
      mode: 'local',
      cwd: mirrorPath,
      workingTree: false,
    });
    expect(deps.materialize).not.toHaveBeenCalled();
  });
});
