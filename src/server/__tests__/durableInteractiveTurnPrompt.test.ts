import type { ChatMessage, ChatThread } from '../../shared/types/chat';
import type { InteractiveWorkflowClass } from '../../shared/types/interactiveWorkflow';
import { createDurableInteractiveTurnService } from '../services/durableInteractiveTurnService';
import type { PreparedDurableInteractiveTurn } from '../services/durableInteractiveTurnRepository';

jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn(),
}));
jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn() }));

const THREAD_ID = '10000000-0000-4000-8000-000000000001';
const TURN_ID = '20000000-0000-4000-8000-000000000001';
const USER_ID = '40000000-0000-4000-8000-000000000001';
const SKILL_PATH = '.cursor/skills/grill-with-docs/SKILL.md';
const SKILL_CONTENT = '# Grill with docs\nAsk opening questions Q1 to Q5.';

function message(role: 'user' | 'agent', text: string, index: number): ChatMessage {
  return {
    id: `message-${index}`,
    role,
    text,
    ts: `2026-10-07T15:2${index}:00.000Z`,
  } as ChatMessage;
}

function thread(
  messages: ChatMessage[],
  kickoffOverrides: Partial<ChatThread['kickoff']> = {},
): ChatThread {
  return {
    id: THREAD_ID,
    userId: USER_ID,
    kickoff: {
      project: 'project-1',
      repo: 'repo-1',
      skillProvider: 'github',
      skillPath: SKILL_PATH,
      model: 'model-a',
      effort: 'low',
      ...kickoffOverrides,
    },
    messages,
    status: 'idle',
    workspaceDir: '/tmp/thread',
    flagged: false,
    createdAt: '2026-10-07T15:00:00.000Z',
    lastActivityAt: '2026-10-07T15:20:00.000Z',
  } as ChatThread;
}

async function admittedSpecification(
  messages: ChatMessage[],
  options: {
    workflowClass?: InteractiveWorkflowClass;
    kickoff?: Partial<ChatThread['kickoff']>;
  } = {},
): Promise<PreparedDurableInteractiveTurn['specification']> {
  const repositoryAdmit = jest.fn(async (input: PreparedDurableInteractiveTurn) => ({
    turnId: input.turnId,
    runId: '50000000-0000-4000-8000-000000000001',
    status: 'queued' as const,
    interactiveClass: input.interactiveClass,
    idempotent: false,
  }));
  const service = createDurableInteractiveTurnService({
    repository: { admit: repositoryAdmit, retry: jest.fn() },
    attachmentStore: { upload: jest.fn() },
    resolveThreadAccess: jest.fn().mockResolvedValue({
      access: 'owner',
      thread: thread(messages, options.kickoff),
    }),
    resolveSkillConfig: jest.fn().mockResolvedValue({
      interviewSkillOptions: [{ path: SKILL_PATH, friendlyName: 'Grill with docs' }],
    }),
    loadSkill: jest.fn().mockResolvedValue({ path: SKILL_PATH, content: SKILL_CONTENT }),
    resolveGrounding: jest.fn().mockResolvedValue({
      provider: 'github',
      project: 'project-1',
      repository: 'repo-1',
      sha: 'abc123',
      profileId: 'profile-1',
    }),
    loadRepositoryContext: jest.fn().mockResolvedValue(null),
    resolveMaxviewCapability: jest.fn().mockResolvedValue('disabled'),
    resolveDeadlines: jest.fn(() => ({
      absoluteTurnMs: 1_200_000,
      repositoryPreparationMs: 120_000,
      firstEventMs: 45_000,
      toolCallMs: 60_000,
    })),
    encryptToolGrant: jest.fn(),
    now: () => new Date('2026-10-07T15:30:00.000Z'),
  });

  await service.admit({
    threadId: THREAD_ID,
    userId: USER_ID,
    workflowClass: options.workflowClass ?? 'interview',
    turnId: TURN_ID,
    text: 'confirm',
    attachments: [],
  });
  expect(repositoryAdmit).toHaveBeenCalledTimes(1);
  return repositoryAdmit.mock.calls[0][0].specification;
}

describe('durable interactive turn prompt', () => {
  it('sends the skill and question-UI rules on the first turn', async () => {
    const specification = await admittedSpecification([]);

    expect(specification.currentPrompt).toContain(SKILL_CONTENT);
    expect(specification.currentPrompt).toContain('# UI rendering — interactive questions');
    expect(specification.currentPrompt).toContain('User request:\nconfirm');
  });

  it('sends only the reply on later turns but keeps the skill for a rebuilt agent', async () => {
    const specification = await admittedSpecification([
      message('user', 'We need a California break attestation', 1),
      message('agent', 'Q1: which platforms? a. Web b. Mobile', 2),
    ]);

    expect(specification.currentPrompt).not.toContain(SKILL_CONTENT);
    expect(specification.currentPrompt).not.toContain('# UI rendering — interactive questions');
    expect(specification.currentPrompt).toContain('User request:\nconfirm');
    expect(specification.recreationPrompt).toContain(SKILL_CONTENT);
    expect(specification.recreationPrompt).toContain('# UI rendering — interactive questions');
    expect(specification.recreationPrompt).toContain('Q1: which platforms?');
  });

  it('gives a PRD assistant the staging tool and its edit guidance', async () => {
    const specification = await admittedSpecification([], {
      workflowClass: 'assistant',
      kickoff: {
        assistantType: 'prd',
        freeformContext: 'prd_id: prd-1\nproject: project-1',
      },
    });

    expect(specification.mcpServers).toContainEqual(
      expect.objectContaining({ kind: 'internal-proxy', serverName: 'ado-skills' }),
    );
    expect(specification.currentPrompt).toContain('# Applying edits — MANDATORY tool use');
    expect(specification.currentPrompt).toContain('prd_id:    prd-1');
    expect(specification.currentPrompt).not.toContain('.ai-pilot/kickoff-context.md');
    expect(specification.currentPrompt).toContain('the `# Thread context` section of this prompt');
    expect(specification.recreationPrompt).toContain('# Applying edits — MANDATORY tool use');
  });

  it('inlines the kickoff transcript for a rebuilt agent', async () => {
    const specification = await admittedSpecification([], {
      workflowClass: 'home-chat',
      kickoff: { transcript: 'Interviewer: which states? User: California only.' },
    });

    expect(specification.recreationPrompt).toContain('# Kickoff transcript');
    expect(specification.recreationPrompt).toContain(
      'Interviewer: which states? User: California only.',
    );
  });

  it('leaves ado-skills off for an interview without ADO intent', async () => {
    const specification = await admittedSpecification([]);

    expect(specification.mcpServers).not.toContainEqual(
      expect.objectContaining({ serverName: 'ado-skills' }),
    );
  });

  it('sends the Home turn contract only to home chats', async () => {
    const home = await admittedSpecification([], { workflowClass: 'home-chat' });
    const interview = await admittedSpecification([]);

    expect(home.currentPrompt).toContain('# Conversational turn contract');
    expect(interview.currentPrompt).not.toContain('# Conversational turn contract');
  });

});
