import { createHash } from 'node:crypto';
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
  readDocumentScratchInputs,
  workerCanReadWithoutWorkingTree,
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
  const skillContent = '# Frozen to-prd skill';
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
      skillContent,
      skillSha256: createHash('sha256').update(skillContent).digest('hex'),
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
    // Worker routing on, V2 transport off — the shipped default.
    isFeatureEnabled: jest
      .fn()
      .mockImplementation(async (key: string) => key === 'ai-runs-background'),
    admitV2Run: jest.fn(),
    materializeRunGroundingWithPath: jest.fn().mockResolvedValue({
      state: 'materialized',
      workspacePath: 'C:\\grounding-workspaces\\opaque',
    }),
    prepareWorkspace: jest.fn().mockResolvedValue(undefined),
    sharedReadCheckout: {
      getReady: jest.fn().mockReturnValue(null),
      retain: jest.fn(),
    },
    clearGenerationOutput: jest.fn().mockResolvedValue(undefined),
    enqueue: jest.fn().mockResolvedValue({ runId: 'run-1' }),
    resolveHardLimitMs: jest.fn().mockReturnValue(60_000),
    now: jest.fn().mockReturnValue(1_000),
    trackEvent: jest.fn(),
    isUsableBareMirror: jest.fn().mockReturnValue(false),
    readDocumentScratchInputs: jest.fn().mockResolvedValue([
      {
        path: '.ai-pilot/kickoff-transcript.md',
        content: '# Interview transcript',
      },
    ]),
    ...overrides,
  } as BackgroundWorkflowRouterDependencies;
}

describe('workerCanReadWithoutWorkingTree', () => {
  it('allows skip when HTTP URL is set even on App Service', () => {
    expect(workerCanReadWithoutWorkingTree({
      REPO_READ_SERVICE_URL: 'https://repo-read.test',
      WEBSITE_INSTANCE_ID: 'instance-1',
    })).toBe(true);
  });

  it('refuses skip on App Service without HTTP', () => {
    expect(workerCanReadWithoutWorkingTree({
      WEBSITE_INSTANCE_ID: 'instance-1',
    })).toBe(false);
  });

  it('allows skip on local/dev hosts', () => {
    expect(workerCanReadWithoutWorkingTree({})).toBe(true);
  });
});

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

  it('reuses the interview shared SHA checkout for PRD without a full clone', async () => {
    const retain = jest.fn();
    const getReady = jest.fn().mockReturnValue({
      workspacePath: 'C:\\shared\\grounding-shared\\sha-digest',
    });
    const clearGenerationOutput = jest.fn().mockResolvedValue(undefined);
    const enqueue = jest.fn().mockResolvedValue({ runId: 'run-1' });
    const dependencies = makeDependencies({
      sharedReadCheckout: { getReady, retain },
      clearGenerationOutput,
      enqueue,
    });

    const decision = await createBackgroundWorkflowRouter(dependencies).route(
      makeInput(),
    );

    expect(decision).toEqual<WorkflowRouteDecision>({
      route: 'worker',
      workspacePath: 'C:\\threads\\thread-1',
      runId: 'run-1',
    });
    expect(getReady).toHaveBeenCalled();
    expect(retain).toHaveBeenCalled();
    expect(clearGenerationOutput).toHaveBeenCalledWith('C:\\threads\\thread-1');
    expect(dependencies.materializeRunGroundingWithPath).not.toHaveBeenCalled();
    expect(dependencies.prepareWorkspace).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          workspaceRef: 'C:\\threads\\thread-1',
          checkoutRef: 'C:\\shared\\grounding-shared\\sha-digest',
          workflowClass: 'prd',
        }),
      }),
    );
  });

  it('reuses shared SHA checkout for design-doc the same way as PRD', async () => {
    const dependencies = makeDependencies({
      sharedReadCheckout: {
        getReady: jest.fn().mockReturnValue({
          workspacePath: 'C:\\shared\\design-doc-sha',
        }),
        retain: jest.fn(),
      },
    });

    const decision = await createBackgroundWorkflowRouter(dependencies).route(
      makeInput({ workflowClass: 'design-doc' }),
    );

    expect(decision).toEqual(
      expect.objectContaining({
        route: 'worker',
        workspacePath: 'C:\\threads\\thread-1',
      }),
    );
    expect(dependencies.materializeRunGroundingWithPath).not.toHaveBeenCalled();
  });

  it('falls back to full writable clone when shared checkout is not ready', async () => {
    const dependencies = makeDependencies({
      sharedReadCheckout: {
        getReady: jest.fn().mockReturnValue(null),
        retain: jest.fn(),
      },
    });

    const decision = await createBackgroundWorkflowRouter(dependencies).route(
      makeInput(),
    );

    expect(decision).toEqual(
      expect.objectContaining({
        route: 'worker',
        workspacePath: 'C:\\grounding-workspaces\\opaque',
      }),
    );
    expect(dependencies.materializeRunGroundingWithPath).toHaveBeenCalled();
    expect(dependencies.prepareWorkspace).toHaveBeenCalled();
  });

  it('skips the writable clone when a usable bare mirror is worker-visible', async () => {
    const clearGenerationOutput = jest.fn().mockResolvedValue(undefined);
    const enqueue = jest.fn().mockResolvedValue({ runId: 'run-1' });
    const getReady = jest.fn().mockReturnValue({
      workspacePath: 'C:\\shared\\should-not-use',
    });
    const dependencies = makeDependencies({
      getRepoCacheDir: jest.fn().mockReturnValue('C:\\repo-cache\\apex.git'),
      isUsableBareMirror: jest.fn().mockReturnValue(true),
      workerCanReadWithoutWorkingTree: jest.fn().mockReturnValue(true),
      sharedReadCheckout: { getReady, retain: jest.fn() },
      clearGenerationOutput,
      enqueue,
    });

    const decision = await createBackgroundWorkflowRouter(dependencies).route(
      makeInput(),
    );

    expect(decision).toEqual<WorkflowRouteDecision>({
      route: 'worker',
      workspacePath: 'C:\\threads\\thread-1',
      runId: 'run-1',
    });
    expect(clearGenerationOutput).toHaveBeenCalledWith('C:\\threads\\thread-1');
    expect(getReady).not.toHaveBeenCalled();
    expect(dependencies.materializeRunGroundingWithPath).not.toHaveBeenCalled();
    expect(dependencies.prepareWorkspace).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          workspaceRef: 'C:\\threads\\thread-1',
          mirrorRef: 'C:\\repo-cache\\apex.git',
          groundedSha: 'abc123',
          repository: 'apex/ai-pilot',
          provider: 'github',
          workflowClass: 'prd',
        }),
      }),
    );
    expect(
      (enqueue as jest.Mock).mock.calls[0][0].snapshot.checkoutRef,
    ).toBeUndefined();
  });

  it('keeps the writable clone when App Service cannot expose the mirror to ACA', async () => {
    const dependencies = makeDependencies({
      getRepoCacheDir: jest.fn().mockReturnValue('C:\\repo-cache\\apex.git'),
      isUsableBareMirror: jest.fn().mockReturnValue(true),
      workerCanReadWithoutWorkingTree: jest.fn().mockReturnValue(false),
      sharedReadCheckout: {
        getReady: jest.fn().mockReturnValue(null),
        retain: jest.fn(),
      },
    });

    const decision = await createBackgroundWorkflowRouter(dependencies).route(
      makeInput(),
    );

    expect(decision).toEqual(
      expect.objectContaining({
        route: 'worker',
        workspacePath: 'C:\\grounding-workspaces\\opaque',
      }),
    );
    expect(dependencies.materializeRunGroundingWithPath).toHaveBeenCalled();
    expect(dependencies.prepareWorkspace).toHaveBeenCalled();
  });

  it('routes validation as scratch-only (no repo checkout or shared SHA)', async () => {
    const getReady = jest.fn().mockReturnValue({
      workspacePath: 'C:\\shared\\should-not-use',
    });
    const clearGenerationOutput = jest.fn().mockResolvedValue(undefined);
    const enqueue = jest.fn().mockResolvedValue({ runId: 'run-1' });
    const dependencies = makeDependencies({
      isFeatureEnabled: jest
        .fn()
        .mockImplementation(async (key: string) => key === 'ai-runs-background'),
      sharedReadCheckout: { getReady, retain: jest.fn() },
      clearGenerationOutput,
      enqueue,
    });

    const decision = await createBackgroundWorkflowRouter(dependencies).route(
      makeInput({ workflowClass: 'validation' }),
    );

    expect(decision).toEqual<WorkflowRouteDecision>({
      route: 'worker',
      workspacePath: 'C:\\threads\\thread-1',
      runId: 'run-1',
    });
    expect(getReady).not.toHaveBeenCalled();
    expect(dependencies.materializeRunGroundingWithPath).not.toHaveBeenCalled();
    expect(dependencies.prepareWorkspace).not.toHaveBeenCalled();
    expect(clearGenerationOutput).toHaveBeenCalledWith('C:\\threads\\thread-1');
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          workspaceRef: 'C:\\threads\\thread-1',
          workflowClass: 'validation',
        }),
      }),
    );
    const snapshot = (enqueue.mock.calls[0][0] as { snapshot: ExecutionSnapshot })
      .snapshot;
    expect(snapshot.checkoutRef).toBeUndefined();
  });

  it('routes validation without usable target grounding', async () => {
    const enqueue = jest.fn().mockResolvedValue({ runId: 'run-1' });
    const dependencies = makeDependencies({ enqueue });

    const decision = await createBackgroundWorkflowRouter(dependencies).route(
      makeInput({
        workflowClass: 'validation',
        prepareWorker: jest.fn().mockResolvedValue({
          targetGrounding: null,
          threadWorkspacePath: 'C:\\threads\\validation-1',
          prompt: 'score the doc',
          model: 'claude-4',
          skillPath: '.cursor/skills/prd-spec-review/SKILL.md',
          projectId: 'project-1',
        }),
      }),
    );

    expect(decision).toEqual(
      expect.objectContaining({
        route: 'worker',
        workspacePath: 'C:\\threads\\validation-1',
      }),
    );
    expect(dependencies.materializeRunGroundingWithPath).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalled();
  });

  it('TBI-007 DoD-0 / DoD-1 / VT-07: targets every workflow vocabulary independently by project and caller', async () => {
    const workflows: BackgroundWorkflowClass[] = [
      'prd',
      'design-doc',
      'validation',
      'test-cases',
      'walkthrough-smart-tagging',
    ];
    const evaluations: Array<{ project: string; caller?: string }> = [];
    const dependencies = makeDependencies({
      isFeatureEnabled: jest.fn().mockImplementation(
        async (key: string, context: { project: string; caller?: string }) => {
          if (key !== 'ai-runs-background') return false;
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
      'worker',
    ]);
  });

  it('keeps the V1 transport while the V2 flag is off', async () => {
    const dependencies = makeDependencies();

    await createBackgroundWorkflowRouter(dependencies).route(makeInput());

    expect(dependencies.enqueue).toHaveBeenCalledTimes(1);
    expect(dependencies.admitV2Run).not.toHaveBeenCalled();
    expect(dependencies.isFeatureEnabled).toHaveBeenCalledWith(
      'ai-runs-v2-transport',
      { userId: 'user-1', project: 'Apex', caller: 'prd' },
    );
  });

  it('admits onto the V2 transport instead of V1 when the flag is on', async () => {
    const admitV2Run = jest.fn().mockResolvedValue({
      status: 'dispatched',
      runId: 'run-1',
      attemptId: 'attempt-1',
      attemptNumber: 1,
      dispatchMessageId: 'dispatch-1',
      outboxId: 'outbox-1',
    });
    const dependencies = makeDependencies({
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
      admitV2Run,
    });

    const decision = await createBackgroundWorkflowRouter(dependencies).route(
      makeInput(),
    );

    expect(decision).toEqual<WorkflowRouteDecision>({
      route: 'worker',
      workspacePath: 'C:\\grounding-workspaces\\opaque',
      runId: 'run-1',
    });
    expect(dependencies.enqueue).not.toHaveBeenCalled();
    expect(admitV2Run).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        threadId: 'thread-1',
        projectId: 'project-1',
        workloadLane: 'document',
        capacityClass: 'batch',
        specification: expect.objectContaining({ workflowClass: 'prd' }),
      }),
    );
  });

  it('freezes every worker input into the V2 document specification', async () => {
    const admitV2Run = jest.fn().mockResolvedValue({
      status: 'dispatched',
      runId: 'run-1',
      attemptId: 'attempt-1',
      attemptNumber: 1,
      dispatchMessageId: 'dispatch-1',
      outboxId: 'outbox-1',
    });
    const readDocumentScratchInputs = jest.fn().mockResolvedValue([
      {
        path: '.ai-pilot/kickoff-transcript.md',
        content: '# Interview transcript',
      },
    ]);
    const dependencies = makeDependencies({
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
      admitV2Run,
      readDocumentScratchInputs,
    } as Partial<BackgroundWorkflowRouterDependencies>);

    await createBackgroundWorkflowRouter(dependencies).route(makeInput());

    expect(readDocumentScratchInputs).toHaveBeenCalledWith(
      'C:\\threads\\thread-1',
      'prd',
    );
    const admission = admitV2Run.mock.calls[0][0] as {
      specification: Record<string, unknown>;
      executionSnapshot?: Record<string, unknown>;
      timeoutAt: string;
    };
    expect(admission.timeoutAt).toBe('1970-01-01T00:01:01.000Z');
    expect(admission.specification).toMatchObject({
      prompt: 'confidential generation prompt',
      model: 'claude-4',
      effort: null,
      skillPath: '.cursor/skills/to-prd/SKILL.md',
      skillContent: '# Frozen to-prd skill',
      skillSha256: createHash('sha256')
        .update('# Frozen to-prd skill')
        .digest('hex'),
      workflowClass: 'prd',
      projectId: 'project-1',
      threadId: 'thread-1',
      deadlineMs: 60_000,
      groundedSha: 'abc123',
      repository: 'apex/ai-pilot',
      provider: 'github',
      scratchInputs: [
        {
          path: '.ai-pilot/kickoff-transcript.md',
          content: '# Interview transcript',
        },
      ],
    });
    expect(admission.executionSnapshot).toEqual(admission.specification);
    expect(admission.specification).not.toHaveProperty('workspaceRef');
    expect(admission.specification).not.toHaveProperty('checkoutRef');
    expect(admission.specification).not.toHaveProperty('mirrorRef');
  });

  it('recovers in-process when V2 admission refuses or throws', async () => {
    const conflict = makeDependencies({
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
      admitV2Run: jest.fn().mockResolvedValue({
        status: 'active_run_conflict',
        existingRunId: 'run-0',
        existingTransportVersion: 'http-files-v1',
        existingStatus: 'running',
      }),
    });
    const conflictInput = makeInput();

    await createBackgroundWorkflowRouter(conflict).route(conflictInput);
    expect(conflictInput.runInProcess).toHaveBeenCalledTimes(1);

    const thrown = makeDependencies({
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
      admitV2Run: jest.fn().mockRejectedValue(new Error('blob unavailable')),
    });
    const thrownInput = makeInput();

    await createBackgroundWorkflowRouter(thrown).route(thrownInput);
    expect(thrownInput.runInProcess).toHaveBeenCalledTimes(1);
  });

  it('keeps the V1 transport when the V2 flag cannot be read', async () => {
    const dependencies = makeDependencies({
      isFeatureEnabled: jest
        .fn()
        .mockImplementation(async (key: string) => {
          if (key === 'ai-runs-background') return true;
          throw new Error('flag store unavailable');
        }),
    });

    await createBackgroundWorkflowRouter(dependencies).route(makeInput());

    expect(dependencies.enqueue).toHaveBeenCalledTimes(1);
    expect(dependencies.admitV2Run).not.toHaveBeenCalled();
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
      isFeatureEnabled: jest
        .fn()
        .mockImplementation(async (key: string) =>
          key === 'ai-runs-background' ? enabled : false,
        ),
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
  ])('cold external project: %s falls back in-process and never enqueues', async (_case, grounding) => {
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
      fallbackStarted: true,
    });
    expect(input.runInProcess).toHaveBeenCalledTimes(1);
    expect(input.reportRecoverablePreparationFailure).not.toHaveBeenCalled();
    expect(dependencies.materializeRunGroundingWithPath).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('cold external project: worker preparation throw starts in-process fallback', async () => {
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
      fallbackStarted: true,
    });
    expect(input.reportRecoverablePreparationFailure).not.toHaveBeenCalled();
    expect(input.runInProcess).toHaveBeenCalledTimes(1);
    expect(dependencies.materializeRunGroundingWithPath).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['returns unavailable', jest.fn().mockResolvedValue({ state: 'unavailable' })],
    ['throws', jest.fn().mockRejectedValue(new Error('checkout unavailable'))],
  ])('cold external project: materialization %s starts fallback without enqueue', async (_case, materialize) => {
    const dependencies = makeDependencies({
      materializeRunGroundingWithPath: materialize,
    });
    const input = makeInput();

    const decision = await createBackgroundWorkflowRouter(dependencies).route(input);

    expect(decision).toEqual<WorkflowRouteDecision>({
      route: 'in-process',
      reason: 'materialization-unavailable',
      fallbackStarted: true,
    });
    expect(input.reportRecoverablePreparationFailure).not.toHaveBeenCalled();
    expect(input.runInProcess).toHaveBeenCalledTimes(1);
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
      fallbackStarted: true,
    });
    expect(input.reportRecoverablePreparationFailure).not.toHaveBeenCalled();
    expect(input.runInProcess).toHaveBeenCalledTimes(1);
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('routes in-process when worker enqueue is unavailable', async () => {
    const dependencies = makeDependencies({
      enqueue: jest.fn().mockRejectedValue(new Error('worker unavailable')),
    });
    const input = makeInput();

    const decision = await createBackgroundWorkflowRouter(dependencies).route(input);

    expect(decision).toEqual<WorkflowRouteDecision>({
      route: 'in-process',
      reason: 'materialization-unavailable',
      fallbackStarted: true,
    });
    expect(input.runInProcess).toHaveBeenCalledTimes(1);
    expect(input.reportRecoverablePreparationFailure).not.toHaveBeenCalled();
  });

  it('marks terminal failure only after worker preparation and in-process fallback both fail', async () => {
    const dependencies = makeDependencies();
    const input = makeInput({
      prepareWorker: jest.fn().mockRejectedValue(new Error('worker unavailable')),
      runInProcess: jest.fn().mockRejectedValue(new Error('in-process unavailable')),
    });

    await createBackgroundWorkflowRouter(dependencies).route(input);
    await Promise.resolve();
    await Promise.resolve();

    expect(input.runInProcess).toHaveBeenCalledTimes(1);
    expect(input.reportRecoverablePreparationFailure).toHaveBeenCalledTimes(1);
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

  it('copies only the allowlisted PRD scratch inputs into a V2 specification', async () => {
    const aiPilot = path.join(tempRoot, '.ai-pilot');
    await fs.mkdir(path.join(aiPilot, 'output'), { recursive: true });
    await fs.writeFile(
      path.join(aiPilot, 'kickoff-transcript.md'),
      '# Transcript',
      'utf8',
    );
    await fs.writeFile(
      path.join(aiPilot, 'kickoff-context.md'),
      '# Context',
      'utf8',
    );
    await fs.writeFile(
      path.join(aiPilot, 'session.json'),
      '{"threadId":"thread-1"}',
      'utf8',
    );
    await fs.writeFile(path.join(aiPilot, 'secret.env'), 'TOKEN=secret', 'utf8');
    await fs.writeFile(
      path.join(aiPilot, 'output', 'leftover.prd.md'),
      '# Stale output',
      'utf8',
    );

    await expect(readDocumentScratchInputs(tempRoot, 'prd')).resolves.toEqual([
      {
        path: '.ai-pilot/kickoff-context.md',
        content: '# Context',
      },
      {
        path: '.ai-pilot/kickoff-transcript.md',
        content: '# Transcript',
      },
      {
        path: '.ai-pilot/session.json',
        content: '{"threadId":"thread-1"}',
      },
    ]);
  });

  it('carries the PRD and backlog scratch files needed by test-case generation', async () => {
    const aiPilot = path.join(tempRoot, '.ai-pilot');
    const output = path.join(aiPilot, 'output');
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(
      path.join(aiPilot, 'kickoff-context.md'),
      '# Test context',
      'utf8',
    );
    await fs.writeFile(path.join(output, 'feature.prd.md'), '# PRD', 'utf8');
    await fs.writeFile(
      path.join(output, 'feature.backlog.json'),
      '{"epics":[]}',
      'utf8',
    );
    await fs.writeFile(
      path.join(output, 'stale.test-cases.json'),
      '{"suites":[]}',
      'utf8',
    );

    await expect(
      readDocumentScratchInputs(tempRoot, 'test-cases'),
    ).resolves.toEqual([
      {
        path: '.ai-pilot/kickoff-context.md',
        content: '# Test context',
      },
      {
        path: '.ai-pilot/output/feature.backlog.json',
        content: '{"epics":[]}',
      },
      {
        path: '.ai-pilot/output/feature.prd.md',
        content: '# PRD',
      },
    ]);
  });

  it('does not copy a transcript into scratch-only validation work', async () => {
    const aiPilot = path.join(tempRoot, '.ai-pilot');
    await fs.mkdir(aiPilot, { recursive: true });
    await fs.writeFile(
      path.join(aiPilot, 'kickoff-context.md'),
      '# Validation context',
      'utf8',
    );
    await fs.writeFile(
      path.join(aiPilot, 'kickoff-transcript.md'),
      '# Unused transcript',
      'utf8',
    );

    await expect(
      readDocumentScratchInputs(tempRoot, 'validation'),
    ).resolves.toEqual([
      {
        path: '.ai-pilot/kickoff-context.md',
        content: '# Validation context',
      },
    ]);
  });

  it('BR-007 / VT-01: merges .ai-pilot inputs/outputs and drops destination-only leftovers', async () => {
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
      fs.access(path.join(destination, '.ai-pilot', 'output', 'preserved.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('clears destination-only leftover output before overlaying thread .ai-pilot', async () => {
    const source = path.join(tempRoot, 'thread-fresh');
    const destination = path.join(tempRoot, 'pinned-contaminated');
    await fs.mkdir(path.join(source, '.ai-pilot'), { recursive: true });
    await fs.mkdir(path.join(destination, '.ai-pilot', 'output'), { recursive: true });
    await fs.writeFile(
      path.join(source, '.ai-pilot', 'kickoff-transcript.md'),
      '# Interview Transcript\n\n**User:** add a counter\n',
    );
    await fs.writeFile(
      path.join(destination, '.ai-pilot', 'output', 'blackout-date.prd.md'),
      '# Blackout Date Rule Administration\n',
    );
    await fs.writeFile(
      path.join(destination, '.ai-pilot', 'output', 'blackout-date.backlog.json'),
      '{}',
    );

    await prepareBackgroundWorkflowWorkspace(source, destination);

    await expect(
      fs.readFile(path.join(destination, '.ai-pilot', 'kickoff-transcript.md'), 'utf8'),
    ).resolves.toContain('add a counter');
    await expect(
      fs.access(path.join(destination, '.ai-pilot', 'output', 'blackout-date.prd.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.access(path.join(destination, '.ai-pilot', 'output', 'blackout-date.backlog.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
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
