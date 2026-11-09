jest.mock('../services/buildAccessService', () => ({
  isBuildFromPromptEnabled: jest.fn(),
  isBuildPairAllowed: jest.fn(),
}));
jest.mock('../services/buildOrchestrator/store', () => ({
  loadBuild: jest.fn(),
}));
jest.mock('../services/buildOrchestrator/planning', () => ({
  beginPlanning: jest.fn(),
}));
jest.mock('../services/playbookSteps/stepRuns', () => ({
  suspendStepRun: jest.fn(),
  deadlineFromNow: () => '2026-11-09T12:00:00.000Z',
}));

import { isBuildFromPromptEnabled, isBuildPairAllowed } from '../services/buildAccessService';
import { beginPlanning } from '../services/buildOrchestrator/planning';
import { loadBuild } from '../services/buildOrchestrator/store';
import { executeBuildStep } from '../services/playbookSteps/buildAdapter';
import { suspendStepRun } from '../services/playbookSteps/stepRuns';
import { getStepTypeDescriptor, validateStepTypeRegistry, createStepTypeRegistry, PRODUCTION_STEP_TYPES } from '../services/playbookSteps/registry';
import { adapterStepTypes } from '../services/playbookSteps';

const flag = isBuildFromPromptEnabled as jest.Mock;
const allowed = isBuildPairAllowed as jest.Mock;
const load = loadBuild as jest.Mock;
const plan = beginPlanning as jest.Mock;
const suspend = suspendStepRun as jest.Mock;

const context = {
  runId: 'run-1',
  stepRunId: 'step-1',
  stepId: 'build',
  stepType: 'build',
  project: 'Apex',
  initiatorUserId: 'user-1',
  config: { buildRunId: 'build-1', briefId: 'brief-1', interviewId: 'interview-1' },
};

describe('build step (VT-27, VT-28, VT-29, VT-30)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    flag.mockResolvedValue(true);
    allowed.mockResolvedValue(true);
    plan.mockResolvedValue(true);
    suspend.mockResolvedValue(undefined);
  });

  it('VT-27 registers a suspending writes-apex build step and fails boot without it', () => {
    const descriptor = getStepTypeDescriptor('build');
    expect(descriptor).toMatchObject({
      canSuspend: true,
      suspendReason: 'build',
      sideEffect: 'writes-apex',
      deadlineOverridable: false,
      isAgentStep: false,
      requiredPermissions: ['builds:run'],
      defaultDeadlineMs: 14 * 24 * 60 * 60 * 1000,
    });
    expect(() => validateStepTypeRegistry()).not.toThrow();
    expect([...adapterStepTypes()].sort()).toEqual(
      PRODUCTION_STEP_TYPES.map((item) => item.stepType).sort(),
    );
    const without = createStepTypeRegistry(PRODUCTION_STEP_TYPES.filter((item) => item.stepType !== 'build'));
    expect(() => validateStepTypeRegistry(without)).toThrow(/build/);
  });

  it('VT-28 parks the step and moves the build to planning', async () => {
    load.mockResolvedValue({
      id: 'build-1',
      project: 'Apex',
      repository: 'apex',
      status: 'intake',
      playbookRunId: 'run-1',
      playbookStepRunId: null,
    });
    const outcome = await executeBuildStep(context);
    expect(outcome).toEqual({ kind: 'suspended', expiresAt: '2026-11-09T12:00:00.000Z' });
    expect(suspend).toHaveBeenCalledWith(expect.objectContaining({
      stepRunId: 'step-1',
      resumeToken: 'build-1',
    }));
    expect(plan).toHaveBeenCalledWith('build-1', 'step-1');
  });

  it('VT-29 refuses a missing row, a mismatched run, a disabled flag, and a removed allow-list', async () => {
    load.mockResolvedValue(null);
    await expect(executeBuildStep(context)).rejects.toThrow(/does not exist/);
    load.mockResolvedValue({ id: 'build-1', project: 'Other', repository: 'apex', status: 'intake', playbookRunId: 'run-1' });
    await expect(executeBuildStep(context)).rejects.toThrow(/not part of/);
    load.mockResolvedValue({ id: 'build-1', project: 'Apex', repository: 'apex', status: 'intake', playbookRunId: 'run-1' });
    flag.mockResolvedValue(false);
    await expect(executeBuildStep(context)).rejects.toThrow(/turned off/);
    flag.mockResolvedValue(true);
    allowed.mockResolvedValue(false);
    await expect(executeBuildStep(context)).rejects.toThrow(/no longer approved/);
    expect(suspend).not.toHaveBeenCalled();
  });

  it('VT-30 a second run does not suspend or change status again', async () => {
    load.mockResolvedValue({
      id: 'build-1',
      project: 'Apex',
      repository: 'apex',
      status: 'planning',
      playbookRunId: 'run-1',
      playbookStepRunId: 'step-1',
    });
    await executeBuildStep(context);
    expect(suspend).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
  });
});
