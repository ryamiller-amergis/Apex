import type { RunGrounding, RunRef } from '../../shared/types/runGrounding';
import type { GroundingProfileId } from '../../shared/types/repoReader';
import type { GroundingBinding } from '../../shared/types/chat';
import {
  callerGroundingSelectionToBinding,
  createCallerGroundingService,
  evaluateBindingContinuity,
  type CallerGroundingDependencies,
} from '../services/callerGroundingService';

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
    evaluateNativeReadCapability: jest.fn().mockReturnValue({
      proven: false,
      reason: 'harness-not-run',
    }),
    ensureRepoCache: jest.fn().mockResolvedValue({
      baseSha: grounding.groundedSha,
    }),
    groundingService: {
      activateGroundings: jest.fn().mockResolvedValue({
        ok: true,
        durableGrounding: true,
        fallback: 'none',
        groundings: [grounding],
      }),
      getGroundings: jest.fn().mockResolvedValue([grounding]),
      markTerminalInactive: jest.fn().mockResolvedValue(1),
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
    expect(deps.ensureRepoCache).toHaveBeenCalledWith({
      provider: 'github',
      project: 'Apex',
      repo: 'AI-Pilot',
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
    expect(deps.ensureRepoCache).toHaveBeenCalledWith({
      provider: 'github',
      project: 'Apex',
      repo: 'AI-Pilot',
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
      })
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
      jest
        .fn()
        .mockImplementation(async (_context, onError) => {
          onError?.();
          return false;
        }),
    ],
    [
      'thrown evaluation',
      jest
        .fn()
        .mockRejectedValue(
          new Error(
            'secret=flag-value C:\\private\\repo --raw-argument'
          )
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
      jest
        .fn()
        .mockImplementation(() => {
          throw new Error(
            'Bearer credential C:\\private\\repo --raw-argument'
          );
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
    expect(jest.mocked(deps.materialize).mock.invocationCallOrder[0]).toBeLessThan(
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
      nativeFlag: jest
        .fn()
        .mockImplementation(async (_context, onError) => {
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
        throw new Error(
          'secret=capability C:\\private\\repo --raw-argument'
        );
      }),
      fallbackReason: 'native-read-capability-evaluation-failed',
      capabilityCalls: 1,
    },
  ])(
    'VT-02 fails closed for $scenario with sanitized deterministic telemetry',
    async ({
      nativeFlag,
      capability,
      fallbackReason,
      capabilityCalls,
    }) => {
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
