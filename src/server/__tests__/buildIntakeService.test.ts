const mockGetThread = jest.fn();
const mockCreateThread = jest.fn();
const mockSendMessage = jest.fn();
jest.mock('../services/chatAgentService', () => ({
  getThread: (...args: unknown[]) => mockGetThread(...args),
  createThread: (...args: unknown[]) => mockCreateThread(...args),
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
}));

const mockAppendBuildEvent = jest.fn();
jest.mock('../services/buildEventsService', () => ({
  appendBuildEvent: (...args: unknown[]) => mockAppendBuildEvent(...args),
}));

const mockFindBuildByPlaybookRun = jest.fn();
jest.mock('../services/buildOrchestrator/store', () => ({
  findBuildByPlaybookRun: (...args: unknown[]) => mockFindBuildByPlaybookRun(...args),
}));

const mockTrackEvent = jest.fn();
jest.mock('../services/telemetry', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

const mockDetect = jest.fn();
jest.mock('../services/buildIntakeSensitiveText', () => {
  const actual = jest.requireActual('../services/buildIntakeSensitiveText');
  return { detectSensitiveClasses: (text: string) => mockDetect(text) ?? actual.detectSensitiveClasses(text) };
});

import {
  BUILD_INTAKE_QUESTION_BUDGET,
  isBuildIntakeThread,
  prepareBuildIntakeTurn,
} from '../services/buildIntakeService';
import { BUILD_INTAKE_QUESTION_MARKER as Q } from '../../shared/utils/buildIntakeMarkers';
import type { ChatThread } from '../../shared/types/chat';

const TOKEN = 'Bearer abcdefgh12345678SECRETVALUE';

function thread(agentTexts: string[], extra: Partial<ChatThread> = {}): ChatThread {
  return {
    id: 'thread-1',
    userId: 'requester-1',
    status: 'idle',
    kickoff: {
      project: 'Apex',
      repo: 'org/target',
      playbookInterview: { runId: 'run-1', stepId: 'intake', snapshot: { key: 'build-intake', mode: 'human_led' } },
    } as ChatThread['kickoff'],
    workspaceDir: '/tmp',
    flagged: false,
    messages: agentTexts.map((text, index) => ({ id: `m${index}`, role: 'agent' as const, text, ts: '2026-01-01T00:00:00Z' })),
    createdAt: '2026-01-01T00:00:00Z',
    lastActivityAt: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDetect.mockReturnValue(undefined);
  mockGetThread.mockResolvedValue(thread([]));
  mockFindBuildByPlaybookRun.mockResolvedValue({ id: 'build-1', repository: 'org/target', requestedByUserId: 'requester-1' });
  mockAppendBuildEvent.mockResolvedValue({ inserted: true, event: null });
});

describe('isBuildIntakeThread', () => {
  it('keys off the playbook interview profile key', () => {
    expect(isBuildIntakeThread(thread([]))).toBe(true);
    expect(isBuildIntakeThread(thread([], { kickoff: { project: 'Apex', repo: 'r' } }))).toBe(false);
  });
});

describe('prepareBuildIntakeTurn — question budget (PBI-009 AC-2, TBI-009 DoD-1)', () => {
  it('VT-02: at 5 questions tells the agent to stop, state defaults and offer the confirm', async () => {
    mockGetThread.mockResolvedValue(thread([`${Q} a ${Q} b`, `${Q} c ${Q} d ${Q} e`]));
    const result = await prepareBuildIntakeTurn({ threadId: 'thread-1', messageText: 'answers', turnId: 't1' });
    expect(BUILD_INTAKE_QUESTION_BUDGET).toBe(5);
    expect(result.questionsAsked).toBe(5);
    expect(result.budgetSpent).toBe(true);
    expect(result.internalContext).toMatch(/ask no more questions/i);
    expect(result.internalContext).toMatch(/state each remaining default as an assumption/i);
    expect(result.internalContext).toMatch(/offer the confirm choice/i);
    expect(mockTrackEvent).toHaveBeenCalledWith('build.intake.question_budget_reached', { questionsAsked: '5' });
  });

  it('VT-02: tracks a cap breach when the agent asked more than 5', async () => {
    mockGetThread.mockResolvedValue(thread([`${Q}${Q}${Q}${Q}${Q}${Q}`]));
    await prepareBuildIntakeTurn({ threadId: 'thread-1', messageText: 'x', turnId: 't1' });
    expect(mockTrackEvent).toHaveBeenCalledWith('build.intake.question_cap_exceeded', { questionsAsked: '6' });
  });

  it('VT-03: at 2 questions says 3 remain and never to ask whether something might break (AC-3)', async () => {
    mockGetThread.mockResolvedValue(thread([`${Q} a ${Q} b`]));
    const result = await prepareBuildIntakeTurn({
      threadId: 'thread-1',
      messageText: 'Only admins should see the salary data',
      turnId: 't1',
    });
    expect(result.questionsAsked).toBe(2);
    expect(result.budgetSpent).toBe(false);
    expect(result.internalContext).toMatch(/3 remain/);
    expect(result.internalContext).toMatch(/never ask whether something might break/i);
    expect(result.internalContext).toMatch(/zero questions is correct/i);
  });

  it('honours a smaller budget passed for a revision round', async () => {
    mockGetThread.mockResolvedValue(thread([`${Q}${Q}${Q}`]));
    const result = await prepareBuildIntakeTurn({ threadId: 'thread-1', messageText: 'x', turnId: 't1', questionBudget: 3 });
    expect(result.budgetSpent).toBe(true);
  });

  it('wraps the context in the sentinel block and tells the agent not to mention it', async () => {
    const result = await prepareBuildIntakeTurn({ threadId: 'thread-1', messageText: 'x', turnId: 't1' });
    expect(result.internalContext.startsWith('<<<INTERNAL_INTAKE_CONTEXT>>>')).toBe(true);
    expect(result.internalContext.trimEnd().endsWith('<<<END_INTERNAL_INTAKE_CONTEXT>>>')).toBe(true);
    expect(result.internalContext).toMatch(/do not mention this block/i);
  });
});

describe('prepareBuildIntakeTurn — sensitive text (PBI-010)', () => {
  it('VT-08: names access_token and holds no part of the token (AC-0)', async () => {
    const result = await prepareBuildIntakeTurn({ threadId: 'thread-1', messageText: `use ${TOKEN}`, turnId: 't1' });
    expect(result.sensitiveClasses).toEqual(['access_token']);
    expect(result.internalContext).toContain('access token');
    expect(result.internalContext).toContain('Sensitive data warning');
    expect(result.internalContext).toContain('[[build-intake:warning:access_token]]');
    expect(result.internalContext).not.toContain('abcdefgh');
    expect(result.internalContext).not.toContain('SECRETVALUE');
    expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toContain('SECRETVALUE');
    expect(mockTrackEvent).toHaveBeenCalledWith('build.intake.sensitive_text_flagged', {
      classes: 'access_token',
      count: '1',
      source: 'turn',
    });
  });

  it('VT-09: a detector throw leaves a budget-only context and logs no text (AC-1)', async () => {
    mockDetect.mockImplementation(() => { throw new TypeError('boom'); });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await prepareBuildIntakeTurn({ threadId: 'thread-1', messageText: `secret ${TOKEN}`, turnId: 't1' });
    expect(result.sensitiveClasses).toEqual([]);
    expect(result.internalContext).toMatch(/questions asked so far/i);
    expect(result.internalContext).not.toContain('Sensitive data warning');
    expect(mockTrackEvent).toHaveBeenCalledWith('build.intake.sensitive_check_failed', { errorType: 'TypeError' });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('SECRETVALUE');
    expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toContain('SECRETVALUE');
    expect(mockAppendBuildEvent).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('VT-11: appends one timeline event with classes and count only (AC-3)', async () => {
    await prepareBuildIntakeTurn({ threadId: 'thread-1', messageText: `${TOKEN} and jane@example.com`, turnId: 't9' });
    expect(mockFindBuildByPlaybookRun).toHaveBeenCalledWith('run-1');
    expect(mockAppendBuildEvent).toHaveBeenCalledTimes(1);
    const event = mockAppendBuildEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      buildRunId: 'build-1',
      eventType: 'intake.sensitive_text_warning',
      severity: 'warn',
      detail: { classes: ['access_token', 'personal_email'], count: 2, correlationId: 'thread-1:t9' },
      dedupeKey: 'intake.sensitive_text_warning:thread-1:t9',
      actorUserId: 'requester-1',
    });
    expect(JSON.stringify(event)).not.toContain('SECRETVALUE');
    expect(JSON.stringify(event)).not.toContain('jane@');
  });

  it('VT-11: uses the seed correlation for the opening message', async () => {
    await prepareBuildIntakeTurn({ threadId: 'thread-1', messageText: TOKEN, turnId: 'seed' });
    expect(mockAppendBuildEvent.mock.calls[0][0].detail.correlationId).toBe('thread-1:seed');
    expect(mockTrackEvent).toHaveBeenCalledWith('build.intake.sensitive_text_flagged', expect.objectContaining({ source: 'seed' }));
  });

  it('VT-11: an event-write failure is logged and the turn continues', async () => {
    mockAppendBuildEvent.mockRejectedValue(new Error('db down'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await prepareBuildIntakeTurn({ threadId: 'thread-1', messageText: TOKEN, turnId: 't1' });
    expect(result.sensitiveClasses).toEqual(['access_token']);
    expect(errorSpy).toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('SECRETVALUE');
    errorSpy.mockRestore();
  });

  it('VT-22: a 100 KB message resolves without creating a thread or sending', async () => {
    const big = `${'lorem ipsum '.repeat(9000)}${TOKEN}`;
    expect(big.length).toBeGreaterThan(100_000);
    const result = await prepareBuildIntakeTurn({ threadId: 'thread-1', messageText: big, turnId: 't1' });
    expect(result.sensitiveClasses).toEqual(['access_token']);
    expect(mockCreateThread).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});
