import {
  createInteractiveWorkflowRouter,
  type InteractiveWorkflowRouteInput,
  type InteractiveWorkflowRouterDependencies,
} from '../services/interactiveWorkflowRouter';
import type { InteractiveWorkflowClass } from '../../shared/types/interactiveWorkflow';

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
    runId: 'run-1',
    dispatchToActor: jest.fn().mockResolvedValue(undefined),
    runInProcess: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeDependencies(
  overrides: Partial<InteractiveWorkflowRouterDependencies> = {},
): InteractiveWorkflowRouterDependencies {
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

describe('interactive workflow routing (TBI-012)', () => {
  it('PBI-007 AC-b / BR-013: enabled + admitted dispatches in-cluster to the actor (no Service Bus)', async () => {
    const dependencies = makeDependencies();
    const input = makeInput();

    const decision = await createInteractiveWorkflowRouter(dependencies).route(input);

    expect(decision).toEqual({
      route: 'actor',
      runId: 'run-1',
      dispatchMessageId: 'dispatch-1',
      slot: 'reserved',
    });
    expect(input.dispatchToActor).toHaveBeenCalledWith({
      runId: 'run-1',
      dispatchMessageId: 'dispatch-1',
    });
    expect(input.runInProcess).not.toHaveBeenCalled();
    expect(dependencies.isFeatureEnabled).toHaveBeenCalledWith('ai-runs-interactive', {
      userId: 'user-1',
      project: 'Apex',
      caller: 'interview',
    });
  });

  it('DoD-0: targets each interactive workflow class independently per project', async () => {
    const workflows: InteractiveWorkflowClass[] = [
      'interview',
      'adr',
      'home-chat',
      'ask-apex',
      'assistant',
    ];
    const seen: Array<{ project: string; caller?: string }> = [];
    const dependencies = makeDependencies({
      isFeatureEnabled: jest.fn().mockImplementation(
        async (_key: string, ctx: { project: string; caller?: string }) => {
          seen.push(ctx);
          return ctx.caller !== 'ask-apex';
        },
      ),
    });
    const router = createInteractiveWorkflowRouter(dependencies);

    const decisions = await Promise.all(
      workflows.map((workflowClass, i) =>
        router.route(makeInput({ workflowClass, project: `P-${i}`, runId: `run-${i}` })),
      ),
    );

    expect(seen.map((c) => c.caller)).toEqual(workflows);
    expect(decisions.map((d) => d.route)).toEqual([
      'actor',
      'actor',
      'actor',
      'in-process',
      'actor',
    ]);
  });

  it('PBI-007 AC-g / BR-017: disabled flag fails closed to in-process with no actor dispatch', async () => {
    const dependencies = makeDependencies({
      isFeatureEnabled: jest.fn().mockResolvedValue(false),
    });
    const input = makeInput();

    const decision = await createInteractiveWorkflowRouter(dependencies).route(input);

    expect(decision).toEqual({ route: 'in-process', reason: 'flag-disabled' });
    expect(input.runInProcess).toHaveBeenCalledTimes(1);
    expect(input.dispatchToActor).not.toHaveBeenCalled();
    expect(dependencies.admissionService!.admit).not.toHaveBeenCalled();
  });

  it('PBI-007 AC-g / BR-017: flag evaluation error fails closed to in-process', async () => {
    const dependencies = makeDependencies({
      isFeatureEnabled: jest.fn().mockRejectedValue(new Error('flag store down')),
    });
    const input = makeInput();

    const decision = await createInteractiveWorkflowRouter(dependencies).route(input);

    expect(decision).toEqual({ route: 'in-process', reason: 'flag-evaluation-error' });
    expect(input.runInProcess).toHaveBeenCalledTimes(1);
    expect(input.dispatchToActor).not.toHaveBeenCalled();
    expect(dependencies.admissionService!.admit).not.toHaveBeenCalled();
  });

  it('PBI-007 AC-e / BR-014: over-capacity shed routes in-process (never queues)', async () => {
    const dependencies = makeDependencies({
      admissionService: {
        admit: jest.fn().mockResolvedValue({
          admitted: false,
          shed: true,
          reason: 'over-capacity',
          interactiveInFlight: 16,
          reserved: 4,
          burstMax: 12,
        }),
      },
    });
    const input = makeInput();

    const decision = await createInteractiveWorkflowRouter(dependencies).route(input);

    expect(decision).toEqual({ route: 'in-process', reason: 'shed' });
    expect(input.runInProcess).toHaveBeenCalledTimes(1);
    expect(input.dispatchToActor).not.toHaveBeenCalled();
  });

  it('a lost admission race also sheds to in-process', async () => {
    const dependencies = makeDependencies({
      admissionService: {
        admit: jest.fn().mockResolvedValue({
          admitted: false,
          shed: true,
          reason: 'race-lost',
          interactiveInFlight: 0,
          reserved: 4,
          burstMax: 12,
        }),
      },
    });
    const input = makeInput();

    const decision = await createInteractiveWorkflowRouter(dependencies).route(input);

    expect(decision).toEqual({ route: 'in-process', reason: 'race-lost' });
    expect(input.dispatchToActor).not.toHaveBeenCalled();
  });

  it('BR-017: disabling the flag affects only new turns; an already-dispatched turn is untouched', async () => {
    let enabled = true;
    const dependencies = makeDependencies({
      isFeatureEnabled: jest.fn().mockImplementation(async () => enabled),
    });
    const router = createInteractiveWorkflowRouter(dependencies);

    const active = await router.route(makeInput({ runId: 'run-active' }));
    enabled = false;
    const fresh = await router.route(makeInput({ runId: 'run-fresh' }));

    expect(active.route).toBe('actor');
    expect(fresh).toEqual({ route: 'in-process', reason: 'flag-disabled' });
    // No forced cancellation of the active actor turn — it drains independently.
    expect(dependencies.admissionService!.admit).toHaveBeenCalledTimes(1);
  });
});
