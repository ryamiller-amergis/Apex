import type { ChatMessage, ChatThread, ChatTurnSkill } from '../../shared/types/chat';
import type { InteractiveWorkflowClass } from '../../shared/types/interactiveWorkflow';
import {
  createDurableInteractiveTurnService,
  GroundingStillPreparingError,
} from '../services/durableInteractiveTurnService';
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
const GROUNDING = {
  provider: 'github',
  project: 'project-1',
  repository: 'repo-1',
  sha: 'abc123',
  profileId: 'profile-1',
};

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
    turnSkill?: ChatTurnSkill;
    effort?: null;
    guided?: boolean;
    repositoryContext?: { contextContent: string | null; agentsContent: string | null };
    adoToolGrant?: boolean;
    backgroundGrounding?: boolean;
    interviewContext?: string | null;
    resolveGrounding?: jest.Mock;
    loadSkill?: jest.Mock;
    resolveDeadlines?: jest.Mock;
    hasPinnedGrounding?: boolean;
    optionalGroundingWaitMs?: number;
    trackEvent?: jest.Mock;
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
    loadSkill:
      options.loadSkill ??
      jest.fn().mockResolvedValue({ path: SKILL_PATH, content: SKILL_CONTENT }),
    resolveGrounding:
      options.resolveGrounding ?? jest.fn().mockResolvedValue(GROUNDING),
    hasPinnedGrounding: jest.fn().mockResolvedValue(options.hasPinnedGrounding ?? false),
    optionalGroundingWaitMs: options.optionalGroundingWaitMs ?? 3_000,
    trackEvent: options.trackEvent ?? jest.fn(),
    loadRepositoryContext: jest.fn().mockResolvedValue(options.repositoryContext ?? null),
    isGuidedInterviewEnabled: jest.fn().mockResolvedValue(options.guided ?? false),
    isBackgroundGroundingEnabled: jest
      .fn()
      .mockResolvedValue(options.backgroundGrounding ?? false),
    loadInterviewContext: jest.fn().mockResolvedValue(options.interviewContext ?? null),
    resolveMaxviewCapability: jest.fn().mockResolvedValue('disabled'),
    resolveDeadlines:
      options.resolveDeadlines ??
      jest.fn(() => ({
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
    turnSkill: options.turnSkill,
    ...('effort' in options ? { effort: options.effort } : {}),
    ...(options.adoToolGrant ? { toolGrant: { allowedOperations: ['ado:read'], delegatedAdoToken: null } } : {}),
  });
  expect(repositoryAdmit).toHaveBeenCalledTimes(1);
  return repositoryAdmit.mock.calls[0][0].specification;
}

describe('durable interactive turn prompt', () => {
  it("freezes the caller's resolved effort, and the thread's when none is given", async () => {
    await expect(admittedSpecification([], { effort: null })).resolves.toMatchObject({
      effort: null,
    });
    await expect(admittedSpecification([])).resolves.toMatchObject({ effort: 'low' });
  });

  it('sends the skill and question-UI rules on the first turn', async () => {
    const specification = await admittedSpecification([]);

    expect(specification.currentPrompt).toContain(SKILL_CONTENT);
    expect(specification.currentPrompt).toContain('# UI rendering — interactive questions');
    expect(specification.currentPrompt).toContain('match each answer to the question text it quotes');
    expect(specification.currentPrompt).toContain('User request:\nconfirm');
  });

  it('tells the agent the skill governs the whole session, since later turns omit it', async () => {
    const specification = await admittedSpecification([]);

    expect(specification.currentPrompt).toContain('governs this whole session, not only this turn');
    expect(specification.currentPrompt).not.toContain('Follow it for this turn');
    expect(specification.recreationPrompt).toContain('governs this whole session, not only this turn');
  });

  it('scopes a skill picked mid-thread to that turn only', async () => {
    const specification = await admittedSpecification(
      [
        message('user', 'Summarize this thread', 1),
        message('agent', 'Here is the summary.', 2),
      ],
      { turnSkill: { name: 'Grill with docs', path: SKILL_PATH } },
    );

    expect(specification.currentPrompt).toContain(SKILL_CONTENT);
    expect(specification.currentPrompt).toContain('Follow it for this turn.');
    expect(specification.currentPrompt).not.toContain('governs this whole session');
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

  it('resends saved answers with their questions on later interview turns', async () => {
    const specification = await admittedSpecification([
      message('user', 'We need a California break attestation', 1),
      message('agent', 'Context first.\n**Where will this ship?**\na. Web\nb. Mobile', 2),
      message('user', 'Q1: A — Web', 3),
      message('agent', 'Noted.\nDoes this surface any PHI?\na. Yes\nb. No', 4),
    ]);

    expect(specification.currentPrompt).toContain("# Answers so far (from Apex's saved conversation)");
    expect(specification.currentPrompt).toContain(
      '1. Original request: We need a California break attestation',
    );
    expect(specification.currentPrompt).toContain(
      '2. You asked: **Where will this ship?**\n   User answered: Q1: A — Web',
    );
    expect(specification.currentPrompt).not.toContain('Does this surface any PHI?');
    expect(specification.currentPrompt).not.toContain(SKILL_CONTENT);
  });

  it('does not add an answer recap to Home chat turns', async () => {
    const specification = await admittedSpecification(
      [
        message('user', 'What does the notifications service do?', 1),
        message('agent', 'It fans out events. Anything else?', 2),
      ],
      { workflowClass: 'home-chat' },
    );

    expect(specification.currentPrompt).not.toContain('# Answers so far');
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

describe('durable guided interview turn', () => {
  const repositoryContext = {
    contextContent: '## Product\n\nManagers approve timesheets.',
    agentsContent: '# AGENTS\nSee `src/server/index.ts`.',
  };

  it('keeps the open-ended prompt when the Playbook interview step is off', async () => {
    const specification = await admittedSpecification([], { repositoryContext });

    expect(specification.guidedInterview).toBeUndefined();
    expect(specification.currentPrompt).not.toContain('# Server-controlled interview turn');
  });

  it('sends the controlled first Discovery turn with the application brief only', async () => {
    const specification = await admittedSpecification([], {
      guided: true,
      repositoryContext,
      adoToolGrant: true,
    });

    expect(specification.guidedInterview).toMatchObject({
      phase: 'product',
      turn: { phase: 'discovery', question: 1 },
    });
    expect(specification.currentPrompt).toContain(SKILL_CONTENT);
    expect(specification.currentPrompt).toContain('# Server-controlled interview turn');
    expect(specification.currentPrompt).toContain('# Application brief');
    expect(specification.currentPrompt).toContain('Managers approve timesheets.');
    expect(specification.recreationPrompt).not.toContain('## context.md');
    expect(specification.mcpServers).not.toContainEqual(
      expect.objectContaining({ serverName: 'ado-skills' }),
    );
  });

  it('replaces the answer recap with the guided Q&A on later turns', async () => {
    const specification = await admittedSpecification(
      [
        message('user', 'Begin.', 1),
        message('agent', '[[interview-phase:discovery:1:6]]\nWhat happens today?', 2),
      ],
      { guided: true, repositoryContext },
    );

    expect(specification.currentPrompt).not.toContain('# Answers so far');
    expect(specification.currentPrompt).toContain('# Prior interview Q&A');
    expect(specification.currentPrompt).toContain('What happens today?');
  });

  it('opens repository context once the interview enters Technical', async () => {
    const specification = await admittedSpecification(
      [
        message('user', 'Begin.', 1),
        message('agent', '[[interview-phase:technical:1:5]]\nFrontend, backend, or both?', 2),
      ],
      { guided: true, repositoryContext, adoToolGrant: true },
    );

    expect(specification.guidedInterview?.phase).toBe('technical');
    expect(specification.currentPrompt).toContain('# Technical phase');
    expect(specification.recreationPrompt).toContain('## context.md');
    expect(specification.mcpServers).toContainEqual(
      expect.objectContaining({ serverName: 'ado-skills' }),
    );
  });

  it('tells the interviewer to ask the person when no context.md is available', async () => {
    const specification = await admittedSpecification([], { guided: true });

    expect(specification.currentPrompt).toContain('No application brief was available');
  });

  it('waits for grounding in Discovery while background grounding is off', async () => {
    const resolveGrounding = jest.fn().mockResolvedValue(GROUNDING);
    const specification = await admittedSpecification([], {
      guided: true,
      resolveGrounding,
    });

    expect(specification.grounding).toMatchObject({ sha: 'abc123' });
    expect(resolveGrounding).toHaveBeenCalledTimes(1);
  });
});

describe('durable interactive turn admission', () => {
  const delayedGrounding = () =>
    jest.fn(
      () => new Promise((resolve) => setTimeout(() => resolve(GROUNDING), 30)),
    );

  it('records admission stage timings', async () => {
    const trackEvent = jest.fn();
    await admittedSpecification([], { trackEvent });

    expect(trackEvent).toHaveBeenCalledWith(
      'InteractiveTurnAdmission',
      expect.objectContaining({ status: 'queued', workflowClass: 'interview' }),
      expect.objectContaining({
        setupMs: expect.any(Number),
        groundingMs: expect.any(Number),
        promptMs: expect.any(Number),
        persistMs: expect.any(Number),
        totalMs: expect.any(Number),
      }),
    );
  });

  it('tells the user the code is still being prepared when the wait runs out', async () => {
    await expect(
      admittedSpecification([], {
        resolveGrounding: jest
          .fn()
          .mockRejectedValue(new GroundingStillPreparingError()),
      }),
    ).rejects.toMatchObject({ code: 'INTERACTIVE_V2_GROUNDING_PREPARING' });
  });

  it('gives an unpinned home chat only the short grounding wait', async () => {
    const specification = await admittedSpecification([], {
      workflowClass: 'home-chat',
      kickoff: { skillPath: undefined },
      resolveGrounding: delayedGrounding(),
      optionalGroundingWaitMs: 5,
    });

    expect(specification.grounding).toBeNull();
  });

  it('keeps a pinned home chat grounded past the short wait', async () => {
    const specification = await admittedSpecification([], {
      workflowClass: 'home-chat',
      kickoff: { skillPath: undefined },
      resolveGrounding: delayedGrounding(),
      optionalGroundingWaitMs: 5,
      hasPinnedGrounding: true,
    });

    expect(specification.grounding).toMatchObject({ sha: 'abc123' });
  });
});

describe('durable guided interview turn with background grounding', () => {
  const discoveryTurn = [
    message('user', 'Begin.', 1),
    message('agent', '[[interview-phase:discovery:1:6]]\nWhat happens today?', 2),
  ];

  it('admits a Discovery turn without waiting for the repository', async () => {
    const resolveGrounding = jest.fn(() => new Promise<never>(() => {}));
    const loadSkill = jest
      .fn()
      .mockResolvedValue({ path: SKILL_PATH, content: SKILL_CONTENT });
    const resolveDeadlines = jest.fn(() => ({
      absoluteTurnMs: 1_200_000,
      repositoryPreparationMs: null,
      firstEventMs: 45_000,
      toolCallMs: 60_000,
    }));

    const specification = await admittedSpecification([], {
      guided: true,
      backgroundGrounding: true,
      interviewContext: '## Product\n\nManagers approve timesheets.',
      resolveGrounding,
      loadSkill,
      resolveDeadlines,
    });

    expect(specification.grounding).toBeNull();
    expect(resolveGrounding).toHaveBeenCalledTimes(1);
    expect(resolveDeadlines).toHaveBeenCalledWith(
      expect.objectContaining({ requiresRepositoryPreparation: false }),
    );
    expect(loadSkill).toHaveBeenCalledWith(
      expect.objectContaining({ grounding: null, readBranchTip: true }),
    );
    expect(specification.currentPrompt).toContain('Managers approve timesheets.');
  });

  it('still admits the turn when background preparation fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const resolveGrounding = jest.fn().mockRejectedValue(new Error('fetch failed'));

    const specification = await admittedSpecification(discoveryTurn, {
      guided: true,
      backgroundGrounding: true,
      resolveGrounding,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(specification.grounding).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('InteractiveBackgroundGroundingFailed'),
    );
    warn.mockRestore();
  });

  it('waits for grounding once the interview enters Technical', async () => {
    const resolveGrounding = jest.fn().mockResolvedValue(GROUNDING);
    const loadSkill = jest
      .fn()
      .mockResolvedValue({ path: SKILL_PATH, content: SKILL_CONTENT });

    const specification = await admittedSpecification(
      [
        message('user', 'Begin.', 1),
        message('agent', '[[interview-phase:technical:1:5]]\nFrontend, backend, or both?', 2),
      ],
      { guided: true, backgroundGrounding: true, resolveGrounding, loadSkill },
    );

    expect(specification.grounding).toMatchObject({ sha: 'abc123' });
    expect(loadSkill).toHaveBeenCalledWith(
      expect.objectContaining({ readBranchTip: false }),
    );
  });
});
