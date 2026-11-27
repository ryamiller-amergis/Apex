const getThread = jest.fn();
const getRun = jest.fn();

// Each query ends in .limit(); results come off a queue in call order.
const queryResults: unknown[][] = [];
jest.mock('../db/drizzle', () => {
  const chain: Record<string, unknown> = {};
  for (const name of ['select', 'from', 'where', 'orderBy']) chain[name] = () => chain;
  chain.limit = () => Promise.resolve(queryResults.shift() ?? []);
  return { db: chain };
});
jest.mock('../services/chatAgentService', () => ({
  getThread: (...args: unknown[]) => getThread(...args),
}));
jest.mock('../services/playbookRunProjectionService', () => ({
  getRun: (...args: unknown[]) => getRun(...args),
}));

import type { ChatMessage } from '../../shared/types/chat';
import { getPlaybookStepActivity, threadConversation } from '../services/playbookStepActivityService';
import { promptWithHistory } from '../services/playbookSteps/agentTaskConversation';
import { promptWithOutcomes, stripOutcomeInstructions } from '../services/playbookSteps/agentOutcome';

function message(overrides: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role' | 'text'>): ChatMessage {
  return { ts: `2026-11-24T19:2${overrides.id.length % 10}:00.000Z`, ...overrides };
}

describe('stripOutcomeInstructions', () => {
  it('gives back the prompt as written', () => {
    const prompt = 'Write the notes for 1.12.';
    expect(stripOutcomeInstructions(promptWithOutcomes(prompt, ['done', 'blocked']))).toBe(prompt);
    expect(stripOutcomeInstructions(prompt)).toBe(prompt);
  });
});

describe('threadConversation', () => {
  it('keeps the assignee and agent text, without tools, reasoning, hidden prompts or outcome lines', () => {
    const conversation = threadConversation([
      message({ id: 'h', role: 'user', text: 'Begin.', hidden: true }),
      message({ id: 'u1', role: 'user', text: promptWithOutcomes('Draft the notes.', ['done']) }),
      message({ id: 't1', role: 'tool', text: '→ read', toolName: 'read' }),
      message({ id: 'r1', role: 'agent', text: 'Planning', toolName: '_reasoning' }),
      message({ id: 'a1', role: 'agent', text: 'Reading the merged PRs.' }),
      message({ id: 'a2', role: 'agent', text: 'Here is the draft.\nOUTCOME: done' }),
      message({ id: 'u2', role: 'user', text: 'Shorter, please.' }),
    ]);
    expect(conversation.map(({ id, role, text }) => ({ id, role, text }))).toEqual([
      { id: 'u1', role: 'user', text: 'Draft the notes.' },
      { id: 'a1', role: 'agent', text: 'Reading the merged PRs.\n\nHere is the draft.' },
      { id: 'u2', role: 'user', text: 'Shorter, please.' },
    ]);
  });
});

describe('getPlaybookStepActivity for an interactive Agent task', () => {
  const draft = { threadId: 'thread-1', assigneeUserId: 'user-1', turnCount: 1 };

  beforeEach(() => {
    getThread.mockReset();
    getRun.mockReset();
    queryResults.length = 0;
  });

  it('returns the chat and the thread log between turns', async () => {
    getRun.mockResolvedValue({
      steps: [{
        id: 'row-1',
        stepType: 'cursor-agent',
        status: 'suspended',
        agentRunId: null,
        outputInline: draft,
        updatedAt: '2026-11-24T19:30:00.000Z',
      }],
    });
    getThread.mockResolvedValue({
      messages: [
        message({ id: 'u1', role: 'user', text: 'Draft the notes.' }),
        message({ id: 't1', role: 'tool', text: '→ read', toolName: 'read', toolInput: { path: 'CHANGELOG.md' } }),
        message({ id: 'a1', role: 'agent', text: 'Here is the draft.' }),
      ],
    });

    const activity = await getPlaybookStepActivity({ project: 'Apex', runId: 'run-1', stepRunId: 'row-1' });

    expect(getThread).toHaveBeenCalledWith('thread-1');
    expect(activity?.conversation?.map((entry) => entry.role)).toEqual(['user', 'agent']);
    expect(activity?.entries.map((entry) => entry.kind)).toEqual(['prompt', 'tool', 'message']);
    expect(activity?.agentRun).toBeNull();
  });

  it('keeps the log of earlier turns after the latest one finishes', async () => {
    getRun.mockResolvedValue({
      steps: [{ id: 'row-1', stepType: 'cursor-agent', status: 'suspended', agentRunId: null, outputInline: draft }],
    });
    getThread.mockResolvedValue({ messages: [message({ id: 'u1', role: 'user', text: 'Draft the notes.' })] });
    // The turn runs newest first, then the events of each run in that order.
    queryResults.push(
      [{ id: 'run-2' }, { id: 'run-1' }],
      [{ eventId: 'e1', detail: null, event: { type: 'tool_call', toolName: 'read' }, at: '2026-11-24T19:25:00.000Z' }],
      [{ eventId: 'e2', detail: null, event: { type: 'tool_call', toolName: 'write' }, at: '2026-11-24T19:40:00.000Z' }],
    );

    const activity = await getPlaybookStepActivity({ project: 'Apex', runId: 'run-1', stepRunId: 'row-1' });

    expect(activity?.entries.filter((entry) => entry.kind === 'tool').map((entry) => entry.title)).toEqual(['read', 'write']);
  });

  it('leaves the chat off an autonomous Agent task', async () => {
    getRun.mockResolvedValue({
      steps: [{ id: 'row-1', stepType: 'cursor-agent', status: 'running', agentRunId: null, outputInline: null }],
    });
    const activity = await getPlaybookStepActivity({ project: 'Apex', runId: 'run-1', stepRunId: 'row-1' });
    expect(activity?.conversation).toBeUndefined();
    expect(getThread).not.toHaveBeenCalled();
  });
});

describe('promptWithHistory', () => {
  it('gives back the prompt when there is no earlier chat', () => {
    expect(promptWithHistory('Start.', [])).toBe('Start.');
  });

  it('puts the earlier chat in front of the new message', () => {
    const prompt = promptWithHistory('Make it shorter.', [
      message({ id: 'u1', role: 'user', text: promptWithOutcomes('Draft the notes.', ['done']) }),
      message({ id: 'a1', role: 'agent', text: 'Here is the draft.\nOUTCOME: done' }),
    ]);
    expect(prompt).toContain('**Assignee:** Draft the notes.');
    expect(prompt).toContain('**Agent:** Here is the draft.');
    expect(prompt).not.toContain('OUTCOME: done');
    expect(prompt.endsWith('Make it shorter.')).toBe(true);
  });
});
