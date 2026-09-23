import {
  createInteractiveWorkflowRouter,
  createLegacyInteractiveWorkflowRouter,
  type InteractiveWorkflowRouteInput,
  type InteractiveWorkflowRouterDependencies,
  type LegacyInteractiveWorkflowRouteInput,
  type LegacyInteractiveWorkflowRouterDependencies,
} from '../services/interactiveWorkflowRouter';

jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn(),
}));
jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn() }));

function makeInput(
  overrides: Partial<InteractiveWorkflowRouteInput> = {},
): InteractiveWorkflowRouteInput {
  return {
    userId: 'user-1',
    project: 'Apex',
    workflowClass: 'interview',
    threadId: 'thread-1',
    runLegacy: jest.fn().mockResolvedValue(undefined),
    admitDurable: jest.fn().mockResolvedValue({
      turnId: '20000000-0000-4000-8000-000000000001',
      runId: '50000000-0000-4000-8000-000000000001',
      status: 'queued',
      interactiveClass: 'fast',
    }),
    ...overrides,
  };
}

function makeDependencies(
  overrides: Partial<InteractiveWorkflowRouterDependencies> = {},
): InteractiveWorkflowRouterDependencies {
  return {
    isFeatureEnabled: jest.fn().mockResolvedValue(true),
    trackEvent: jest.fn(),
    ...overrides,
  };
}

describe('canonical interactive workflow routing', () => {
  it('uses current execution when the canonical flag is false', async () => {
    const evaluate = jest.fn().mockResolvedValue(false);
    const dependencies = makeDependencies({ isFeatureEnabled: evaluate });
    const input = makeInput();
    const router = createInteractiveWorkflowRouter(dependencies);

    await expect(router.route(input)).resolves.toEqual({
      route: 'legacy',
      reason: 'flag-disabled',
    });
    expect(input.runLegacy).toHaveBeenCalledTimes(1);
    expect(input.admitDurable).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledWith('ai-runs-v2-transport', {
      userId: 'user-1',
      project: 'Apex',
      caller: 'interview',
    });
  });

  it('uses current execution when canonical evaluation throws', async () => {
    const evaluate = jest
      .fn()
      .mockRejectedValue(new Error('flag store unavailable'));
    const dependencies = makeDependencies({ isFeatureEnabled: evaluate });
    const input = makeInput();
    const router = createInteractiveWorkflowRouter(dependencies);

    await expect(router.route(input)).resolves.toEqual({
      route: 'legacy',
      reason: 'flag-evaluation-error',
    });
    expect(input.runLegacy).toHaveBeenCalledTimes(1);
    expect(input.admitDurable).not.toHaveBeenCalled();
  });

  it('returns the durable accepted response when the canonical flag is true', async () => {
    const dependencies = makeDependencies();
    const input = makeInput();

    await expect(
      createInteractiveWorkflowRouter(dependencies).route(input),
    ).resolves.toEqual({
      route: 'durable',
      response: {
        turnId: '20000000-0000-4000-8000-000000000001',
        runId: '50000000-0000-4000-8000-000000000001',
        status: 'queued',
        interactiveClass: 'fast',
      },
    });
    expect(input.admitDurable).toHaveBeenCalledTimes(1);
    expect(input.runLegacy).not.toHaveBeenCalled();
  });

  it('never invokes current execution after the canonical flag is true', async () => {
    const evaluate = jest.fn().mockResolvedValue(true);
    const dependencies = makeDependencies({ isFeatureEnabled: evaluate });
    const input = makeInput({
      admitDurable: jest.fn().mockRejectedValue(new Error('blob unavailable')),
    });
    const router = createInteractiveWorkflowRouter(dependencies);

    await expect(router.route(input)).rejects.toThrow('blob unavailable');
    expect(input.runLegacy).not.toHaveBeenCalled();
  });

  it('does not let telemetry failure alter the enabled branch', async () => {
    const dependencies = makeDependencies({
      trackEvent: jest.fn(() => {
        throw new Error('telemetry unavailable');
      }),
    });
    const input = makeInput();

    await expect(
      createInteractiveWorkflowRouter(dependencies).route(input),
    ).resolves.toMatchObject({ route: 'durable' });
  });

});

function makeLegacyInput(
  overrides: Partial<LegacyInteractiveWorkflowRouteInput> = {},
): LegacyInteractiveWorkflowRouteInput {
  return {
    userId: 'user-1',
    project: 'Apex',
    workflowClass: 'interview',
    threadId: 'thread-1',
    runId: 'run-1',
    dispatchToActor: jest.fn().mockResolvedValue(undefined),
    runInProcess: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeLegacyDependencies(
  overrides: Partial<LegacyInteractiveWorkflowRouterDependencies> = {},
): LegacyInteractiveWorkflowRouterDependencies {
  return {
    isFeatureEnabled: jest.fn().mockResolvedValue(true),
    admissionService: {
      admit: jest.fn().mockResolvedValue({
        admitted: true,
        shed: false,
        slot: 'reserved',
        dispatchMessageId: 'dispatch-1',
        interactiveInFlight: 1,
        reserved: 4,
        burstMax: 12,
      }),
    },
    trackEvent: jest.fn(),
    ...overrides,
  };
}

describe('legacy interactive actor routing', () => {
  it('dispatches an admitted legacy turn to its actor', async () => {
    const dependencies = makeLegacyDependencies();
    const input = makeLegacyInput();

    await expect(
      createLegacyInteractiveWorkflowRouter(dependencies).route(input),
    ).resolves.toEqual({
      route: 'actor',
      runId: 'run-1',
      dispatchMessageId: 'dispatch-1',
      slot: 'reserved',
    });
    expect(input.dispatchToActor).toHaveBeenCalledTimes(1);
    expect(input.runInProcess).not.toHaveBeenCalled();
    expect(dependencies.isFeatureEnabled).toHaveBeenCalledWith(
      'ai-runs-interactive',
      {
        userId: 'user-1',
        project: 'Apex',
        caller: 'interview',
      },
    );
  });

  it.each([
    ['disabled', jest.fn().mockResolvedValue(false), 'flag-disabled'],
    [
      'evaluation error',
      jest.fn().mockRejectedValue(new Error('flag unavailable')),
      'flag-evaluation-error',
    ],
  ] as const)('runs in process when the legacy flag has %s', async (
    _case,
    evaluate,
    reason,
  ) => {
    const dependencies = makeLegacyDependencies({
      isFeatureEnabled: evaluate,
    });
    const input = makeLegacyInput();

    await expect(
      createLegacyInteractiveWorkflowRouter(dependencies).route(input),
    ).resolves.toEqual({ route: 'in-process', reason });
    expect(input.runInProcess).toHaveBeenCalledTimes(1);
    expect(input.dispatchToActor).not.toHaveBeenCalled();
    expect(dependencies.admissionService!.admit).not.toHaveBeenCalled();
  });

  it.each([
    ['over-capacity', 'shed'],
    ['race-lost', 'race-lost'],
  ] as const)('runs in process after legacy admission %s', async (
    admissionReason,
    routeReason,
  ) => {
    const dependencies = makeLegacyDependencies({
      admissionService: {
        admit: jest.fn().mockResolvedValue({
          admitted: false,
          shed: true,
          reason: admissionReason,
          interactiveInFlight: 16,
          reserved: 4,
          burstMax: 12,
        }),
      },
    });
    const input = makeLegacyInput();

    await expect(
      createLegacyInteractiveWorkflowRouter(dependencies).route(input),
    ).resolves.toEqual({ route: 'in-process', reason: routeReason });
    expect(input.runInProcess).toHaveBeenCalledTimes(1);
    expect(input.dispatchToActor).not.toHaveBeenCalled();
  });

  it('targets every legacy interactive workflow independently by project', async () => {
    const workflows = [
      'interview',
      'adr',
      'home-chat',
      'ask-apex',
      'assistant',
    ] as const;
    const seen: Array<{ project: string; caller?: string }> = [];
    const dependencies = makeLegacyDependencies({
      isFeatureEnabled: jest.fn().mockImplementation(
        async (_key: string, context: { project: string; caller?: string }) => {
          seen.push(context);
          return context.caller !== 'ask-apex';
        },
      ),
    });
    const router = createLegacyInteractiveWorkflowRouter(dependencies);

    const decisions = await Promise.all(
      workflows.map((workflowClass, index) =>
        router.route(
          makeLegacyInput({
            workflowClass,
            project: `P-${index}`,
            runId: `run-${index}`,
          }),
        ),
      ),
    );

    expect(seen.map((context) => context.caller)).toEqual(workflows);
    expect(decisions.map((decision) => decision.route)).toEqual([
      'actor',
      'actor',
      'actor',
      'in-process',
      'actor',
    ]);
  });

  it('lets an already-dispatched legacy turn drain after the flag changes', async () => {
    let enabled = true;
    const dependencies = makeLegacyDependencies({
      isFeatureEnabled: jest.fn().mockImplementation(async () => enabled),
    });
    const router = createLegacyInteractiveWorkflowRouter(dependencies);

    const active = await router.route(
      makeLegacyInput({ runId: 'run-active' }),
    );
    enabled = false;
    const fresh = await router.route(
      makeLegacyInput({ runId: 'run-fresh' }),
    );

    expect(active.route).toBe('actor');
    expect(fresh).toEqual({
      route: 'in-process',
      reason: 'flag-disabled',
    });
    expect(dependencies.admissionService!.admit).toHaveBeenCalledTimes(1);
  });
});
