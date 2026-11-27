/**
 * The chat side of the Agent task: what happens when its Skill is interactive.
 *
 * The step opens a thread for the assignee and parks. Each chat turn is its own agent run. A
 * finished turn only updates the draft on the step row; the Playbook resumes when the assignee
 * approves a proposal that passes both checks.
 */
const selectRows = jest.fn();
const updateSet = jest.fn();
const updateReturning = jest.fn();

jest.mock('../db/drizzle', () => {
  const selectChain = () => {
    const chain: Record<string, unknown> = {};
    for (const name of ['from', 'innerJoin', 'where']) chain[name] = () => chain;
    chain.limit = () => selectRows();
    // `where` is awaited directly by a query that has no limit.
    chain.then = (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(selectRows()).then(resolve, reject);
    return chain;
  };
  return {
    db: {
      select: () => selectChain(),
      update: () => ({
        set: (values: unknown) => {
          updateSet(values);
          return {
            where: () => {
              const result = Promise.resolve([]) as Promise<unknown[]> & { returning?: () => Promise<unknown> };
              result.returning = () => Promise.resolve(updateReturning());
              return result;
            },
          };
        },
      }),
    },
  };
});

const enqueue = jest.fn();
jest.mock('../services/agentRunLifecycleService', () => ({ enqueue: (...a: unknown[]) => enqueue(...a) }));

const routeBackgroundWorkflow = jest.fn();
jest.mock('../services/backgroundWorkflowRouter', () => ({
  routeBackgroundWorkflow: (...a: unknown[]) => routeBackgroundWorkflow(...a),
}));

const insertMessage = jest.fn();
jest.mock('../services/chatThreadRepository', () => ({
  insertMessage: (...a: unknown[]) => insertMessage(...a),
}));

const readV2ScorecardFiles = jest.fn();
jest.mock('../services/playbookSteps/v2StepArtifacts', () => ({
  readV2ScorecardFiles: (...a: unknown[]) => readV2ScorecardFiles(...a),
}));

jest.mock('../services/appSettingsService', () => ({ getDefaultModel: jest.fn().mockResolvedValue('default-model') }));

const prepareBackgroundWorkflowTurn = jest.fn();
const createThread = jest.fn();
const getThread = jest.fn();
const cancelRun = jest.fn();
const closeThread = jest.fn();
jest.mock('../services/chatAgentService', () => ({
  createThread: (...a: unknown[]) => createThread(...a),
  getThread: (...a: unknown[]) => getThread(...a),
  cancelRun: (...a: unknown[]) => cancelRun(...a),
  closeThread: (...a: unknown[]) => closeThread(...a),
  prepareBackgroundWorkflowTurn: (...a: unknown[]) => prepareBackgroundWorkflowTurn(...a),
}));

const isFeatureEnabled = jest.fn();
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: (...a: unknown[]) => isFeatureEnabled(...a),
}));

const createNotification = jest.fn();
jest.mock('../services/notificationService', () => ({
  createNotification: (...a: unknown[]) => createNotification(...a),
}));

const SKILL_PATH = 'foundation-skills/foundation/review-with-me/SKILL.md';
const SKILL_TEXT =
  '---\nname: review-with-me\ndescription: Review.\nmetadata:\n  apex:\n    skill-type: interactive\n---\nBody';
jest.mock('../services/playbookExecutionCapabilityService', () => ({
  ...jest.requireActual('../services/playbookExecutionCapabilityService'),
  loadPlaybookSkillContent: async () => SKILL_TEXT,
  loadPlaybookSkillCompanions: async () => [],
}));

const apexUserIdForEmail = jest.fn();
jest.mock('../services/playbookAssigneeService', () => ({
  apexUserIdForEmail: (...a: unknown[]) => apexUserIdForEmail(...a),
}));

const getSkillConfig = jest.fn();
jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: (...a: unknown[]) => getSkillConfig(...a),
}));

const getUserPermissions = jest.fn();
jest.mock('../services/rbacService', () => ({
  getUserPermissions: (...a: unknown[]) => getUserPermissions(...a),
}));

const isSuperAdminUserId = jest.fn();
jest.mock('../utils/superAdminUser', () => ({
  isSuperAdminUserId: (...a: unknown[]) => isSuperAdminUserId(...a),
}));

const suspendStepRun = jest.fn();
const failStepRun = jest.fn();
const resumeStepRun = jest.fn();
jest.mock('../services/playbookSteps/stepRuns', () => ({
  ...jest.requireActual('../services/playbookSteps/stepRuns'),
  suspendStepRun: (...a: unknown[]) => suspendStepRun(...a),
  failStepRun: (...a: unknown[]) => failStepRun(...a),
  resumeStepRun: (...a: unknown[]) => resumeStepRun(...a),
}));

import {
  AgentTaskChatError,
  closeInteractiveThreads,
  decideInteractiveProposal,
  recordInteractiveTurnFinished,
  sendInteractiveTurn,
  stableMessageId,
  startAgentTaskChat,
  warnInteractiveExpiring,
} from '../services/playbookSteps/agentTaskChat';
import { PROPOSAL_MARKER, promptWithProposalInstruction } from '../services/playbookSteps/proposalMarker';
import type { InteractiveStepDraft } from '../services/playbookSteps/interactiveProposal';
import type { PlaybookStepExecutionContext } from '../services/playbookSteps/stepRuns';

const DAY = 24 * 60 * 60 * 1000;
const ASSIGNEE = 'assignee-1';
const PROJECT = 'Apex';

const blankDraft = (overrides: Partial<InteractiveStepDraft> = {}): InteractiveStepDraft => ({
  threadId: 'thread-1',
  assigneeUserId: ASSIGNEE,
  turnCount: 0,
  rejectedRevisions: 0,
  proposalText: null,
  proposalOutcome: null,
  proposalOk: false,
  proposalReason: null,
  kind: null,
  outcomes: [],
  lastTurnError: null,
  ...overrides,
});

function stepContext(): PlaybookStepExecutionContext {
  return {
    runId: 'run-1',
    stepRunId: 'step-run-1',
    stepId: 'review',
    stepType: 'cursor-agent',
    project: PROJECT,
    initiatorUserId: 'initiator-oid',
    config: {},
    graph: {
      nodes: [{ id: 'review', stepType: 'cursor-agent', title: 'Review the incident', config: {} }],
      edges: [],
    } as unknown as PlaybookStepExecutionContext['graph'],
  };
}

const skillConfig = { skillRepo: 'apex/ai-pilot', skillBranch: 'main', skillProvider: 'github', defaultModel: 'skill-default' };

beforeEach(() => {
  jest.clearAllMocks();
  selectRows.mockReset();
  updateReturning.mockReset();
  updateReturning.mockResolvedValue([{ id: 'step-run-1' }]);
  createThread.mockResolvedValue({ id: 'thread-1' });
  getThread.mockResolvedValue({ messages: [] });
  prepareBackgroundWorkflowTurn.mockResolvedValue({ prompt: 'prepared' });
  insertMessage.mockResolvedValue(undefined);
  readV2ScorecardFiles.mockResolvedValue(undefined);
  getSkillConfig.mockResolvedValue(skillConfig);
  getUserPermissions.mockResolvedValue(new Set(['playbooks:run']));
  isSuperAdminUserId.mockResolvedValue(false);
  isFeatureEnabled.mockResolvedValue(false);
  createNotification.mockResolvedValue(undefined);
  suspendStepRun.mockResolvedValue(undefined);
  failStepRun.mockResolvedValue(undefined);
  resumeStepRun.mockResolvedValue(true);
  enqueue.mockResolvedValue({ runId: 'turn-run-1' });
  apexUserIdForEmail.mockResolvedValue(null);
});

async function start(config: Record<string, unknown>, prompt = 'Review the incident') {
  return startAgentTaskChat({
    context: stepContext(),
    config: { prompt, skillPath: SKILL_PATH, ...config } as never,
    skillContent: SKILL_TEXT,
    skillConfig: skillConfig as never,
    prompt,
  });
}

describe('opening the chat', () => {
  it('opens a thread owned by the assignee, parks the step on it, and tells the assignee', async () => {
    const outcome = await start({ assigneeUserId: ASSIGNEE });

    expect(createThread.mock.calls[0][0]).toBe(ASSIGNEE);
    expect(createThread.mock.calls[0][1]).toMatchObject({
      project: PROJECT,
      repo: 'apex/ai-pilot',
      skillPath: SKILL_PATH,
      freeformContext: 'Review the incident',
      model: 'skill-default',
    });
    expect(createThread.mock.calls[0][2]).toEqual({ skipAutoKickoff: true });
    expect(suspendStepRun).toHaveBeenCalledWith(
      expect.objectContaining({ stepRunId: 'step-run-1', resumeToken: 'thread-1' }),
    );
    // The step parks on the thread. The first turn is its own run, started right after.
    expect(suspendStepRun.mock.calls[0][0].agentRunId).toBeUndefined();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('suspended');
    expect(createNotification).toHaveBeenCalledWith(
      ASSIGNEE,
      expect.objectContaining({ title: 'Chat needed: Review the incident', link: '/playbooks/runs/run-1' }),
      { dedupeKey: 'playbook-interactive-open:step-run-1' },
    );
  });

  it('starts the agent on the step prompt without waiting for a message', async () => {
    await start({ assigneeUserId: ASSIGNEE }, 'Create release notes following the skill and ask me through it.');

    expect(enqueue).toHaveBeenCalledTimes(1);
    const input = enqueue.mock.calls[0][0];
    expect(input).toMatchObject({ threadId: 'thread-1', projectId: PROJECT, lane: 'background' });
    expect(input.snapshot).toMatchObject({
      prompt: promptWithProposalInstruction('Create release notes following the skill and ask me through it.'),
      workflowClass: 'playbook-step',
      skillPath: SKILL_PATH,
      threadId: 'thread-1',
    });
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ agentRunId: 'turn-run-1' }));
  });

  it('keeps the work item section the caller added in the opening message', async () => {
    await start({ assigneeUserId: ASSIGNEE }, 'Write the notes.\n\n## Azure DevOps work item\n\nEpic 42');

    expect(enqueue.mock.calls[0][0].snapshot.prompt).toBe(
      promptWithProposalInstruction('Write the notes.\n\n## Azure DevOps work item\n\nEpic 42'),
    );
  });

  it('asks for an OUTCOME line on the first turn when the step declares outcomes', async () => {
    await start({ assigneeUserId: ASSIGNEE, outcomes: ['approved', 'rework'] }, 'Write the notes.');

    expect(enqueue.mock.calls[0][0].snapshot.prompt).toBe(
      `${promptWithProposalInstruction('Write the notes.')}\n\nWhen you finish, end your reply with one line in exactly this form, choosing the result that fits best:\nOUTCOME: <one of: approved | rework>`,
    );
  });

  it('tells the agent that only a reply ending with the marker line is a proposal', async () => {
    await start({ assigneeUserId: ASSIGNEE });

    const prompt = enqueue.mock.calls[0][0].snapshot.prompt as string;
    expect(prompt).toContain('ask your question and stop');
    expect(prompt.trimEnd().endsWith(PROPOSAL_MARKER)).toBe(true);
  });

  it('starts the first turn on the V2 worker when the transport flag is on', async () => {
    isFeatureEnabled.mockResolvedValue(true);
    routeBackgroundWorkflow.mockResolvedValue({ route: 'worker', runId: 'v2-run-1' });

    await start({ assigneeUserId: ASSIGNEE });

    expect(enqueue).not.toHaveBeenCalled();
    expect(routeBackgroundWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ workflowClass: 'playbook-step', threadId: 'thread-1' }),
    );
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ agentRunId: 'v2-run-1' }));
  });

  it('keeps the step open and says why when the first turn cannot start', async () => {
    enqueue.mockRejectedValue(new Error('Admission is full.'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(start({ assigneeUserId: ASSIGNEE })).resolves.toMatchObject({ kind: 'suspended' });

    expect(failStepRun).not.toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        outputInline: expect.objectContaining({
          threadId: 'thread-1',
          lastTurnError: "The agent could not start from the step's prompt: Admission is full. Send a message to try again.",
        }),
      }),
    );
    warn.mockRestore();
  });

  it('writes an empty draft with the outcomes the step declares', async () => {
    await start({ assigneeUserId: ASSIGNEE, outcomes: ['approved', 'needs work'] });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        outputInline: expect.objectContaining({
          threadId: 'thread-1',
          assigneeUserId: ASSIGNEE,
          turnCount: 0,
          rejectedRevisions: 0,
          proposalText: null,
          proposalOk: false,
          outcomes: ['approved', 'needs work'],
        }),
      }),
    );
  });

  it('waits 7 days unless the step names a deadline, and honors one up to 14 days', async () => {
    const before = Date.now();
    const week = await start({ assigneeUserId: ASSIGNEE });
    const weekMs = Date.parse((week as { expiresAt: string }).expiresAt) - before;
    expect(weekMs).toBeGreaterThanOrEqual(7 * DAY - 1000);
    expect(weekMs).toBeLessThanOrEqual(7 * DAY + 5000);

    const fortnight = await start({ assigneeUserId: ASSIGNEE, deadlineMs: 14 * DAY });
    const fortnightMs = Date.parse((fortnight as { expiresAt: string }).expiresAt) - Date.now();
    expect(fortnightMs).toBeGreaterThan(13 * DAY);
  });

  it('refuses a chat deadline under an hour', async () => {
    await expect(start({ assigneeUserId: ASSIGNEE, deadlineMs: 30 * 60 * 1000 })).rejects.toThrow(
      /1 hour through 14 days/,
    );
    expect(createThread).not.toHaveBeenCalled();
    expect(suspendStepRun).not.toHaveBeenCalled();
  });

  it('prefers the step model, then the project default, then the app default', async () => {
    await start({ assigneeUserId: ASSIGNEE, model: 'step-model' });
    expect(createThread.mock.calls[0][1].model).toBe('step-model');

    await start({ assigneeUserId: ASSIGNEE });
    expect(createThread.mock.calls[1][1].model).toBe('skill-default');

    getSkillConfig.mockResolvedValue({ ...skillConfig, defaultModel: '' });
    await startAgentTaskChat({
      context: stepContext(),
      config: { prompt: 'p', skillPath: SKILL_PATH, assigneeUserId: ASSIGNEE },
      skillContent: SKILL_TEXT,
      skillConfig: { ...skillConfig, defaultModel: '' } as never,
      prompt: 'p',
    });
    expect(createThread.mock.calls[2][1].model).toBe('default-model');
  });

  it('finds an email assignee by their Apex account', async () => {
    apexUserIdForEmail.mockResolvedValue('resolved-user');

    await start({ assigneeEmail: 'ba@example.com' });

    expect(apexUserIdForEmail).toHaveBeenCalledWith('ba@example.com');
    expect(createThread.mock.calls[0][0]).toBe('resolved-user');
  });

  it('says so when the email assignee has never signed in, and creates nothing', async () => {
    await expect(start({ assigneeEmail: 'new@example.com' })).rejects.toThrow(
      /new@example\.com has not signed in to Apex yet/,
    );
    expect(createThread).not.toHaveBeenCalled();
    expect(suspendStepRun).not.toHaveBeenCalled();
  });

  it('says so when no assignee is set', async () => {
    await expect(start({})).rejects.toThrow(/needs an assignee/);
    expect(createThread).not.toHaveBeenCalled();
  });

  it('refuses an assignee who cannot run Playbooks in the project', async () => {
    getUserPermissions.mockResolvedValue(new Set(['playbooks:view']));

    await expect(start({ assigneeUserId: ASSIGNEE })).rejects.toThrow(/cannot run Playbooks in Apex/);
    expect(createThread).not.toHaveBeenCalled();
  });

  it('lets a super admin assignee through without the permission', async () => {
    getUserPermissions.mockResolvedValue(new Set());
    isSuperAdminUserId.mockResolvedValue(true);

    await expect(start({ assigneeUserId: ASSIGNEE })).resolves.toMatchObject({ kind: 'suspended' });
  });

  it('still opens the chat when the notification cannot be sent', async () => {
    createNotification.mockRejectedValue(new Error('smtp down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(start({ assigneeUserId: ASSIGNEE })).resolves.toMatchObject({ kind: 'suspended' });

    warn.mockRestore();
  });

  it('records the kind the Skill declares so approval can check it', async () => {
    const kindSkill = '---\nname: s\ndescription: d\nmetadata:\n  apex:\n    skill-type: interactive\n    output-kind: scorecard@1\n---\n';
    await startAgentTaskChat({
      context: stepContext(),
      config: { prompt: 'p', skillPath: SKILL_PATH, assigneeUserId: ASSIGNEE },
      skillContent: kindSkill,
      skillConfig: skillConfig as never,
      prompt: 'p',
    });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ outputInline: expect.objectContaining({ kind: 'scorecard@1' }) }),
    );
  });
});

function openRow(draft: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: 'step-run-1',
    runId: 'run-1',
    stepId: 'review',
    stepType: 'cursor-agent',
    status: 'suspended',
    agentRunId: null,
    resumeToken: 'thread-1',
    outputInline: draft,
    inputInline: { prompt: 'Review the incident', skillPath: SKILL_PATH, assigneeUserId: ASSIGNEE },
    project: PROJECT,
    ...overrides,
  };
}

describe('stableMessageId', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('makes a UUID, the form the chat message id column requires', () => {
    expect(stableMessageId('run-1:reply')).toMatch(UUID);
  });

  it('gives the same id for the same seed, and different ids for different seeds', () => {
    expect(stableMessageId('run-1:reply')).toBe(stableMessageId('run-1:reply'));
    expect(stableMessageId('run-1:reply')).not.toBe(stableMessageId('run-1:prompt'));
  });
});

describe('a chat turn', () => {
  it('runs on the chat thread as its own agent run and records the run id on the step', async () => {
    selectRows.mockResolvedValue([openRow(blankDraft())]);

    await sendInteractiveTurn({ runId: 'run-1', stepRunId: 'step-run-1', userId: ASSIGNEE, message: ' Check the logs ' });

    expect(enqueue).toHaveBeenCalledTimes(1);
    const input = enqueue.mock.calls[0][0];
    expect(input).toMatchObject({ threadId: 'thread-1', projectId: PROJECT, lane: 'background' });
    expect(input.snapshot).toMatchObject({
      prompt: promptWithProposalInstruction('Check the logs'),
      workflowClass: 'playbook-step',
      skillPath: SKILL_PATH,
      threadId: 'thread-1',
    });
    expect(input.snapshot.playbookAgentPolicy).toBeTruthy();
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ agentRunId: 'turn-run-1' }));
  });

  it('asks for an OUTCOME line on each turn when the step declares outcomes', async () => {
    selectRows.mockResolvedValue([
      openRow(blankDraft({ outcomes: ['approved'] }), {
        inputInline: { prompt: 'p', skillPath: SKILL_PATH, assigneeUserId: ASSIGNEE, outcomes: ['approved', 'rework'] },
      }),
    ]);

    await sendInteractiveTurn({ runId: 'run-1', stepRunId: 'step-run-1', userId: ASSIGNEE, message: 'go' });

    expect(enqueue.mock.calls[0][0].snapshot.prompt).toContain('OUTCOME: <one of: approved | rework>');
  });

  it('goes through the V2 worker when the transport flag is on', async () => {
    isFeatureEnabled.mockResolvedValue(true);
    routeBackgroundWorkflow.mockResolvedValue({ route: 'worker', runId: 'v2-run-1' });
    selectRows.mockResolvedValue([openRow(blankDraft())]);

    await sendInteractiveTurn({ runId: 'run-1', stepRunId: 'step-run-1', userId: ASSIGNEE, message: 'go' });

    expect(enqueue).not.toHaveBeenCalled();
    expect(routeBackgroundWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ workflowClass: 'playbook-step', threadId: 'thread-1' }),
    );
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ agentRunId: 'v2-run-1' }));
  });

  it('records the assignee message in the thread on a V2 turn, because the worker does not', async () => {
    isFeatureEnabled.mockResolvedValue(true);
    routeBackgroundWorkflow.mockResolvedValue({ route: 'worker', runId: 'v2-run-1' });
    selectRows.mockResolvedValue([openRow(blankDraft())]);

    await sendInteractiveTurn({ runId: 'run-1', stepRunId: 'step-run-1', userId: ASSIGNEE, message: 'go' });

    expect(insertMessage).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({ id: stableMessageId('v2-run-1:prompt'), role: 'user', text: 'go' }),
    );
  });

  it('tells a V2 turn what was said before, since each turn is a new agent', async () => {
    isFeatureEnabled.mockResolvedValue(true);
    routeBackgroundWorkflow.mockImplementation(async (input: { prepareWorker: () => Promise<unknown> }) => {
      await input.prepareWorker();
      return { route: 'worker', runId: 'v2-run-2' };
    });
    getThread.mockResolvedValue({
      messages: [
        { id: 'p1', role: 'user', text: 'Draft the notes.', ts: '2026-11-27T10:00:00.000Z' },
        { id: 'r1', role: 'agent', text: 'Which release?', ts: '2026-11-27T10:01:00.000Z' },
      ],
    });
    selectRows.mockResolvedValue([openRow(blankDraft({ turnCount: 1 }))]);

    await sendInteractiveTurn({ runId: 'run-1', stepRunId: 'step-run-1', userId: ASSIGNEE, message: 'The 1.12 release.' });

    const prompt = prepareBackgroundWorkflowTurn.mock.calls[0][1] as string;
    expect(prompt).toContain('**Assignee:** Draft the notes.');
    expect(prompt).toContain('**Agent:** Which release?');
    expect(prompt).toContain('## New message from the assignee\n\nThe 1.12 release.');
    expect(prompt.trimEnd().endsWith(PROPOSAL_MARKER)).toBe(true);
  });

  it('does not write the assignee message itself on the in-process path', async () => {
    selectRows.mockResolvedValue([openRow(blankDraft())]);

    await sendInteractiveTurn({ runId: 'run-1', stepRunId: 'step-run-1', userId: ASSIGNEE, message: 'go' });

    expect(insertMessage).not.toHaveBeenCalled();
  });

  it('refuses the turn when the V2 worker did not take it', async () => {
    isFeatureEnabled.mockResolvedValue(true);
    routeBackgroundWorkflow.mockResolvedValue({ route: 'in-process' });
    selectRows.mockResolvedValue([openRow(blankDraft())]);

    await expect(
      sendInteractiveTurn({ runId: 'run-1', stepRunId: 'step-run-1', userId: ASSIGNEE, message: 'go' }),
    ).rejects.toThrow(/could not start this turn/);
  });

  it('refuses an empty message', async () => {
    await expect(
      sendInteractiveTurn({ runId: 'run-1', stepRunId: 'step-run-1', userId: ASSIGNEE, message: '   ' }),
    ).rejects.toThrow(AgentTaskChatError);
    expect(selectRows).not.toHaveBeenCalled();
  });

  it('refuses anyone but the assignee', async () => {
    selectRows.mockResolvedValue([openRow(blankDraft())]);

    await expect(
      sendInteractiveTurn({ runId: 'run-1', stepRunId: 'step-run-1', userId: 'someone-else', message: 'hi' }),
    ).rejects.toThrow(/Only the assignee/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('refuses a message while a turn is still running', async () => {
    selectRows.mockResolvedValue([openRow(blankDraft(), { agentRunId: 'turn-run-0' })]);

    await expect(
      sendInteractiveTurn({ runId: 'run-1', stepRunId: 'step-run-1', userId: ASSIGNEE, message: 'hi' }),
    ).rejects.toThrow(/already running/);
  });

  it('refuses a message after a revision was rejected: approve or cancel only', async () => {
    selectRows.mockResolvedValue([openRow(blankDraft({ rejectedRevisions: 1 }))]);

    await expect(
      sendInteractiveTurn({ runId: 'run-1', stepRunId: 'step-run-1', userId: ASSIGNEE, message: 'hi' }),
    ).rejects.toThrow(/Approve the proposal or cancel the run/);
  });

  it('refuses a message on a step that is not waiting', async () => {
    selectRows.mockResolvedValue([openRow(blankDraft(), { status: 'completed' })]);

    await expect(
      sendInteractiveTurn({ runId: 'run-1', stepRunId: 'step-run-1', userId: ASSIGNEE, message: 'hi' }),
    ).rejects.toThrow(/not waiting for a chat turn/);
  });

  it('refuses a message on an Agent task that runs on its own', async () => {
    selectRows.mockResolvedValue([openRow(null)]);

    await expect(
      sendInteractiveTurn({ runId: 'run-1', stepRunId: 'step-run-1', userId: ASSIGNEE, message: 'hi' }),
    ).rejects.toThrow(/no chat to continue/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('refuses a message on another step type', async () => {
    selectRows.mockResolvedValue([openRow(blankDraft(), { stepType: 'interview' })]);

    await expect(
      sendInteractiveTurn({ runId: 'run-1', stepRunId: 'step-run-1', userId: ASSIGNEE, message: 'hi' }),
    ).rejects.toThrow(/not waiting for a chat turn/);
  });

  it('fails the step and the run when the assignee lost the permission', async () => {
    getUserPermissions.mockResolvedValue(new Set());
    selectRows.mockResolvedValue([openRow(blankDraft())]);

    await expect(
      sendInteractiveTurn({ runId: 'run-1', stepRunId: 'step-run-1', userId: ASSIGNEE, message: 'hi' }),
    ).rejects.toThrow(/can no longer run Playbooks/);
    expect(failStepRun).toHaveBeenCalledWith(expect.objectContaining({ stepRunId: 'step-run-1' }));
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('reports a lost race when another turn claimed the step first', async () => {
    selectRows.mockResolvedValue([openRow(blankDraft())]);
    updateReturning.mockResolvedValue([]);

    await expect(
      sendInteractiveTurn({ runId: 'run-1', stepRunId: 'step-run-1', userId: ASSIGNEE, message: 'hi' }),
    ).rejects.toThrow(/already running/);
  });
});

describe('a finished turn', () => {
  const agentReply = (text: string) => ({
    messages: [
      { role: 'user', text: 'question', hidden: false },
      { role: 'agent', text, hidden: false },
    ],
  });

  it('keeps the reply as the proposal and frees the step for the next message', async () => {
    selectRows.mockResolvedValue([{ outputInline: blankDraft(), resumeToken: 'thread-1' }]);
    getThread.mockResolvedValue(agentReply('The cause is a stale cache.\nREADY FOR APPROVAL'));

    const recorded = await recordInteractiveTurnFinished({
      stepRunId: 'step-run-1',
      agentRunId: 'turn-run-1',
      threadId: 'thread-1',
    });

    expect(recorded).toBe(true);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRunId: null,
        outputInline: expect.objectContaining({
          turnCount: 1,
          proposalText: 'The cause is a stale cache.',
          proposalOk: true,
          lastTurnError: null,
        }),
      }),
    );
    expect(resumeStepRun).not.toHaveBeenCalled();
  });

  it('takes the reply of a V2 turn from its artifact and copies it into the thread', async () => {
    selectRows.mockResolvedValue([{ outputInline: blankDraft(), resumeToken: 'thread-1' }]);
    readV2ScorecardFiles.mockResolvedValue({ reply: 'The cause is a stale cache.\nREADY FOR APPROVAL' });

    await recordInteractiveTurnFinished({ stepRunId: 'step-run-1', agentRunId: 'v2-run-1', threadId: 'thread-1' });

    expect(readV2ScorecardFiles).toHaveBeenCalledWith('v2-run-1');
    expect(getThread).not.toHaveBeenCalled();
    expect(insertMessage).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({
        id: stableMessageId('v2-run-1:reply'),
        role: 'agent',
        text: 'The cause is a stale cache.\nREADY FOR APPROVAL',
      }),
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        outputInline: expect.objectContaining({
          turnCount: 1,
          proposalText: 'The cause is a stale cache.',
          proposalOk: true,
        }),
      }),
    );
  });

  it('falls back to the thread when the artifact cannot be read', async () => {
    selectRows.mockResolvedValue([{ outputInline: blankDraft(), resumeToken: 'thread-1' }]);
    readV2ScorecardFiles.mockRejectedValue(new Error('blob unavailable'));
    getThread.mockResolvedValue(agentReply('From the thread.\n**READY FOR APPROVAL**'));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await recordInteractiveTurnFinished({ stepRunId: 'step-run-1', agentRunId: 'v2-run-1' });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        outputInline: expect.objectContaining({ proposalText: 'From the thread.', proposalOk: true }),
      }),
    );
  });

  it('treats a reply without the marker as the agent asking, with nothing to approve', async () => {
    selectRows.mockResolvedValue([
      { outputInline: blankDraft({ turnCount: 1, proposalText: 'old', proposalOk: true }), resumeToken: 'thread-1' },
    ]);
    getThread.mockResolvedValue(agentReply('a) the 1.12 release, or b) the 1.13 release?'));

    await recordInteractiveTurnFinished({ stepRunId: 'step-run-1', agentRunId: 'turn-run-1' });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRunId: null,
        outputInline: expect.objectContaining({
          turnCount: 2,
          proposalText: null,
          proposalOk: false,
          proposalReason: null,
          lastTurnError: null,
        }),
      }),
    );
  });

  it('does not count the marker words in the middle of a reply', async () => {
    selectRows.mockResolvedValue([{ outputInline: blankDraft(), resumeToken: 'thread-1' }]);
    getThread.mockResolvedValue(agentReply('Say READY FOR APPROVAL when you want a result.\nWhich release?'));

    await recordInteractiveTurnFinished({ stepRunId: 'step-run-1', agentRunId: 'turn-run-1' });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ outputInline: expect.objectContaining({ proposalText: null, proposalOk: false }) }),
    );
  });

  it('records an error, not an empty proposal, when the turn left no reply', async () => {
    selectRows.mockResolvedValue([{ outputInline: blankDraft(), resumeToken: 'thread-1' }]);

    await recordInteractiveTurnFinished({ stepRunId: 'step-run-1', agentRunId: 'v2-run-1' });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRunId: null,
        outputInline: expect.objectContaining({
          turnCount: 0,
          proposalText: null,
          lastTurnError: expect.stringContaining('without sending a reply'),
        }),
      }),
    );
  });

  it('reads the outcome the agent picked and marks a proposal that is not on the list', async () => {
    selectRows.mockResolvedValue([{ outputInline: blankDraft({ outcomes: ['approved', 'rework'] }), resumeToken: 'thread-1' }]);
    getThread.mockResolvedValue(agentReply('Looks fine.\nREADY FOR APPROVAL\nOUTCOME: Maybe'));

    await recordInteractiveTurnFinished({ stepRunId: 'step-run-1', agentRunId: 'turn-run-1' });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        outputInline: expect.objectContaining({
          proposalText: 'Looks fine.',
          proposalOutcome: 'maybe',
          proposalOk: false,
          proposalReason: expect.stringContaining('approved, rework'),
        }),
      }),
    );
  });

  it('accepts a proposal that picks a declared outcome', async () => {
    selectRows.mockResolvedValue([{ outputInline: blankDraft({ outcomes: ['approved', 'rework'] }), resumeToken: 'thread-1' }]);
    getThread.mockResolvedValue(agentReply('Ship it.\nREADY FOR APPROVAL\nOUTCOME: approved'));

    await recordInteractiveTurnFinished({ stepRunId: 'step-run-1', agentRunId: 'turn-run-1' });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        outputInline: expect.objectContaining({ proposalOutcome: 'approved', proposalOk: true }),
      }),
    );
  });

  it('records a failed turn without counting it or replacing the proposal', async () => {
    selectRows.mockResolvedValue([
      { outputInline: blankDraft({ turnCount: 2, proposalText: 'earlier answer', proposalOk: true }), resumeToken: 'thread-1' },
    ]);

    await recordInteractiveTurnFinished({
      stepRunId: 'step-run-1',
      agentRunId: 'turn-run-1',
      failedReason: 'Agent run turn-run-1 ended as failed.',
    });

    expect(getThread).not.toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRunId: null,
        outputInline: expect.objectContaining({
          turnCount: 2,
          proposalText: 'earlier answer',
          lastTurnError: 'Agent run turn-run-1 ended as failed.',
        }),
      }),
    );
  });

  it('does nothing for a step that is not a chat', async () => {
    selectRows.mockResolvedValue([{ outputInline: null, resumeToken: null }]);

    await expect(
      recordInteractiveTurnFinished({ stepRunId: 'step-run-1', agentRunId: 'run-9' }),
    ).resolves.toBe(false);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('does nothing when the step already moved or the run id does not match', async () => {
    selectRows.mockResolvedValue([]);

    await expect(
      recordInteractiveTurnFinished({ stepRunId: 'step-run-1', agentRunId: 'run-9' }),
    ).resolves.toBe(false);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('reports false when another writer got there first', async () => {
    selectRows.mockResolvedValue([{ outputInline: blankDraft(), resumeToken: 'thread-1' }]);
    getThread.mockResolvedValue(agentReply('answer'));
    updateReturning.mockResolvedValue([]);

    await expect(
      recordInteractiveTurnFinished({ stepRunId: 'step-run-1', agentRunId: 'turn-run-1' }),
    ).resolves.toBe(false);
  });
});

describe('the assignee decides', () => {
  const decide = (decision: 'approved' | 'rejected', userId = ASSIGNEE) =>
    decideInteractiveProposal({ runId: 'run-1', stepRunId: 'step-run-1', userId, decision });

  it('resumes the step with the approved text, who approved, and the outcome', async () => {
    selectRows.mockResolvedValue([
      openRow(blankDraft({ proposalText: 'Root cause: stale cache.', proposalOutcome: 'approved', outcomes: ['approved', 'rework'], proposalOk: true })),
    ]);

    await expect(decide('approved')).resolves.toEqual({ outcome: 'recorded', stepId: 'review' });

    expect(resumeStepRun).toHaveBeenCalledWith({
      stepRunId: 'step-run-1',
      output: expect.objectContaining({
        threadId: 'thread-1',
        approvedBy: ASSIGNEE,
        output: 'Root cause: stale cache.',
        outcome: 'approved',
      }),
    });
  });

  it('resumes a step with no outcomes and no outcome in the output', async () => {
    selectRows.mockResolvedValue([openRow(blankDraft({ proposalText: 'A plain answer.' }))]);

    await decide('approved');

    const output = resumeStepRun.mock.calls[0][0].output;
    expect(output.output).toBe('A plain answer.');
    expect(output.outcome).toBeUndefined();
    // No single agent run produced it, and the output schema allows that.
    expect(output.agentRunId).toBeUndefined();
  });

  it('refuses to approve an empty proposal and leaves the step parked', async () => {
    selectRows.mockResolvedValue([openRow(blankDraft())]);

    await expect(decide('approved')).rejects.toThrow(/proposal is empty/);
    expect(resumeStepRun).not.toHaveBeenCalled();
  });

  it('refuses to approve a proposal that does not pick a declared outcome', async () => {
    selectRows.mockResolvedValue([openRow(blankDraft({ proposalText: 'Text', outcomes: ['approved', 'rework'] }))]);

    await expect(decide('approved')).rejects.toThrow(/must pick one of: approved, rework/);
    expect(resumeStepRun).not.toHaveBeenCalled();
  });

  it('refuses to approve a scorecard without its final json block', async () => {
    selectRows.mockResolvedValue([openRow(blankDraft({ proposalText: 'No json here.', kind: 'scorecard@1' }))]);

    await expect(decide('approved')).rejects.toThrow(/needs a final json block/);
  });

  it('approves a scorecard whose final json block parses', async () => {
    selectRows.mockResolvedValue([
      openRow(blankDraft({ proposalText: 'Score:\n```json\n{"ok":true}\n```', kind: 'scorecard@1' })),
    ]);

    await expect(decide('approved')).resolves.toMatchObject({ outcome: 'recorded' });
  });

  it('counts a rejection and keeps the step parked', async () => {
    selectRows.mockResolvedValue([openRow(blankDraft({ proposalText: 'Draft one' }))]);

    await expect(decide('rejected')).resolves.toEqual({ outcome: 'recorded', stepId: 'review' });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ outputInline: expect.objectContaining({ rejectedRevisions: 1 }) }),
    );
    expect(resumeStepRun).not.toHaveBeenCalled();
  });

  it('still lets the assignee approve after the chat closed', async () => {
    selectRows.mockResolvedValue([openRow(blankDraft({ rejectedRevisions: 1, proposalText: 'Second draft' }))]);

    await expect(decide('approved')).resolves.toMatchObject({ outcome: 'recorded' });
  });

  it('refuses anyone but the assignee', async () => {
    selectRows.mockResolvedValue([openRow(blankDraft({ proposalText: 'Text' }))]);

    await expect(decide('approved', 'someone-else')).rejects.toThrow(/Only the assignee/);
    expect(resumeStepRun).not.toHaveBeenCalled();
  });

  it('fails the step when the assignee lost the permission', async () => {
    getUserPermissions.mockResolvedValue(new Set());
    selectRows.mockResolvedValue([openRow(blankDraft({ proposalText: 'Text' }))]);

    await expect(decide('approved')).rejects.toThrow(/can no longer run Playbooks/);
    expect(failStepRun).toHaveBeenCalledTimes(1);
    expect(resumeStepRun).not.toHaveBeenCalled();
  });

  it('reports already-decided for a step that is no longer waiting, and when the resume lost a race', async () => {
    selectRows.mockResolvedValue([openRow(blankDraft({ proposalText: 'Text' }), { status: 'completed' })]);
    await expect(decide('approved')).resolves.toEqual({ outcome: 'already-decided' });

    selectRows.mockResolvedValue([openRow(blankDraft({ proposalText: 'Text' }))]);
    resumeStepRun.mockResolvedValue(false);
    await expect(decide('approved')).resolves.toEqual({ outcome: 'already-decided' });
  });

  it('refuses a decision on an Agent task that runs on its own', async () => {
    selectRows.mockResolvedValue([openRow(null)]);

    await expect(decide('approved')).rejects.toThrow(/no chat to continue/);
  });

  it('refuses a decision on a step of another type, or none', async () => {
    selectRows.mockResolvedValue([openRow(blankDraft(), { stepType: 'approval-gate' })]);
    await expect(decide('approved')).rejects.toThrow(/not an interactive Agent task/);

    selectRows.mockResolvedValue([]);
    await expect(decide('approved')).rejects.toThrow(/not an interactive Agent task/);
  });
});

describe('cancelling a run closes only the chat threads', () => {
  it('cancels the turn and closes the thread of a chat', async () => {
    cancelRun.mockResolvedValue(undefined);
    closeThread.mockResolvedValue(undefined);

    await closeInteractiveThreads([
      { stepType: 'cursor-agent', resumeToken: 'thread-1', outputInline: blankDraft() },
    ]);

    expect(cancelRun).toHaveBeenCalledWith('thread-1');
    expect(closeThread).toHaveBeenCalledWith('thread-1');
  });

  it('leaves an Agent task that runs on its own, and other step types, alone', async () => {
    await closeInteractiveThreads([
      { stepType: 'cursor-agent', resumeToken: 'thread-2', outputInline: null },
      { stepType: 'cursor-agent', resumeToken: 'thread-3' },
      { stepType: 'interview', resumeToken: 'thread-4', outputInline: blankDraft() },
      { stepType: 'cursor-agent', resumeToken: null, outputInline: blankDraft() },
    ]);

    expect(cancelRun).not.toHaveBeenCalled();
    expect(closeThread).not.toHaveBeenCalled();
  });

  it('keeps closing the rest when one thread fails to close', async () => {
    cancelRun.mockRejectedValueOnce(new Error('gone'));
    closeThread.mockRejectedValueOnce(new Error('gone'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await closeInteractiveThreads([
      { stepType: 'cursor-agent', resumeToken: 'a', outputInline: blankDraft({ threadId: 'a' }) },
      { stepType: 'cursor-agent', resumeToken: 'b', outputInline: blankDraft({ threadId: 'b' }) },
    ]);

    expect(closeThread).toHaveBeenCalledWith('b');
    warn.mockRestore();
  });
});

describe('the expiry warning', () => {
  const now = new Date('2026-11-23T12:00:00.000Z');

  it('warns the assignee of a chat that expires within a day', async () => {
    selectRows
      .mockResolvedValueOnce([{ id: 'step-run-1', runId: 'run-1', outputInline: blankDraft() }])
      .mockResolvedValueOnce([{ expiresAt: new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString() }]);

    await warnInteractiveExpiring(now);

    expect(createNotification).toHaveBeenCalledWith(
      ASSIGNEE,
      expect.objectContaining({ link: '/playbooks/runs/run-1' }),
      { dedupeKey: 'playbook-interactive-expiry:step-run-1' },
    );
  });

  it('stays quiet when the deadline is more than a day away or already passed', async () => {
    selectRows
      .mockResolvedValueOnce([
        { id: 's1', runId: 'r1', outputInline: blankDraft() },
        { id: 's2', runId: 'r2', outputInline: blankDraft() },
      ])
      .mockResolvedValueOnce([{ expiresAt: new Date(now.getTime() + 3 * DAY).toISOString() }])
      .mockResolvedValueOnce([{ expiresAt: new Date(now.getTime() - 1000).toISOString() }]);

    await warnInteractiveExpiring(now);

    expect(createNotification).not.toHaveBeenCalled();
  });

  it('skips an Agent task that runs on its own', async () => {
    selectRows.mockResolvedValueOnce([{ id: 's1', runId: 'r1', outputInline: null }]);

    await warnInteractiveExpiring(now);

    expect(createNotification).not.toHaveBeenCalled();
  });
});
