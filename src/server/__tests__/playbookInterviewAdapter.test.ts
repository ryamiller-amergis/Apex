/**
 * Phase 1 interview step contract.
 *
 * VT-STEP-2 rejects invalid config before any profile read or row write.
 * VT-STEP-4 resolves the profile key before creating a thread or interview.
 * VT-STEP-5 creates one of each, then parks the step on the interview id.
 * VT-STEP-6 keeps dispatch and the registry on the same set of step types.
 */
const resolveSkillConfig = jest.fn();
jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: (...args: unknown[]) => resolveSkillConfig(...args),
}));

const isFeatureEnabled = jest.fn();
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: (...args: unknown[]) => isFeatureEnabled(...args),
}));

const createThread = jest.fn();
const sendMessage = jest.fn();
jest.mock('../services/chatAgentService', () => ({
  createThread: (...args: unknown[]) => createThread(...args),
  sendMessage: (...args: unknown[]) => sendMessage(...args),
}));

const createInterview = jest.fn();
jest.mock('../services/interviewService', () => ({
  createInterview: (...args: unknown[]) => createInterview(...args),
}));

const suspendStepRun = jest.fn();
jest.mock('../services/playbookSteps/stepRuns', () => ({
  ...jest.requireActual('../services/playbookSteps/stepRuns'),
  suspendStepRun: (...args: unknown[]) => suspendStepRun(...args),
}));

const getUserPermissions = jest.fn();
jest.mock('../services/rbacService', () => ({
  getUserPermissions: (...args: unknown[]) => getUserPermissions(...args),
}));

import { executeStep, adapterStepTypes, listStepTypeDescriptors } from '../services/playbookSteps';
import { executeInterviewStep } from '../services/playbookSteps/interviewAdapter';
import type { PlaybookStepExecutionContext } from '../services/playbookSteps/stepRuns';
import type { InterviewSkillOption } from '../../shared/types/projectSettings';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = '2026-10-07T16:00:00.000Z';

const PROFILE: InterviewSkillOption = {
  key: 'ba-discovery',
  path: '.cursor/skills/grill-with-docs/SKILL.md',
  friendlyName: 'BA discovery',
  model: 'claude-sonnet',
  effort: 'high',
  wantsDesignPrototype: false,
  wantsTestCases: true,
};

function skillConfig(options: InterviewSkillOption[] | null = [PROFILE]) {
  return {
    id: 'settings-1',
    project: 'Apex',
    friendlyName: 'Apex skills',
    isDefault: true,
    skillRepo: 'org/apex',
    skillBranch: 'main',
    skillProvider: 'ado' as const,
    interviewSkillOptions: options,
    interviewModel: 'project-model',
    interviewEffort: 'medium' as const,
    defaultModel: 'default-model',
  };
}

function context(config: Record<string, unknown>): PlaybookStepExecutionContext {
  return {
    runId: 'run-1',
    stepRunId: 'step-run-1',
    stepId: 'interview-node',
    stepType: 'interview',
    project: 'Apex',
    initiatorUserId: 'initiator-1',
    config,
  };
}

const validConfig = { mode: 'human_led', profileKey: 'ba-discovery' };

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(new Date(NOW));
  resolveSkillConfig.mockResolvedValue(skillConfig());
  isFeatureEnabled.mockResolvedValue(true);
  createThread.mockResolvedValue({ id: 'thread-1' });
  sendMessage.mockResolvedValue(undefined);
  createInterview.mockResolvedValue({ interviewId: 'interview-1', threadId: 'thread-1' });
  suspendStepRun.mockResolvedValue(undefined);
  getUserPermissions.mockResolvedValue(new Set(['playbooks:run']));
});

it('refuses execution before profile resolution when the project flag is disabled', async () => {
  isFeatureEnabled.mockResolvedValue(false);

  await expect(executeInterviewStep(context(validConfig))).rejects.toThrow(
    'The Playbook interview step is disabled for project Apex.',
  );

  expect(resolveSkillConfig).not.toHaveBeenCalled();
  expect(createThread).not.toHaveBeenCalled();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('VT-STEP-2 — invalid interview config is rejected before side effects', () => {
  it.each([
    ['mode', { mode: 'assisted', profileKey: 'ba-discovery' }],
    ['profileKey', { mode: 'human_led', profileKey: '   ' }],
    ['profileKey', { mode: 'human_led', profileKey: '' }],
    ['deadlineMs', { mode: 'human_led', profileKey: 'ba-discovery', deadlineMs: HOUR_MS - 1 }],
    ['deadlineMs', { mode: 'human_led', profileKey: 'ba-discovery', deadlineMs: 14 * DAY_MS + 1 }],
  ])('rejects invalid %s before permission lookup or interview creation', async (field, config) => {
    await expect(executeStep(context(config))).rejects.toThrow(
      new RegExp(`interview.*input.*${field}`, 'i')
    );

    expect(getUserPermissions).not.toHaveBeenCalled();
    expect(resolveSkillConfig).not.toHaveBeenCalled();
    expect(createThread).not.toHaveBeenCalled();
    expect(createInterview).not.toHaveBeenCalled();
    expect(suspendStepRun).not.toHaveBeenCalled();
  });
});

describe('VT-STEP-4 — the profile key is resolved before anything is created', () => {
  it.each([
    ['missing', null],
    ['missing', [] as InterviewSkillOption[]],
    ['missing', [{ path: PROFILE.path, friendlyName: PROFILE.friendlyName }]],
    ['missing', [{ ...PROFILE, key: 'other-profile' }]],
    ['disabled', [{ ...PROFILE, enabled: false }]],
  ])('a %s profile names the project and key and creates nothing', async (_kind, options) => {
    resolveSkillConfig.mockResolvedValue(options === null ? null : skillConfig(options));

    await expect(executeInterviewStep(context(validConfig))).rejects.toThrow(/Apex/);
    await expect(executeInterviewStep(context(validConfig))).rejects.toThrow(/ba-discovery/);

    expect(resolveSkillConfig).toHaveBeenCalledWith({ project: 'Apex' });
    expect(createThread).not.toHaveBeenCalled();
    expect(createInterview).not.toHaveBeenCalled();
    expect(suspendStepRun).not.toHaveBeenCalled();
  });
});

describe('VT-STEP-5 — a valid profile starts one interview and suspends on its id', () => {
  it('creates one thread and one interview from the profile snapshot, then parks for 7 days', async () => {
    const outcome = await executeInterviewStep(context(validConfig));

    expect(resolveSkillConfig.mock.invocationCallOrder[0]).toBeLessThan(
      createThread.mock.invocationCallOrder[0]
    );
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(createThread).toHaveBeenCalledWith(
      'initiator-1',
      expect.objectContaining({
        project: 'Apex',
        repo: 'org/apex',
        skillPath: PROFILE.path,
        model: 'claude-sonnet',
        effort: 'high',
        skillSettingsId: 'settings-1',
        playbookInterview: {
          runId: 'run-1',
          stepId: 'interview-node',
          snapshot: {
            mode: 'human_led',
            key: 'ba-discovery',
            skillPath: PROFILE.path,
            model: 'claude-sonnet',
            effort: 'high',
            wantsDesignPrototype: false,
            wantsTestCases: true,
          },
        },
      }),
      { skipAutoKickoff: true }
    );
    expect(createInterview).toHaveBeenCalledTimes(1);
    expect(createInterview).toHaveBeenCalledWith({
      userId: 'initiator-1',
      project: 'Apex',
      repo: 'org/apex',
      title: 'BA discovery',
      chatThreadId: 'thread-1',
      model: 'claude-sonnet',
      effort: 'high',
      skillSettingsId: 'settings-1',
      prototypeStageEnabled: false,
      testCasesEnabled: true,
      playbookRunId: 'run-1',
      playbookStepRunId: 'step-run-1',
      playbookInterviewMode: 'human_led',
      playbookProfileKey: 'ba-discovery',
      playbookProfileSnapshot: {
        mode: 'human_led',
        key: 'ba-discovery',
        skillPath: PROFILE.path,
        model: 'claude-sonnet',
        effort: 'high',
        wantsDesignPrototype: false,
        wantsTestCases: true,
      },
    });
    expect(suspendStepRun).toHaveBeenCalledTimes(1);
    expect(suspendStepRun).toHaveBeenCalledWith({
      stepRunId: 'step-run-1',
      expiresAt: new Date(Date.parse(NOW) + 7 * DAY_MS).toISOString(),
      resumeToken: 'interview-1',
    });
    expect(sendMessage).toHaveBeenCalledWith('thread-1', 'Begin.');
    expect(outcome).toEqual({
      kind: 'suspended',
      expiresAt: new Date(Date.parse(NOW) + 7 * DAY_MS).toISOString(),
    });
  });

  it('uses a validated deadline override and records assisted mode on the snapshot', async () => {
    await executeInterviewStep(
      context({ mode: 'multi_agent_assisted', profileKey: 'ba-discovery', deadlineMs: 2 * HOUR_MS })
    );

    expect(createThread).toHaveBeenCalledTimes(1);
    expect(createInterview).toHaveBeenCalledTimes(1);
    expect(createThread).toHaveBeenCalledWith(
      'initiator-1',
      expect.objectContaining({
        playbookInterview: expect.objectContaining({
          snapshot: expect.objectContaining({ mode: 'multi_agent_assisted', key: 'ba-discovery' }),
        }),
      }),
      { skipAutoKickoff: true }
    );
    expect(suspendStepRun).toHaveBeenCalledWith({
      stepRunId: 'step-run-1',
      expiresAt: new Date(Date.parse(NOW) + 2 * HOUR_MS).toISOString(),
      resumeToken: 'interview-1',
    });
  });
});

describe('VT-BRIEF-3 — the adapter passes Playbook linkage into createInterview', () => {
  it('VT-BRIEF-3 passes runId, stepRunId, mode, profile key, and snapshot', async () => {
    await executeInterviewStep(context(validConfig));

    expect(createInterview).toHaveBeenCalledWith(
      expect.objectContaining({
        playbookRunId: 'run-1',
        playbookStepRunId: 'step-run-1',
        playbookInterviewMode: 'human_led',
        playbookProfileKey: 'ba-discovery',
        playbookProfileSnapshot: {
          mode: 'human_led',
          key: 'ba-discovery',
          skillPath: PROFILE.path,
          model: 'claude-sonnet',
          effort: 'high',
          wantsDesignPrototype: false,
          wantsTestCases: true,
        },
      }),
    );
  });

  it('VT-BRIEF-3 records assisted mode on the same linkage', async () => {
    await executeInterviewStep(
      context({ mode: 'multi_agent_assisted', profileKey: 'ba-discovery', deadlineMs: 2 * HOUR_MS }),
    );

    expect(createInterview).toHaveBeenCalledWith(
      expect.objectContaining({
        playbookRunId: 'run-1',
        playbookStepRunId: 'step-run-1',
        playbookInterviewMode: 'multi_agent_assisted',
        playbookProfileKey: 'ba-discovery',
        playbookProfileSnapshot: expect.objectContaining({
          mode: 'multi_agent_assisted',
          key: 'ba-discovery',
        }),
      }),
    );
  });
});

describe('VT-ASSIST-7 — assisted interviews use the Lead skill on the main thread', () => {
  it('sets the orchestrator skill for multi_agent_assisted and keeps the profile skill for human_led', async () => {
    await executeInterviewStep(context(validConfig));

    expect(createThread).toHaveBeenCalledWith(
      'initiator-1',
      expect.objectContaining({ skillPath: PROFILE.path }),
      { skipAutoKickoff: true },
    );

    createThread.mockClear();
    await executeInterviewStep(
      context({ mode: 'multi_agent_assisted', profileKey: 'ba-discovery' }),
    );

    expect(createThread).toHaveBeenCalledWith(
      'initiator-1',
      expect.objectContaining({
        skillPath: '.cursor/skills/interview-orchestrator/SKILL.md',
        playbookInterview: expect.objectContaining({
          snapshot: expect.objectContaining({
            mode: 'multi_agent_assisted',
            skillPath: PROFILE.path,
          }),
        }),
      }),
      { skipAutoKickoff: true },
    );
  });
});

describe('VT-STEP-6 — dispatch includes the interview adapter', () => {
  it('keeps the adapter set equal to the registry and runs the interview adapter', async () => {
    expect(adapterStepTypes()).toContain('interview');
    expect([...adapterStepTypes()].sort()).toEqual(
      listStepTypeDescriptors()
        .map((descriptor) => descriptor.stepType)
        .sort()
    );

    await executeStep(context(validConfig));

    expect(createThread).toHaveBeenCalledTimes(1);
    expect(createInterview).toHaveBeenCalledTimes(1);
    expect(suspendStepRun).toHaveBeenCalledWith(
      expect.objectContaining({ resumeToken: 'interview-1' })
    );
  });
});
