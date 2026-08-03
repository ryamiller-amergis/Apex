import type { RunGrounding, RunRef } from '../../shared/types/runGrounding';
import type { GroundingProfileId } from '../../shared/types/repoReader';
import {
  createCallerGroundingService,
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
    expect(deps.trackEvent).not.toHaveBeenCalled();
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
