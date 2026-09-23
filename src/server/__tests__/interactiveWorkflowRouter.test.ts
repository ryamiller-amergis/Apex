import {
  createInteractiveWorkflowRouter,
  type InteractiveWorkflowRouteInput,
  type InteractiveWorkflowRouterDependencies,
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
