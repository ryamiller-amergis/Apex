/**
 * S3 — build-intake brief drafting (VT-17 drafting side; PBI-011 AC-0, AC-1).
 */
const mockFindFirst = jest.fn();
jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      interviews: { findFirst: (...args: unknown[]) => mockFindFirst(...args) },
    },
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

import { BuildIntakeDraftError, draftBuildIntakeBrief } from '../services/interviewOrchestratorService';

const draft = {
  problemAndOutcome: 'Export builds',
  users: 'Members',
  scope: 'Export only',
  businessRules: '',
  scenarios: 'A member exports a build',
  acceptanceCriteria: '',
  assumptions: 'CSV is enough',
  unresolvedItems: [],
  requirements: [{ kind: 'ac', text: 'Members can export a build' }],
  riskCandidates: [{ category: 'access', rating: 'medium', decision: 'Add builds:export', rationale: 'Own gate', destructive: false }],
  estimatedTasks: 2,
  needsMigration: false,
};

const mainThread = {
  id: 'thread-main',
  status: 'idle',
  kickoff: { project: 'Apex', repo: 'org/target', skillRepo: 'org/skills' },
  messages: [
    { id: 'u1', role: 'user', text: 'Add an export button', ts: '1' },
    { id: 'h1', role: 'user', text: 'HIDDEN CONTEXT', ts: '2', hidden: true },
    { id: 'a1', role: 'agent', text: '[[build-intake:confirm]]\nDoes this match?', ts: '3' },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFindFirst.mockResolvedValue({
    id: 'interview-1',
    authorId: 'requester',
    project: 'Apex',
    repo: 'org/target',
    chatThreadId: 'thread-main',
    skillSettingsId: 'settings-1',
    playbookProfileSnapshot: { key: 'build-intake', skillPath: '.cursor/skills/build-intake/SKILL.md', model: 'm', effort: null },
  });
  mockHydrateThread.mockResolvedValue(true);
  mockCreateThread.mockResolvedValue({ id: 'specialist-1' });
});

it('PBI-011 AC-0 drafts with the profile skill and returns rows, candidates and the estimate', async () => {
  mockIsThreadIdle.mockReturnValue(true);
  mockGetThread
    .mockResolvedValueOnce(mainThread)
    .mockResolvedValueOnce({ id: 'specialist-1', status: 'idle', messages: [{ id: 'a2', role: 'agent', text: JSON.stringify(draft), ts: '4' }] });

  await expect(draftBuildIntakeBrief({ interviewId: 'interview-1' })).resolves.toEqual(draft);
  expect(mockCreateThread).toHaveBeenCalledWith(
    'requester',
    expect.objectContaining({ skillPath: '.cursor/skills/build-intake/SKILL.md', skillRepo: 'org/skills' }),
    { skipAutoKickoff: true },
  );
  const prompt = mockSendMessage.mock.calls[0][1] as string;
  expect(prompt).toMatch(/^Draft the build brief/);
  expect(prompt).not.toContain('HIDDEN CONTEXT');
});

it('VT-17 times out after the given limit with reason timeout', async () => {
  let clock = 0;
  mockIsThreadIdle.mockReturnValue(false);
  mockGetThread.mockResolvedValueOnce(mainThread).mockResolvedValue({ id: 'specialist-1', status: 'running', messages: [] });

  const error = await draftBuildIntakeBrief({
    interviewId: 'interview-1',
    timeoutMs: 60_000,
    pollIntervalMs: 30_000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  }).catch((err: unknown) => err);

  expect(error).toBeInstanceOf(BuildIntakeDraftError);
  expect((error as BuildIntakeDraftError).reason).toBe('timeout');
});

it('VT-17 rejects a reply that breaks the strict schema with reason invalid_json', async () => {
  mockIsThreadIdle.mockReturnValue(true);
  mockGetThread
    .mockResolvedValueOnce(mainThread)
    .mockResolvedValueOnce({ id: 'specialist-1', status: 'idle', messages: [{ id: 'a2', role: 'agent', text: JSON.stringify({ ...draft, extra: 1 }), ts: '4' }] });

  const error = await draftBuildIntakeBrief({ interviewId: 'interview-1' }).catch((err: unknown) => err);
  expect((error as BuildIntakeDraftError).reason).toBe('invalid_json');
});
