import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExecutionSnapshot } from '../../shared/types/agentRunLifecycle';
import type {
  BackgroundWorkflowClass,
  WorkflowRouteDecision,
} from '../../shared/types/backgroundWorkflow';
import type { RunGrounding, RunRef } from '../../shared/types/runGrounding';

jest.mock('../services/agentRunReaperService', () => ({
  resolveAgentRunHardLimitMs: jest.fn().mockReturnValue(60_000),
}));
jest.mock('../services/agentRunLifecycleService', () => ({
  enqueue: jest.fn(),
  markTerminal: jest.fn(),
  requestCancel: jest.fn(),
}));
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn(),
}));
jest.mock('../services/runGroundingMaterializer', () => ({
  materializeRunGroundingWithPath: jest.fn(),
}));
jest.mock('../services/telemetry', () => ({
  trackEvent: jest.fn(),
}));

import {
  createBackgroundWorkflowRouter,
  prepareBackgroundWorkflowWorkspace,
  type BackgroundWorkflowRouteInput,
  type BackgroundWorkflowRouterDependencies,
} from '../services/backgroundWorkflowRouter';
import {
  markTerminal,
  requestCancel,
} from '../services/agentRunLifecycleService';

const destinationRun: RunRef = {
  runType: 'service',
  runId: 'run-1',
  project: 'Apex',
};

const targetGrounding: RunGrounding = {
  ...destinationRun,
  id: 'grounding-1',
  repoRole: 'target',
  provider: 'github',
  repository: 'apex/ai-pilot',
  branch: 'main',
  groundedSha: 'abc123',
  groundedAt: '2026-08-06T12:00:00.000Z',
  isActive: true,
  createdAt: '2026-08-06T12:00:00.000Z',
  updatedAt: '2026-08-06T12:00:00.000Z',
};

function makeInput(
  overrides: Partial<BackgroundWorkflowRouteInput> = {},
): BackgroundWorkflowRouteInput {
  return {
    userId: 'user-1',
    workflowClass: 'prd',
    destinationRun,
    threadId: 'thread-1',
    prepareWorker: jest.fn().mockResolvedValue({
      targetGrounding,
      threadWorkspacePath: 'C:\\threads\\thread-1',
      prompt: 'confidential generation prompt',
      model: 'claude-4',
      skillPath: '.cursor/skills/to-prd/SKILL.md',
      projectId: 'project-1',
    }),
    runInProcess: jest.fn().mockResolvedValue(undefined),
    reportRecoverablePreparationFailure: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeDependencies(
  overrides: Partial<BackgroundWorkflowRouterDependencies> = {},
): BackgroundWorkflowRouterDependencies {
  return {
    isFeatureEnabled: jest.fn().mockResolvedValue(true),
    materializeRunGroundingWithPath: jest.fn().mockResolvedValue({
      state: 'materialized',
      workspacePath: 'C:\\grounding-workspaces\\opaque',
    }),
    prepareWorkspace: jest.fn().mockResolvedValue(undefined),
    enqueue: jest.fn().mockResolvedValue({ runId: 'run-1' }),
    resolveHardLimitMs: jest.fn().mockReturnValue(60_000),
    now: jest.fn().mockReturnValue(1_000),
    trackEvent: jest.fn(),
    ...overrides,
  };
}

describe('background workflow routing', () => {
  it('AC-0 / VT-01 / BR-007: Given enabled routing, materializes and prepares before lifecycle enqueue', async () => {
    const order: string[] = [];
    const dependencies = makeDependencies({
      materializeRunGroundingWithPath: jest.fn().mockImplementation(async () => {
        order.push('materialize');
        return {
          state: 'materialized',
          workspacePath: 'C:\\grounding-workspaces\\opaque',
        };
      }),
      prepareWorkspace: jest.fn().mockImplementation(async () => {
        order.push('prepare');
      }),
      enqueue: jest.fn().mockImplementation(async () => {
        order.push('enqueue');
        return { runId: 'run-1' };
      }),
    });
    const input = makeInput({
      prepareWorker: jest.fn().mockImplementation(async () => {
        order.push('prepare-worker');
        return {
          targetGrounding,
          threadWorkspacePath: 'C:\\threads\\thread-1',
          prompt: 'confidential generation prompt',
          model: 'claude-4',
          skillPath: '.cursor/skills/to-prd/SKILL.md',
          projectId: 'project-1',
        };
      }),
    });

    const decision = await createBackgroundWorkflowRouter(dependencies).route(input);

    expect(decision).toEqual<WorkflowRouteDecision>({
      route: 'worker',
      workspacePath: 'C:\\grounding-workspaces\\opaque',
      runId: 'run-1',
    });
    expect(order).toEqual(['prepare-worker', 'materialize', 'prepare', 'enqueue']);
    expect(dependencies.isFeatureEnabled).toHaveBeenCalledWith(
      'ai-runs-background',
      {
        userId: 'user-1',
        project: 'Apex',
        caller: 'prd',
      },
    );
    expect(dependencies.materializeRunGroundingWithPath).toHaveBeenCalledWith(
      targetGrounding,
      destinationRun,
    );
    expect(dependencies.prepareWorkspace).toHaveBeenCalledWith(
      'C:\\threads\\thread-1',
      'C:\\grounding-workspaces\\opaque',
    );
  });

  it('TBI-007 DoD-0 / DoD-1 / VT-07: targets every workflow vocabulary independently by project and caller', async () => {
    const workflows: BackgroundWorkflowClass[] = [
      'prd',
      'design-doc',
      'validation',
      'test-cases',
    ];
    const evaluations: Array<{ project: string; caller?: string }> = [];
    const dependencies = makeDependencies({
      isFeatureEnabled: jest.fn().mockImplementation(
        async (_key: string, context: { project: string; caller?: string }) => {
          evaluations.push(context);
          return context.caller !== 'validation';
        },
      ),
    });
    const router = createBackgroundWorkflowRouter(dependencies);

    const decisions = await Promise.all(
      workflows.map((workflowClass, index) => {
        const project = `Project-${index}`;
        return router.route(makeInput({
          workflowClass,
          destinationRun: {
            ...destinationRun,
            runId: `run-${index}`,
            project,
          },
          prepareWorker: jest.fn().mockResolvedValue({
            targetGrounding: {
              ...targetGrounding,
              runId: `run-${index}`,
              project,
            },
            threadWorkspacePath: 'C:\\threads\\thread-1',
            prompt: 'confidential generation prompt',
            model: 'claude-4',
            skillPath: '.cursor/skills/to-prd/SKILL.md',
            projectId: project,
          }),
        }));
      }),
    );

    expect(evaluations).toEqual(
      workflows.map((caller, index) => ({
        userId: 'user-1',
        project: `Project-${index}`,
        caller,
      })),
    );
    expect(decisions.map((decision) => decision.route)).toEqual([
      'worker',
      'worker',
      'in-process',
      'worker',
    ]);
  });

  it('TBI-007 DoD-2 / DoD-4 / PBI-006 AC-1 / VT-04: Given the flag is disabled, runs only the unchanged in-process callback', async () => {
    const dependencies = makeDependencies({
      isFeatureEnabled: jest.fn().mockResolvedValue(false),
    });
    const input = makeInput();

    const decision = await createBackgroundWorkflowRouter(dependencies).route(input);

    expect(decision).toEqual<WorkflowRouteDecision>({
      route: 'in-process',
      reason: 'flag-disabled',
    });
    expect(input.runInProcess).toHaveBeenCalledTimes(1);
    expect(input.prepareWorker).not.toHaveBeenCalled();
    expect(dependencies.materializeRunGroundingWithPath).not.toHaveBeenCalled();
    expect(dependencies.prepareWorkspace).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('TBI-007 DoD-4 / PBI-006 AC-1 / VT-03: Given flag evaluation throws, fails closed to in-process without dispatch', async () => {
    const dependencies = makeDependencies({
      isFeatureEnabled: jest.fn().mockRejectedValue(new Error('flag store unavailable')),
    });
    const input = makeInput();

    const decision = await createBackgroundWorkflowRouter(dependencies).route(input);

    expect(decision).toEqual<WorkflowRouteDecision>({
      route: 'in-process',
      reason: 'flag-disabled',
    });
    expect(input.runInProcess).toHaveBeenCalledTimes(1);
    expect(input.prepareWorker).not.toHaveBeenCalled();
    expect(dependencies.materializeRunGroundingWithPath).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('TBI-007 DoD-2 / DoD-4 / PBI-006 AC-2 / BR-011 / VT-05: disable affects only a new route while an already-dispatched run drains independently', async () => {
    let enabled = true;
    const dependencies = makeDependencies({
      isFeatureEnabled: jest.fn().mockImplementation(async () => enabled),
    });
    const router = createBackgroundWorkflowRouter(dependencies);
    const activeInput = makeInput();

    const activeDecision = await router.route(activeInput);

    enabled = false;
    const newInput = makeInput({
      destinationRun: {
        ...destinationRun,
        runId: 'run-2',
      },
    });
    const newDecision = await router.route(newInput);

    expect(activeDecision.route).toBe('worker');
    expect(newDecision).toEqual<WorkflowRouteDecision>({
      route: 'in-process',
      reason: 'flag-disabled',
    });
    expect(newInput.runInProcess).toHaveBeenCalledTimes(1);
    expect(newInput.prepareWorker).not.toHaveBeenCalled();
    expect(dependencies.enqueue).toHaveBeenCalledTimes(1);
    expect(requestCancel).not.toHaveBeenCalled();
    expect(markTerminal).not.toHaveBeenCalled();

    jest.mocked(markTerminal).mockResolvedValueOnce({
      ok: true,
      run: {} as never,
    });
    await markTerminal('run-1', {
      status: 'completed',
      dispatchMessageId: 'dispatch-1',
    });

    expect(markTerminal).toHaveBeenCalledWith('run-1', {
      status: 'completed',
      dispatchMessageId: 'dispatch-1',
    });
    expect(requestCancel).not.toHaveBeenCalled();
  });

  it.each([
    ['missing grounding', null],
    ['inactive grounding', { ...targetGrounding, isActive: false }],
    ['wrong grounding role', { ...targetGrounding, repoRole: 'skill' as const }],
  ])('AC-1 / VT-02 / DoD-2: %s is recoverable and never enqueues', async (_case, grounding) => {
    const dependencies = makeDependencies();
    const input = makeInput({
      prepareWorker: jest.fn().mockResolvedValue({
        targetGrounding: grounding,
        threadWorkspacePath: 'C:\\threads\\thread-1',
        prompt: 'confidential generation prompt',
        model: 'claude-4',
        skillPath: '.cursor/skills/to-prd/SKILL.md',
        projectId: 'project-1',
      }),
    });

    const decision = await createBackgroundWorkflowRouter(dependencies).route(input);

    expect(decision).toEqual<WorkflowRouteDecision>({
      route: 'in-process',
      reason: 'materialization-unavailable',
      recoverable: true,
    });
    expect(input.reportRecoverablePreparationFailure).toHaveBeenCalledWith({
      reason: 'materialization-unavailable',
      workflowClass: 'prd',
      project: 'Apex',
      runId: 'run-1',
    });
    expect(input.runInProcess).not.toHaveBeenCalled();
    expect(dependencies.materializeRunGroundingWithPath).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('AC-1 / DoD-2: worker preparation throw is recoverable without enqueue or in-process execution', async () => {
    const dependencies = makeDependencies();
    const input = makeInput({
      prepareWorker: jest.fn().mockRejectedValue(
        new Error('worker preparation unavailable'),
      ),
    });

    const decision = await createBackgroundWorkflowRouter(dependencies).route(input);

    expect(decision).toEqual<WorkflowRouteDecision>({
      route: 'in-process',
      reason: 'materialization-unavailable',
      recoverable: true,
    });
    expect(input.reportRecoverablePreparationFailure).toHaveBeenCalledTimes(1);
    expect(input.runInProcess).not.toHaveBeenCalled();
    expect(dependencies.materializeRunGroundingWithPath).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['returns unavailable', jest.fn().mockResolvedValue({ state: 'unavailable' })],
    ['throws', jest.fn().mockRejectedValue(new Error('checkout unavailable'))],
  ])('AC-1 / VT-02 / DoD-2: materialization %s reports recoverable failure without enqueue', async (_case, materialize) => {
    const dependencies = makeDependencies({
      materializeRunGroundingWithPath: materialize,
    });
    const input = makeInput();

    const decision = await createBackgroundWorkflowRouter(dependencies).route(input);

    expect(decision).toEqual<WorkflowRouteDecision>({
      route: 'in-process',
      reason: 'materialization-unavailable',
      recoverable: true,
    });
    expect(input.reportRecoverablePreparationFailure).toHaveBeenCalledTimes(1);
    expect(input.runInProcess).not.toHaveBeenCalled();
    expect(dependencies.prepareWorkspace).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('AC-1 / VT-02 / BR-007: copy failure is recoverable and prevents enqueue against partial content', async () => {
    const dependencies = makeDependencies({
      prepareWorkspace: jest.fn().mockRejectedValue(new Error('copy failed')),
    });
    const input = makeInput();

    const decision = await createBackgroundWorkflowRouter(dependencies).route(input);

    expect(decision).toEqual<WorkflowRouteDecision>({
      route: 'in-process',
      reason: 'materialization-unavailable',
      recoverable: true,
    });
    expect(input.reportRecoverablePreparationFailure).toHaveBeenCalledTimes(1);
    expect(input.runInProcess).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('VT-01 / VT-08: freezes the complete confidential snapshot only inside lifecycle enqueue', async () => {
    const trackEvent = jest.fn();
    const dependencies = makeDependencies({ trackEvent });
    const input = makeInput();

    await createBackgroundWorkflowRouter(dependencies).route(input);

    const expectedSnapshot: ExecutionSnapshot = {
      prompt: 'confidential generation prompt',
      model: 'claude-4',
      workspaceRef: 'C:\\grounding-workspaces\\opaque',
      workflowClass: 'prd',
      skillPath: '.cursor/skills/to-prd/SKILL.md',
      projectId: 'project-1',
      threadId: 'thread-1',
    };
    expect(dependencies.enqueue).toHaveBeenCalledWith({
      threadId: 'thread-1',
      projectId: 'project-1',
      snapshot: expectedSnapshot,
      timeoutAt: '1970-01-01T00:01:01.000Z',
      runId: 'run-1',
    });
    expect(Object.keys((dependencies.enqueue as jest.Mock).mock.calls[0][0]).sort())
      .toEqual(['projectId', 'runId', 'snapshot', 'threadId', 'timeoutAt']);
    expect(JSON.stringify(trackEvent.mock.calls)).not.toContain(
      'confidential generation prompt',
    );
    expect(JSON.stringify(trackEvent.mock.calls)).not.toContain(expectedSnapshot.workspaceRef);
  });
});

describe('background workspace preparation', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'background-router-'));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('BR-007 / VT-01: safely merges complete .ai-pilot inputs and outputs idempotently', async () => {
    const source = path.join(tempRoot, 'thread');
    const destination = path.join(tempRoot, 'pinned');
    await fs.mkdir(path.join(source, '.ai-pilot', 'output'), { recursive: true });
    await fs.mkdir(path.join(destination, '.ai-pilot', 'output'), { recursive: true });
    await fs.writeFile(
      path.join(source, '.ai-pilot', 'kickoff-context.md'),
      'kickoff',
    );
    await fs.writeFile(
      path.join(source, '.ai-pilot', 'output', 'generated.json'),
      '{"version":2}',
    );
    await fs.writeFile(
      path.join(destination, '.ai-pilot', 'output', 'preserved.md'),
      'preserve me',
    );

    await prepareBackgroundWorkflowWorkspace(source, destination);
    await prepareBackgroundWorkflowWorkspace(source, destination);

    await expect(
      fs.readFile(path.join(destination, '.ai-pilot', 'kickoff-context.md'), 'utf8'),
    ).resolves.toBe('kickoff');
    await expect(
      fs.readFile(path.join(destination, '.ai-pilot', 'output', 'generated.json'), 'utf8'),
    ).resolves.toBe('{"version":2}');
    await expect(
      fs.readFile(path.join(destination, '.ai-pilot', 'output', 'preserved.md'), 'utf8'),
    ).resolves.toBe('preserve me');
  });

  it('AC-1 / DoD-2: rejects symlinks instead of copying content outside .ai-pilot', async () => {
    const source = path.join(tempRoot, 'thread');
    const destination = path.join(tempRoot, 'pinned');
    const outside = path.join(tempRoot, 'outside.txt');
    await fs.mkdir(path.join(source, '.ai-pilot'), { recursive: true });
    await fs.writeFile(outside, 'outside');

    try {
      await fs.symlink(outside, path.join(source, '.ai-pilot', 'linked.txt'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    await expect(
      prepareBackgroundWorkflowWorkspace(source, destination),
    ).rejects.toThrow(/symbolic link/i);
  });
});
