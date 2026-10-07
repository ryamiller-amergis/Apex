/**
 * Lead + Requirements assisted interview turn.
 *
 * VT-ASSIST-1 ordinary and human-led threads prepare nothing.
 * VT-ASSIST-2 one Requirements pass, using the snapshotted profile and one hidden prompt.
 * VT-ASSIST-3 valid JSON is stored for the current brief version without chain-of-thought.
 * VT-ASSIST-4 timeout, agent error, and invalid JSON store one failed review and a safe context.
 */
import fs from 'fs';
import path from 'path';
import { interviewSpecialistReviews, interviews } from '../db/schema';

const mockEq = jest.fn((left: unknown, right: unknown) => ({ left, right }));
jest.mock('drizzle-orm', () => {
  const actual = jest.requireActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (left: unknown, right: unknown) => mockEq(left, right),
  };
});

const mockFindFirst = jest.fn();
const mockInsert = jest.fn();
jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      interviews: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
    insert: (...args: unknown[]) => mockInsert(...args),
  },
}));

const mockCreateThread = jest.fn();
const mockSendMessage = jest.fn();
const mockGetThread = jest.fn();
const mockHydrateThread = jest.fn();
const mockIsThreadIdle = jest.fn();
jest.mock('../services/chatAgentService', () => ({
  createThread: (...args: unknown[]) => mockCreateThread(...args),
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  getThread: (...args: unknown[]) => mockGetThread(...args),
  hydrateThread: (...args: unknown[]) => mockHydrateThread(...args),
  isThreadIdle: (...args: unknown[]) => mockIsThreadIdle(...args),
}));

import {
  draftInterviewBriefSections,
  prepareAssistedInterviewTurn,
} from '../services/interviewOrchestratorService';

const REQUIREMENTS_SKILL = '.cursor/skills/interview-requirements-review/SKILL.md';
const BA_ANSWER = 'Cashiers need a faster close.';
const CHAIN_OF_THOUGHT = 'SECRET_REASONING should never be stored';

const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];

const validReview = {
  findings: ['Close is slow at the register'],
  confirmedDecisions: ['The BA is the interviewer'],
  assumptions: ['One store closes each night'],
  gaps: ['Who counts the drawer is unknown'],
  risks: ['A second specialist pass would add latency'],
  conflicts: [],
  recommendedQuestion: 'Who counts the drawer?',
  blocking: false,
  confidence: 0.8,
};

function assistedInterview(briefVersion: number | null) {
  return {
    id: 'interview-1',
    chatThreadId: 'thread-main',
    authorId: 'ba-1',
    project: 'Apex',
    repo: 'org/apex',
    model: 'stale-row-model',
    effort: 'low',
    skillSettingsId: 'settings-1',
    playbookInterviewMode: 'multi_agent_assisted',
    playbookProfileSnapshot: {
      mode: 'multi_agent_assisted',
      key: 'ba-discovery',
      skillPath: '.cursor/skills/grill-with-docs/SKILL.md',
      model: 'snapshot-model',
      effort: 'high',
      wantsDesignPrototype: false,
      wantsTestCases: true,
    },
    brief: briefVersion === null ? null : { version: briefVersion },
  };
}

function clockControls(timeoutMs = 1_000, pollIntervalMs = 100) {
  let nowMs = 10_000;
  let idle = false;
  let agentText = '';
  const sleep = jest.fn(async (ms: number) => {
    nowMs += ms;
    idle = true;
  });
  mockIsThreadIdle.mockImplementation(() => idle);
  mockHydrateThread.mockResolvedValue(true);
  mockGetThread.mockImplementation(async () => ({
    id: 'specialist-1',
    status: idle ? 'idle' : 'running',
    messages: [
      { id: 'user-1', role: 'user', text: BA_ANSWER, hidden: true, ts: '1' },
      ...(idle && agentText
        ? [{ id: 'agent-1', role: 'agent', text: agentText, ts: '2' }]
        : []),
    ],
  }));
  return {
    timeoutMs,
    pollIntervalMs,
    now: () => nowMs,
    sleep,
    setAgentText(text: string) {
      agentText = text;
    },
    finishOnFirstPoll() {
      idle = true;
    },
    stayRunning() {
      sleep.mockImplementation(async (ms: number) => {
        nowMs += ms;
      });
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  inserts.length = 0;
  mockInsert.mockImplementation((table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      inserts.push({ table, values });
      return Promise.resolve();
    },
  }));
  mockCreateThread.mockResolvedValue({ id: 'specialist-1' });
  mockSendMessage.mockResolvedValue(undefined);
  mockFindFirst.mockResolvedValue(assistedInterview(null));
});

describe('VT-ASSIST-1 — ordinary and human-led turns prepare nothing', () => {
  it.each([
    ['ordinary', null],
    ['human_led', { ...assistedInterview(null), playbookInterviewMode: 'human_led', playbookProfileSnapshot: { ...assistedInterview(null).playbookProfileSnapshot, mode: 'human_led' } }],
    ['dashboard', { ...assistedInterview(null), playbookInterviewMode: null, playbookProfileSnapshot: null }],
  ])('a %s thread returns no internal context and writes nothing', async (_label, row) => {
    mockFindFirst.mockResolvedValue(row);

    const result = await prepareAssistedInterviewTurn({
      mainThreadId: 'thread-main',
      answerText: BA_ANSWER,
      specialists: ['requirements'],
    });

    expect(result).toEqual({ internalContext: null });
    expect(mockEq).toHaveBeenCalledWith(interviews.chatThreadId, 'thread-main');
    expect(mockCreateThread).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe('VT-ASSIST-2 — one Requirements pass uses the snapshot and a hidden prompt', () => {
  it('creates one specialist thread, sends one hidden answer, and does not pass again', async () => {
    const clock = clockControls();
    clock.setAgentText(JSON.stringify(validReview));

    await prepareAssistedInterviewTurn({
      mainThreadId: 'thread-main',
      answerText: BA_ANSWER,
      specialists: ['requirements', 'requirements', 'ux'],
      timeoutMs: clock.timeoutMs,
      pollIntervalMs: clock.pollIntervalMs,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(mockCreateThread).toHaveBeenCalledTimes(1);
    expect(mockCreateThread).toHaveBeenCalledWith(
      'ba-1',
      expect.objectContaining({
        project: 'Apex',
        repo: 'org/apex',
        model: 'snapshot-model',
        effort: 'high',
        skillPath: REQUIREMENTS_SKILL,
      }),
      { skipAutoKickoff: true },
    );
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(
      'specialist-1',
      expect.stringContaining(BA_ANSWER),
      undefined,
      [],
      { hidden: true },
    );
    expect(mockHydrateThread).toHaveBeenCalledWith('specialist-1');
    expect(mockIsThreadIdle).toHaveBeenCalledWith('specialist-1');
    expect(clock.sleep).toHaveBeenCalled();
  });
});

describe('VT-ASSIST-3 — valid specialist JSON is stored without chain-of-thought', () => {
  it('persists the current brief version, or version 1 before a brief exists, and delimits Lead context', async () => {
    const fenced = [
      '```json',
      JSON.stringify({ ...validReview, chainOfThought: CHAIN_OF_THOUGHT, reasoning: CHAIN_OF_THOUGHT }),
      '```',
    ].join('\n');

    for (const briefVersion of [null, 4] as const) {
      inserts.length = 0;
      mockInsert.mockClear();
      mockFindFirst.mockResolvedValue(assistedInterview(briefVersion));
      const clock = clockControls();
      clock.finishOnFirstPoll();
      clock.setAgentText(fenced);

      const result = await prepareAssistedInterviewTurn({
        mainThreadId: 'thread-main',
        answerText: BA_ANSWER,
        specialists: ['requirements'],
        timeoutMs: clock.timeoutMs,
        pollIntervalMs: clock.pollIntervalMs,
        now: clock.now,
        sleep: clock.sleep,
      });

      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockInsert).toHaveBeenCalledWith(interviewSpecialistReviews);
      expect(inserts[0].values).toEqual(expect.objectContaining({
        interviewId: 'interview-1',
        briefVersion: briefVersion ?? 1,
        specialist: 'requirements',
        status: 'succeeded',
        model: 'snapshot-model',
      }));
      expect(inserts[0].values.durationMs).toEqual(expect.any(Number));
      expect(inserts[0].values.durationMs as number).toBeGreaterThanOrEqual(0);
      expect(inserts[0].values.result).toEqual(validReview);
      expect(JSON.stringify(inserts[0].values.result)).not.toContain(CHAIN_OF_THOUGHT);
      expect(result.internalContext).toContain('<<<INTERNAL_SPECIALIST_CONTEXT>>>');
      expect(result.internalContext).toContain('<<<END_INTERNAL_SPECIALIST_CONTEXT>>>');
      expect(result.internalContext).toContain('Who counts the drawer?');
      expect(result.internalContext).not.toContain(CHAIN_OF_THOUGHT);
      expect(result.internalContext).not.toContain(BA_ANSWER);
    }
  });
});

describe('VT-ASSIST-4 — a failed specialist review still lets the Lead continue', () => {
  it('stores one timeout review and returns safe failure context', async () => {
    const clock = clockControls(300, 100);
    clock.stayRunning();

    const result = await prepareAssistedInterviewTurn({
      mainThreadId: 'thread-main',
      answerText: BA_ANSWER,
      specialists: ['requirements'],
      timeoutMs: clock.timeoutMs,
      pollIntervalMs: clock.pollIntervalMs,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(mockCreateThread).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toEqual(expect.objectContaining({
      interviewId: 'interview-1',
      briefVersion: 1,
      specialist: 'requirements',
      status: 'failed',
      result: { error: 'timeout' },
      model: 'snapshot-model',
    }));
    expect(result.internalContext).toContain('<<<INTERNAL_SPECIALIST_CONTEXT>>>');
    expect(result.internalContext).toContain('<<<END_INTERNAL_SPECIALIST_CONTEXT>>>');
    expect(result.internalContext).toContain('timeout');
    expect(result.internalContext?.toLowerCase()).toContain('continue');
    expect(result.internalContext).not.toContain(BA_ANSWER);
  });

  it('stores one agent-error review without the thrown message', async () => {
    mockSendMessage.mockRejectedValue(new Error('SECRET_AGENT_FAILURE'));
    const clock = clockControls();

    const result = await prepareAssistedInterviewTurn({
      mainThreadId: 'thread-main',
      answerText: BA_ANSWER,
      specialists: ['requirements'],
      timeoutMs: clock.timeoutMs,
      pollIntervalMs: clock.pollIntervalMs,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values.status).toBe('failed');
    expect(inserts[0].values.result).toEqual({ error: 'agent_error' });
    expect(JSON.stringify(inserts[0].values)).not.toContain('SECRET_AGENT_FAILURE');
    expect(result.internalContext).toContain('<<<INTERNAL_SPECIALIST_CONTEXT>>>');
    expect(result.internalContext).not.toContain('SECRET_AGENT_FAILURE');
    expect(result.internalContext?.toLowerCase()).toContain('continue');
  });

  it.each([
    ['prose', `Here is my chain-of-thought: ${CHAIN_OF_THOUGHT}`],
    ['schema', JSON.stringify({ findings: 'not-a-list', chainOfThought: CHAIN_OF_THOUGHT })],
  ])('stores one invalid JSON review for %s and omits the payload', async (_label, agentText) => {
    const clock = clockControls();
    clock.finishOnFirstPoll();
    clock.setAgentText(agentText);

    const result = await prepareAssistedInterviewTurn({
      mainThreadId: 'thread-main',
      answerText: BA_ANSWER,
      specialists: ['requirements'],
      timeoutMs: clock.timeoutMs,
      pollIntervalMs: clock.pollIntervalMs,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values.status).toBe('failed');
    expect(inserts[0].values.result).toEqual({ error: 'invalid_json' });
    expect(JSON.stringify(inserts[0].values)).not.toContain(CHAIN_OF_THOUGHT);
    expect(result.internalContext).toContain('invalid_json');
    expect(result.internalContext).not.toContain(CHAIN_OF_THOUGHT);
    expect(result.internalContext?.toLowerCase()).toContain('continue');
  });
});

it('drafts the editable brief from the visible interview transcript', async () => {
  const draft = {
    problemAndOutcome: 'Reduce close time',
    users: 'Cashiers',
    scope: 'Nightly store close',
    businessRules: 'A manager verifies totals',
    scenarios: 'Cashier closes a drawer',
    acceptanceCriteria: 'Close completes within five minutes',
    assumptions: '',
    unresolvedItems: ['Confirm the SLA'],
  };
  mockFindFirst.mockResolvedValue(assistedInterview(null));
  mockHydrateThread.mockResolvedValue(true);
  mockIsThreadIdle.mockReturnValue(true);
  mockGetThread
    .mockResolvedValueOnce({
      id: 'thread-main',
      status: 'idle',
      messages: [
        { id: 'u1', role: 'user', text: BA_ANSWER, ts: '1' },
        { id: 'a1', role: 'agent', text: 'Who closes the drawer?', ts: '2' },
      ],
    })
    .mockResolvedValueOnce({
      id: 'specialist-1',
      status: 'idle',
      messages: [{ id: 'a2', role: 'agent', text: JSON.stringify(draft), ts: '3' }],
    });

  await expect(draftInterviewBriefSections({ interviewId: 'interview-1' })).resolves.toEqual(draft);
  expect(mockCreateThread).toHaveBeenCalledWith(
    'ba-1',
    expect.objectContaining({
      skillPath: '.cursor/skills/interview-brief-draft/SKILL.md',
      model: 'snapshot-model',
    }),
    { skipAutoKickoff: true },
  );
  expect(mockSendMessage).toHaveBeenCalledWith(
    'specialist-1',
    expect.stringContaining(BA_ANSWER),
    undefined,
    [],
    { hidden: true },
  );
});

describe('assisted interview skills', () => {
  it('the Requirements skill returns only the structured findings', () => {
    const skill = fs.readFileSync(
      path.join(process.cwd(), REQUIREMENTS_SKILL),
      'utf8',
    );
    for (const field of [
      'findings',
      'confirmedDecisions',
      'assumptions',
      'gaps',
      'risks',
      'conflicts',
      'recommendedQuestion',
      'blocking',
      'confidence',
    ]) {
      expect(skill).toContain(field);
    }
    expect(skill.toLowerCase()).toContain('chain-of-thought');
    expect(skill.toLowerCase()).toContain('json');
  });

  it('the Lead skill asks at most one question and keeps specialist context hidden', () => {
    const skill = fs.readFileSync(
      path.join(process.cwd(), '.cursor/skills/interview-orchestrator/SKILL.md'),
      'utf8',
    );
    expect(skill.toLowerCase()).toContain('one question');
    expect(skill).toContain('INTERNAL_SPECIALIST_CONTEXT');
    expect(skill.toLowerCase()).toContain('problem and outcome');
    expect(skill.toLowerCase()).toContain('acceptance criteria');
  });
});
