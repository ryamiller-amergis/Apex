/**
 * The Agent task is one step type (`cursor-agent`). Its Skill decides how it runs:
 * an interactive Skill opens a chat with an assignee, any other Skill (or none) runs on its own.
 *
 * These tests cover the adapter's choice. The chat itself is covered in `playbookAgentTaskChat.test.ts`.
 */
const enqueue = jest.fn();
jest.mock('../services/agentRunLifecycleService', () => ({ enqueue: (...a: unknown[]) => enqueue(...a) }));

const createThread = jest.fn();
const prepareBackgroundWorkflowTurn = jest.fn();
jest.mock('../services/chatAgentService', () => ({
  createThread: (...a: unknown[]) => createThread(...a),
  getThread: jest.fn().mockResolvedValue(null),
  prepareBackgroundWorkflowTurn: (...a: unknown[]) => prepareBackgroundWorkflowTurn(...a),
}));

const isFeatureEnabled = jest.fn();
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: (...a: unknown[]) => isFeatureEnabled(...a),
}));

const routeBackgroundWorkflow = jest.fn();
jest.mock('../services/backgroundWorkflowRouter', () => ({
  routeBackgroundWorkflow: (...a: unknown[]) => routeBackgroundWorkflow(...a),
}));

const getSkillConfig = jest.fn();
jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: (...a: unknown[]) => getSkillConfig(...a),
}));

jest.mock('../db/drizzle', () => ({ db: {} }));

const workItemPromptSection = jest.fn();
jest.mock('../services/playbookSteps/workItemContext', () => ({
  workItemPromptSection: (...a: unknown[]) => workItemPromptSection(...a),
}));

const suspendStepRun = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/playbookSteps/stepRuns', () => ({
  ...jest.requireActual('../services/playbookSteps/stepRuns'),
  suspendStepRun: (...a: unknown[]) => suspendStepRun(...a),
  failStepRun: jest.fn().mockResolvedValue(undefined),
  failStepRunForHuman: jest.fn().mockResolvedValue(true),
}));

const startAgentTaskChat = jest.fn();
jest.mock('../services/playbookSteps/agentTaskChat', () => ({
  startAgentTaskChat: (...a: unknown[]) => startAgentTaskChat(...a),
}));

const skillContents = new Map<string, string>();
jest.mock('../services/playbookExecutionCapabilityService', () => ({
  ...jest.requireActual('../services/playbookExecutionCapabilityService'),
  loadPlaybookSkillContent: async (skillPath: string) => {
    const found = skillContents.get(skillPath);
    if (found !== undefined) return found;
    // The built-in default Skill used when no path is named comes from the real loader.
    return jest.requireActual('../services/playbookExecutionCapabilityService')
      .loadPlaybookSkillContent(skillPath);
  },
  loadPlaybookSkillCompanions: async () => [],
}));

import { executeCursorAgentStep } from '../services/playbookSteps/cursorAgentAdapter';
import type { PlaybookStepExecutionContext } from '../services/playbookSteps/stepRuns';
import type { PlaybookGraph } from '../../shared/types/playbook';

const INTERACTIVE_PATH = 'foundation-skills/foundation/review-with-me/SKILL.md';
const AUTONOMOUS_PATH = 'foundation-skills/foundation/scan/SKILL.md';
const UNDECLARED_PATH = 'foundation-skills/foundation/plain/SKILL.md';
const BROKEN_PATH = 'foundation-skills/foundation/broken/SKILL.md';

const frontmatter = (extra: string) =>
  `---\nname: a-skill\ndescription: A skill.\n${extra}---\nBody`;

beforeEach(() => {
  jest.clearAllMocks();
  skillContents.clear();
  skillContents.set(INTERACTIVE_PATH, frontmatter('metadata:\n  apex:\n    skill-type: interactive\n    output-kind: report@1\n'));
  skillContents.set(AUTONOMOUS_PATH, frontmatter('metadata:\n  apex:\n    skill-type: autonomous\n'));
  skillContents.set(UNDECLARED_PATH, frontmatter(''));
  skillContents.set(BROKEN_PATH, 'no frontmatter at all');
  createThread.mockResolvedValue({ id: 'thread-1', workspaceDir: '/tmp/threads/thread-1' });
  getSkillConfig.mockResolvedValue({ skillRepo: 'apex/ai-pilot', skillBranch: 'main', skillProvider: 'github', defaultModel: 'claude-4' });
  enqueue.mockResolvedValue({ runId: 'agent-run-1' });
  isFeatureEnabled.mockResolvedValue(false);
  workItemPromptSection.mockResolvedValue(null);
  startAgentTaskChat.mockResolvedValue({ kind: 'suspended', expiresAt: '2030-01-01T00:00:00.000Z' });
});

function context(
  config: Record<string, unknown>,
  graph?: PlaybookGraph,
): PlaybookStepExecutionContext {
  return {
    runId: 'run-1',
    stepRunId: 'step-run-1',
    stepId: 'draft',
    stepType: 'cursor-agent',
    project: 'Apex',
    initiatorUserId: 'initiator-oid',
    config: { prompt: 'Review the draft', ...config },
    ...(graph ? { graph } : {}),
  };
}

describe('an interactive Skill makes the Agent task a chat', () => {
  it('hands the step to the chat and never enqueues an agent run itself', async () => {
    const outcome = await executeCursorAgentStep(
      context({ skillPath: INTERACTIVE_PATH, assigneeUserId: 'assignee-1' }),
    );

    expect(startAgentTaskChat).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: 'suspended', expiresAt: '2030-01-01T00:00:00.000Z' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(createThread).not.toHaveBeenCalled();
    expect(suspendStepRun).not.toHaveBeenCalled();
  });

  it('passes the Skill text, the config and the bare prompt (each chat turn adds the outcomes)', async () => {
    await executeCursorAgentStep(
      context({
        skillPath: INTERACTIVE_PATH,
        assigneeEmail: 'ba@example.com',
        outcomes: ['approved', 'needs work'],
      }),
    );

    const input = startAgentTaskChat.mock.calls[0][0];
    expect(input.config).toMatchObject({ assigneeEmail: 'ba@example.com', outcomes: ['approved', 'needs work'] });
    expect(input.skillContent).toContain('skill-type: interactive');
    expect(input.prompt).toBe('Review the draft');
    expect(input.skillConfig).toMatchObject({ skillRepo: 'apex/ai-pilot' });
  });

  it('adds the run work item to the opening context', async () => {
    workItemPromptSection.mockResolvedValue('## Azure DevOps work item 7\n\n**Title:** Clock-in fails');

    await executeCursorAgentStep(context({ skillPath: INTERACTIVE_PATH, assigneeUserId: 'assignee-1' }));

    expect(startAgentTaskChat.mock.calls[0][0].prompt).toBe(
      'Review the draft\n\n## Azure DevOps work item 7\n\n**Title:** Clock-in fails',
    );
  });

  it('accepts a deadline of days, which an autonomous task refuses', async () => {
    const threeDays = 3 * 24 * 60 * 60 * 1000;

    await executeCursorAgentStep(
      context({ skillPath: INTERACTIVE_PATH, assigneeUserId: 'assignee-1', deadlineMs: threeDays }),
    );

    expect(startAgentTaskChat.mock.calls[0][0].config.deadlineMs).toBe(threeDays);
  });

  it('still refuses a Skill whose bytes no longer match the policy frozen at publish', async () => {
    const graph = {
      nodes: [{
        id: 'draft',
        stepType: 'cursor-agent',
        config: {},
        agentPolicy: {
          schemaVersion: 1,
          resolverVersion: 1,
          executionProfile: 'repository-read-only',
          capabilities: ['repository-read', 'network-read'],
          skill: { path: INTERACTIVE_PATH, sha256: 'not-the-real-hash' },
          mcpServers: [],
          localAgent: { cwdMode: 'scratch', allowBuiltinWrites: false, customTools: 'none' },
          enforcement: 'enforce',
          resolvedAt: '2026-01-01T00:00:00.000Z',
        },
      }],
      edges: [],
    } as unknown as PlaybookGraph;

    await expect(
      executeCursorAgentStep(context({ skillPath: INTERACTIVE_PATH, assigneeUserId: 'a' }, graph)),
    ).rejects.toThrow(/no longer matches its Skill/);
    expect(startAgentTaskChat).not.toHaveBeenCalled();
  });
});

describe('any other Skill runs the agent on its own, as before', () => {
  it.each([
    ['a Skill that declares autonomous', AUTONOMOUS_PATH],
    ['a Skill that declares no type', UNDECLARED_PATH],
    ['a Skill whose frontmatter cannot be read', BROKEN_PATH],
  ])('enqueues an agent run for %s', async (_label, skillPath) => {
    const outcome = await executeCursorAgentStep(context({ skillPath }));

    expect(startAgentTaskChat).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(createThread.mock.calls[0][0]).toBe('initiator-oid');
    expect(suspendStepRun).toHaveBeenCalledWith(expect.objectContaining({ agentRunId: 'agent-run-1' }));
    expect(outcome).toMatchObject({ kind: 'suspended', agentRunId: 'agent-run-1' });
  });

  it.each([
    ['a Skill that declares autonomous', AUTONOMOUS_PATH],
    ['no Skill', undefined],
  ])('gives the agent the step prompt, its outcome line and the work item for %s', async (_label, skillPath) => {
    workItemPromptSection.mockResolvedValue('## Azure DevOps work item 7\n\n**Title:** Clock-in fails');

    await executeCursorAgentStep(
      context({ ...(skillPath ? { skillPath } : {}), prompt: 'Summarise the failure.', outcomes: ['fixed', 'blocked'] }),
    );

    const expected =
      'Summarise the failure.\n\nWhen you finish, end your reply with one line in exactly this form, choosing the result that fits best:\nOUTCOME: <one of: fixed | blocked>\n\n## Azure DevOps work item 7\n\n**Title:** Clock-in fails';
    expect(enqueue.mock.calls[0][0].snapshot.prompt).toBe(expected);
    expect(createThread.mock.calls[0][1].freeformContext).toBe(expected);
  });

  it('hands the same prompt to the V2 worker', async () => {
    isFeatureEnabled.mockResolvedValue(true);
    prepareBackgroundWorkflowTurn.mockResolvedValue({ prompt: 'prepared' });
    routeBackgroundWorkflow.mockImplementation(async (input: { prepareWorker: () => Promise<unknown> }) => {
      await input.prepareWorker();
      return { route: 'worker', runId: 'v2-run-1' };
    });

    await executeCursorAgentStep(context({ skillPath: AUTONOMOUS_PATH, prompt: 'Summarise the failure.' }));

    expect(enqueue).not.toHaveBeenCalled();
    expect(prepareBackgroundWorkflowTurn).toHaveBeenCalledWith('thread-1', 'Summarise the failure.');
  });

  it('runs on its own when no Skill is named (the default is non-interactive)', async () => {
    await executeCursorAgentStep(context({}));

    expect(startAgentTaskChat).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('ignores an assignee left on the node by an earlier Skill choice', async () => {
    await executeCursorAgentStep(context({ skillPath: AUTONOMOUS_PATH, assigneeUserId: 'assignee-1' }));

    expect(startAgentTaskChat).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(createThread.mock.calls[0][0]).toBe('initiator-oid');
  });

  it('keeps the 60-minute ceiling for an autonomous deadline', async () => {
    await expect(
      executeCursorAgentStep(context({ skillPath: AUTONOMOUS_PATH, deadlineMs: 2 * 60 * 60 * 1000 })),
    ).rejects.toThrow(/not exceed/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('lets an autonomous deadline be shorter than 60 minutes', async () => {
    await executeCursorAgentStep(context({ skillPath: AUTONOMOUS_PATH, deadlineMs: 10 * 60 * 1000 }));

    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('the mode is chosen after the checks every Agent task shares', () => {
  it('refuses a non-read MCP profile before choosing a mode', async () => {
    await expect(
      executeCursorAgentStep(context({ skillPath: INTERACTIVE_PATH, mcpProfile: 'repository-write' })),
    ).rejects.toThrow();
    expect(startAgentTaskChat).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
