/**
 * Unit tests for thread-retention behavior in chatAgentService.
 * Verifies that closeThread never deletes the chat_threads row when
 * the thread is interview-backed or referenced by any document row
 * (PRD or design doc), guarding against cascade data loss.
 */
// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

jest.mock('fs', () => ({
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  cpSync: jest.fn(),
  rmSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(false),
  readdirSync: jest.fn().mockReturnValue([]),
  readFileSync: jest.fn().mockReturnValue(''),
}));

jest.mock('@cursor/sdk', () => {
  class CursorAgentError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'CursorAgentError';
    }
  }
  return {
    Agent: { create: jest.fn(), resume: jest.fn() },
    CursorAgentError,
  };
});

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      interviews: { findFirst: jest.fn().mockResolvedValue(null) },
      prds: { findFirst: jest.fn().mockResolvedValue(null) },
      designDocs: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    insert: jest.fn(() => ({
      values: jest.fn(() =>
        Object.assign(Promise.resolve(), {
          onConflictDoNothing: jest.fn(() => Promise.resolve()),
        })
      ),
    })),
    delete: jest.fn(() => ({
      where: jest.fn(() => Promise.resolve()),
    })),
  },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn(),
  and: jest.fn(),
  isNull: jest.fn(),
  or: jest.fn(),
}));

jest.mock('../db/schema', () => ({
  interviews: {},
  prds: {},
  designDocs: {},
  chatThreads: {},
  agentRuns: { id: 'id' },
}));

jest.mock('../services/chatThreadRepository', () => ({
  upsertThread: jest.fn().mockResolvedValue(undefined),
  insertMessage: jest.fn().mockResolvedValue(undefined),
  listThreadsByUser: jest.fn().mockResolvedValue([]),
  loadFullThread: jest.fn().mockResolvedValue(null),
  deleteThread: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/prdService', () => ({ syncPrdContent: jest.fn() }));

jest.mock('../services/designDocService', () => ({
  syncDesignDocContent: jest.fn(),
  syncValidationResult: jest.fn(),
  syncPerFeatureDesignDocs: jest.fn(),
  finalizeSingleFeatureDoc: jest.fn(),
  isSingleFeatureDesignDocRow: jest.fn(
    (row: {
      designPrototypeId?: string | null;
      featureIndex?: number | null;
    }) => row.designPrototypeId != null || row.featureIndex != null
  ),
}));

jest.mock('../services/telemetry', () => ({
  trackAgentError: jest.fn(),
  trackEvent: jest.fn(),
}));

jest.mock('../utils/dataDir', () => ({
  resolveDataRoot: () => '/tmp/test-data',
  isAzureWwwroot: () => false,
}));

jest.mock('../utils/retry', () => ({
  retryWithBackoff: jest.fn(),
}));

jest.mock('../services/teamsBotService', () => ({
  sendTeamsNotification: jest.fn().mockResolvedValue(undefined),
  handleIncoming: jest.fn(),
}));

jest.mock('../services/skillCatalogFacade', () => ({
  getSkillFile: jest.fn().mockResolvedValue('# Frozen skill content'),
}));

const mockEnqueueAgentRun = jest.fn();
jest.mock('../services/agentRunLifecycleService', () => ({
  enqueue: mockEnqueueAgentRun,
}));

const mockInteractiveWorkflowRoute = jest.fn();
jest.mock('../services/interactiveWorkflowRouter', () => ({
  interactiveWorkflowRouter: {
    route: mockInteractiveWorkflowRoute,
  },
}));

const mockIsFeatureEnabled = jest.fn().mockResolvedValue(false);
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
  isLifecycleBindingEnabledForCaller: jest.fn().mockResolvedValue(false),
}));

const mockCallerGroundingStart = jest.fn();
const mockCallerGroundingSelectionToBinding = jest.fn();
const mockEvaluateBindingContinuity = jest.fn();
jest.mock('../services/callerGroundingService', () => ({
  callerGroundingService: {
    start: mockCallerGroundingStart,
  },
  callerGroundingSelectionToBinding: mockCallerGroundingSelectionToBinding,
  evaluateBindingContinuity: mockEvaluateBindingContinuity,
}));

const mockResolveConnectionProfile = jest.fn();
jest.mock('../services/groundingProfileResolver', () => ({
  groundingProfileResolver: {
    resolveConnectionProfile: mockResolveConnectionProfile,
  },
}));

const mockIsThreadRunAlive = jest.fn().mockResolvedValue(false);
jest.mock('../services/agentRunReaperService', () => ({
  isThreadRunAlive: (...args: unknown[]) => mockIsThreadRunAlive(...args),
  resolveAgentRunHardLimitMs: jest.fn().mockReturnValue(10 * 60 * 1000),
  resolveAgentFirstEventTimeoutMs: jest.fn().mockReturnValue(2 * 60 * 1000),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  createThread,
  sendMessage,
  closeThread,
  permanentlyDeleteThread,
  markAsInterviewThread,
  buildMcpServers,
  buildDocumentAssistantEditGuidance,
  buildAgentRecoveryContext,
  isDocumentAssistant,
  isRepositoryReadingChatCaller,
  isInteractiveWorkspaceBoundSkill,
  resolveGroundingCallerKey,
  resolveInteractiveWorkflowClass,
  resumeOrCreateAgent,
  selectGroundingBoundaryRecreation,
  resumePinnedTurnAgent,
  releaseGroundingForStaleRecovery,
  settleGroundingContinuityAfterBindingWrite,
  classifyGroundingContinuity,
  persistCreatedAgentBinding,
  resolveDocumentAssistantType,
  buildBackgroundWorkflowPrompt,
  buildInitialPrompt,
  buildTurnPrompt,
  prepareBackgroundWorkflowTurn,
  prepareRepositoryReadRuntime,
  subscribeToThread,
} from '../services/chatAgentService';
import type {
  ChatMessage,
  ChatThread,
  ChatThreadKickoff,
} from '../../shared/types/chat';
import { getSkillFile } from '../services/skillCatalogFacade';
import type { CallerGroundingSelection } from '../services/callerGroundingService';
import type {
  GroundingProfileId,
  RepoReader,
} from '../../shared/types/repoReader';

describe('turn skill prompts', () => {
  it('keeps the user request separate while directing the agent to load the selected skill', () => {
    expect(
      buildTurnPrompt('Summarize the sprint', {
        name: 'Scrum Assistant',
        path: '/.cursor/skills/scrum-assistant/SKILL.md',
      }),
    ).toBe(
      'Run skill: Scrum Assistant (`/.cursor/skills/scrum-assistant/SKILL.md`)\n'
      + '\nUser request:\nSummarize the sprint',
    );
  });
});

const { deleteThread: mockPgDeleteThread, upsertThread: mockPgUpsertThread } =
  jest.requireMock('../services/chatThreadRepository') as {
    deleteThread: jest.Mock;
    upsertThread: jest.Mock;
  };

const { db: mockDb } = jest.requireMock('../db/drizzle') as {
  db: {
    query: {
      prds: { findFirst: jest.Mock };
      designDocs: { findFirst: jest.Mock };
    };
    insert: jest.Mock;
  };
};

function chatMessage(
  id: string,
  role: ChatMessage['role'],
  text: string,
  overrides: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id,
    role,
    text,
    ts: `2026-07-28T00:00:0${id.length}.000Z`,
    ...overrides,
  };
}

function chatThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: 'thread-binding',
    userId: 'developer-1',
    kickoff: baseKickoff(),
    messages: [],
    status: 'idle',
    workspaceDir: '/tmp/thread-binding',
    flagged: false,
    createdAt: '2026-08-03T00:00:00.000Z',
    lastActivityAt: '2026-08-03T00:00:00.000Z',
    ...overrides,
  };
}

describe('PBI-001 shared chat lifecycle regression', () => {
  it('builds history from visible user and agent messages only', () => {
    const recovery = buildAgentRecoveryContext([
      chatMessage('1', 'user', 'We need guided feature walkthroughs.'),
      chatMessage('2', 'tool', '→ search_repo_code', {
        toolName: 'search_repo_code',
      }),
      chatMessage('3', 'agent', 'Internal planning snapshot', {
        toolName: '_reasoning',
      }),
      chatMessage('4', 'user', 'Begin.', { hidden: true }),
      chatMessage(
        '5',
        'agent',
        'Should walkthroughs remain separate from What’s New?'
      ),
    ]);

    expect(recovery).not.toBeNull();
    expect(recovery?.totalMessageCount).toBe(2);
    expect(recovery?.truncated).toBe(false);
    expect(recovery?.content).toContain('We need guided feature walkthroughs.');
    expect(recovery?.content).toContain(
      'Should walkthroughs remain separate from What’s New?'
    );
    expect(recovery?.content).not.toContain('search_repo_code');
    expect(recovery?.content).not.toContain('Internal planning snapshot');
    expect(recovery?.content).not.toContain('Begin.');
  });

  it('returns no recovery context when only execution noise exists', () => {
    expect(
      buildAgentRecoveryContext([
        chatMessage('1', 'tool', '→ shell', { toolName: 'shell' }),
        chatMessage('2', 'agent', 'Analyzing', { toolName: '_reasoning' }),
        chatMessage('3', 'user', 'Begin.', { hidden: true }),
      ])
    ).toBeNull();
  });

  it('bounds oversized history while preserving the beginning and latest turn', () => {
    const recovery = buildAgentRecoveryContext(
      [
        chatMessage('1', 'user', `BEGINNING_DECISION ${'a'.repeat(700)}`),
        chatMessage('2', 'agent', `MIDDLE_HISTORY ${'b'.repeat(2_000)}`),
        chatMessage('3', 'user', `LATEST_TURN ${'c'.repeat(500)}`),
      ],
      1_200
    );

    expect(recovery?.truncated).toBe(true);
    expect(recovery?.content).toContain('BEGINNING_DECISION');
    expect(recovery?.content).toContain('LATEST_TURN');
    expect(recovery?.content).toContain('middle messages omitted');
  });

  it('AC-0 / VT-01 creates an agent when PostgreSQL has no Cursor agent id', async () => {
    // Given a new PostgreSQL-backed chat thread has no Cursor agent id.
    const resume = jest.fn();
    const create = jest.fn().mockResolvedValue({ agentId: 'created-agent' });

    // When the shared lifecycle acquires the SDK agent.
    const result = await resumeOrCreateAgent({
      resume,
      create,
    });

    // Then it creates exactly one agent and exposes the observable lifecycle mode.
    expect(result).toEqual({
      agent: { agentId: 'created-agent' },
      mode: 'created',
    });
    expect(resume).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('AC-0 / VT-03 recreates after resume failure with recoverable PostgreSQL history', async () => {
    // Given a stale Cursor agent id and visible history persisted by Apex.
    const resumeError = new Error('agent session no longer exists');
    const resume = jest.fn().mockRejectedValue(resumeError);
    const create = jest
      .fn()
      .mockResolvedValue({ agentId: 'replacement-agent' });
    const recovery = buildAgentRecoveryContext([
      chatMessage('1', 'user', 'Keep the approved repository boundary.'),
      chatMessage('2', 'agent', 'The boundary remains MCP-only.'),
    ]);

    // When resume falls back to create.
    const result = await resumeOrCreateAgent({
      cursorAgentId: 'disposed-agent',
      resume,
      create,
    });

    // Then the caller can inject the recovered PostgreSQL transcript and continue.
    expect(resume).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(recovery?.content).toContain(
      'Keep the approved repository boundary.'
    );
    expect(recovery?.content).toContain('The boundary remains MCP-only.');
    expect(result).toEqual({
      agent: { agentId: 'replacement-agent' },
      mode: 'recreated',
      resumeError,
    });
  });

  it('AC-0 / VT-02 resumes an existing agent without creating another', async () => {
    const resume = jest.fn().mockResolvedValue({ agentId: 'resumed-agent' });
    const create = jest.fn();

    const result = await resumeOrCreateAgent({
      cursorAgentId: 'existing-agent',
      resume,
      create,
    });

    expect(result.mode).toBe('resumed');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('PBI-002 grounding acquisition continuity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('AC-0 / acquisition integration classifies the exact acquired local selection once', () => {
    // Given a loaded thread is bound to the same local SHA selected for this caller.
    const thread = chatThread({
      groundingMode: 'local',
      groundedSha: 'sha-resolved',
    });
    const selection = {
      mode: 'local',
      cwd: '/tmp/grounded',
      profileId: 'profile-1' as GroundingProfileId,
      resolvedSha: 'sha-resolved',
      nativeReads: false,
      workingTree: true,
      release: jest.fn(),
    } satisfies CallerGroundingSelection;
    const resolved = { mode: 'local' as const, sha: 'sha-resolved' };
    mockCallerGroundingSelectionToBinding.mockReturnValue(resolved);
    mockEvaluateBindingContinuity.mockReturnValue({ decision: 'resume' });

    // When continuity is classified immediately from that acquired selection.
    const result = classifyGroundingContinuity(thread, selection);

    // Then conversion and evaluation each happen once against the persisted shape.
    expect(mockCallerGroundingSelectionToBinding).toHaveBeenCalledTimes(1);
    expect(mockCallerGroundingSelectionToBinding).toHaveBeenCalledWith(
      selection
    );
    expect(mockEvaluateBindingContinuity).toHaveBeenCalledTimes(1);
    expect(mockEvaluateBindingContinuity).toHaveBeenCalledWith(
      { mode: 'local', sha: 'sha-resolved' },
      resolved
    );
    expect(result).toEqual({
      resolvedBinding: resolved,
      decision: { decision: 'resume' },
    });
  });

  it('AC-1 / acquisition integration preserves malformed stored binding shape', () => {
    // Given persistence contains an orphan SHA without a normalized grounding mode.
    const thread = chatThread({
      groundingMode: undefined,
      groundedSha: 'orphan-sha',
    });
    const selection = {
      mode: 'remote',
      release: jest.fn(),
    } satisfies CallerGroundingSelection;
    const resolved = { mode: 'remote' as const, sha: null };
    const recreate = {
      decision: 'recreate' as const,
      reason: 'binding-malformed' as const,
    };
    mockCallerGroundingSelectionToBinding.mockReturnValue(resolved);
    mockEvaluateBindingContinuity.mockReturnValue(recreate);

    // When continuity is classified from the acquired remote selection.
    const result = classifyGroundingContinuity(thread, selection);

    // Then the malformed stored pair reaches the evaluator unchanged and remains typed.
    expect(mockEvaluateBindingContinuity).toHaveBeenCalledWith(
      { mode: undefined, sha: 'orphan-sha' },
      resolved
    );
    expect(result.decision).toEqual(recreate);
  });

  it('AC-0 / acquisition integration wires sendMessage to one authoritative classification', async () => {
    // Given a repo-reading thread and one exact remote grounding selection.
    const stopAfterClassification = new Error(
      'stop after continuity classification'
    );
    const selection = {
      mode: 'remote',
      release: jest.fn().mockResolvedValue(undefined),
    } satisfies CallerGroundingSelection;
    const resolved = { mode: 'remote' as const, sha: null };
    mockCallerGroundingStart.mockResolvedValue(selection);
    mockCallerGroundingSelectionToBinding.mockReturnValue(resolved);
    mockEvaluateBindingContinuity.mockImplementation(() => {
      throw stopAfterClassification;
    });
    process.env.CURSOR_API_KEY = 'test-key';
    const thread = await createThread('developer-1', baseKickoff(), {
      skipAutoKickoff: true,
    });
    thread.groundingMode = 'remote';
    thread.groundedSha = null;

    try {
      // When sendMessage acquires repository grounding for the turn.
      await expect(
        sendMessage(thread.id, 'Continue from the grounded repository')
      ).rejects.toBe(stopAfterClassification);

      // Then that exact selection is converted and evaluated once against storage.
      expect(mockCallerGroundingStart).toHaveBeenCalledTimes(1);
      expect(mockCallerGroundingSelectionToBinding).toHaveBeenCalledTimes(1);
      expect(mockCallerGroundingSelectionToBinding).toHaveBeenCalledWith(
        selection
      );
      expect(mockEvaluateBindingContinuity).toHaveBeenCalledTimes(1);
      expect(mockEvaluateBindingContinuity).toHaveBeenCalledWith(
        { mode: 'remote', sha: null },
        resolved
      );
    } finally {
      delete process.env.CURSOR_API_KEY;
      await closeThread(thread.id);
    }
  });

  it.each([
    ['created', 'new-agent', { mode: 'local' as const, sha: 'sha-new' }],
    ['recreated', 'replacement-agent', { mode: 'remote' as const, sha: null }],
  ] as const)(
    'BR-006 atomically persists %s agent identity with its resolved binding',
    async (mode, agentId, resolvedBinding) => {
      // Given SDK acquisition created an identity for the exact resolved binding.
      const thread = chatThread({
        cursorAgentId: mode === 'recreated' ? 'stale-agent' : undefined,
        groundingMode: mode === 'recreated' ? 'local' : undefined,
        groundedSha: mode === 'recreated' ? 'sha-stale' : null,
      });

      // When the acquisition result is persisted.
      await persistCreatedAgentBinding(
        thread,
        { agentId },
        mode,
        resolvedBinding
      );

      // Then one upsert carries identity and both binding fields together.
      expect(mockPgUpsertThread).toHaveBeenCalledTimes(1);
      expect(mockPgUpsertThread).toHaveBeenCalledWith(
        expect.objectContaining({
          cursorAgentId: agentId,
          groundingMode: resolvedBinding.mode,
          groundedSha: resolvedBinding.sha,
        })
      );
    }
  );

  it('BR-006 does not launder a mismatched stored binding on resumed acquisition', async () => {
    // Given SDK resume succeeds while the retained decision identifies a SHA boundary.
    const thread = chatThread({
      cursorAgentId: 'existing-agent',
      groundingMode: 'local',
      groundedSha: 'sha-stored',
    });

    // When FEAT-002 observes a resumed acquisition before FEAT-003 routing exists.
    await persistCreatedAgentBinding(
      thread,
      { agentId: 'existing-agent' },
      'resumed',
      { mode: 'local', sha: 'sha-resolved' }
    );

    // Then no write replaces the mismatched persisted binding.
    expect(mockPgUpsertThread).not.toHaveBeenCalled();
    expect(thread).toEqual(
      expect.objectContaining({
        cursorAgentId: 'existing-agent',
        groundingMode: 'local',
        groundedSha: 'sha-stored',
      })
    );
  });
});

describe('FEAT-003 grounding-bound lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('PBI-003 AC-0 / TBI-004 DoD-0 keeps matching bindings resume-safe', () => {
    expect(
      selectGroundingBoundaryRecreation({
        lifecycleEnabled: true,
        hasAgentIdentity: true,
        decision: { decision: 'resume' },
      })
    ).toBeNull();
  });

  it.each([
    'legacy-binding-missing',
    'binding-malformed',
    'mode-changed',
    'sha-changed',
  ] as const)(
    'PBI-003 AC-1 / AC-2 / BR-003 selects recreation for %s',
    (reason) => {
      expect(
        selectGroundingBoundaryRecreation({
          lifecycleEnabled: true,
          hasAgentIdentity: true,
          decision: { decision: 'recreate', reason },
        })
      ).toBe(reason);
    }
  );

  it('TBI-004 DoD-3 / VT-07 suppresses boundary recreation when the flag is OFF', () => {
    expect(
      selectGroundingBoundaryRecreation({
        lifecycleEnabled: false,
        hasAgentIdentity: true,
        decision: { decision: 'recreate', reason: 'mode-changed' },
      })
    ).toBeNull();
  });

  it('PBI-003 AC-2 treats a new unbound thread as creation, not recreation', () => {
    expect(
      selectGroundingBoundaryRecreation({
        lifecycleEnabled: true,
        hasAgentIdentity: false,
        decision: {
          decision: 'recreate',
          reason: 'legacy-binding-missing',
        },
      })
    ).toBeNull();
  });

  it('PBI-003 AC-2 / BR-002 settles a persisted legacy boundary for later resume', () => {
    const state = {
      bindingContinuity: {
        decision: 'recreate' as const,
        reason: 'legacy-binding-missing' as const,
      },
    };

    settleGroundingContinuityAfterBindingWrite(state);

    expect(state.bindingContinuity).toEqual({ decision: 'resume' });
  });

  it('PBI-003 AC-1 / TBI-004 DoD-1 force-creates without resuming the stale identity', async () => {
    const resume = jest.fn();
    const create = jest
      .fn()
      .mockResolvedValue({ agentId: 'replacement-agent' });

    const result = await resumeOrCreateAgent({
      cursorAgentId: 'stale-agent',
      forceRecreate: true,
      resume,
      create,
    });

    expect(resume).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      agent: { agentId: 'replacement-agent' },
      mode: 'recreated',
    });
  });

  it('PBI-003 AC-3 / TBI-004 DoD-2 keeps transient retries resume-first', async () => {
    const transient = new Error('temporary stream reset');
    const resume = jest.fn().mockRejectedValue(transient);

    await expect(resumePinnedTurnAgent(resume)).rejects.toBe(transient);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('TBI-004 DoD-0 releases stale grounding so recovery reacquires and reevaluates', async () => {
    const release = jest.fn().mockResolvedValue(undefined);
    const state = {
      grounding: {
        mode: 'remote' as const,
        release,
      },
      resolvedGroundingBinding: { mode: 'remote' as const, sha: null },
      bindingContinuity: { decision: 'resume' as const },
      groundingWorkspaceDir: '/tmp/grounded',
    };

    await releaseGroundingForStaleRecovery(state);

    expect(release).toHaveBeenCalledTimes(1);
    expect(state).toEqual({
      grounding: null,
      resolvedGroundingBinding: null,
      bindingContinuity: null,
      groundingWorkspaceDir: null,
    });
  });

  it('PBI-003 AC-3 / BR-007 keeps remote prompts MCP-directed and rejects scratch checkout reads', () => {
    const prompt = buildInitialPrompt(baseKickoff());

    expect(prompt).toContain('isolated sandbox');
    expect(prompt).toContain('must be fetched via MCP');
    expect(prompt).toContain('NOT a clone of the project repo');
    expect(prompt).not.toContain('current working directory IS a git clone');
  });
});

describe('FEAT-005 Wave 2 native-read runtime', () => {
  const pinnedReader = (): jest.Mocked<RepoReader> => ({
    identity: {
      provider: 'github',
      project: 'Apex',
      repo: 'AI-Pilot',
      sha: 'sha-pinned',
    },
    readFile: jest.fn().mockResolvedValue('pinned checkout content'),
    listDir: jest.fn().mockResolvedValue([]),
    searchCode: jest.fn().mockResolvedValue([]),
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('AC-0 / DoD-0 / VT-05 native prompt keeps sandbox cwd and directs reads only through local checkout-backed tools', () => {
    // Given a local turn whose authorized pinned checkout can be read natively.
    const kickoff = baseKickoff({
      skillPath: '.cursor/skills/grill-with-docs/SKILL.md',
    });

    // When the public prompt builder prepares the native prompt variant.
    const prompt = buildInitialPrompt(kickoff, { nativeReads: true });

    // Then sandbox semantics remain explicit and provider repository fetches are forbidden.
    expect(prompt).toContain('isolated sandbox');
    expect(prompt).toContain('local checkout-backed read-only tools');
    expect(prompt).toContain('`get_skill_file`');
    expect(prompt).toContain('`list_repo_dir`');
    expect(prompt).toContain('`search_repo_code`');
    expect(prompt).toContain(
      'Never use the GitHub or ADO provider MCP servers for repository reads'
    );
    expect(prompt).not.toContain('must be fetched via');
    expect(prompt).not.toContain('current working directory IS a git clone');
  });

  it('forbids provider MCP in the prompt when local grounding has no checkout tools', () => {
    const prompt = buildInitialPrompt(
      baseKickoff({ skillPath: '.cursor/skills/grill-with-docs/SKILL.md' }),
      { nativeReads: false, forbidProviderRepoMcp: true }
    );

    expect(prompt).toContain('Do not use the GitHub or ADO provider MCP servers');
    expect(prompt).not.toContain('# MCP tools (github-repo server)');
    expect(prompt).not.toContain('must be fetched via MCP');
  });

  it('directs native-read generation skills to Write .ai-pilot/output, not staging MCP', () => {
    const prompt = buildInitialPrompt(
      baseKickoff({ skillPath: '.cursor/skills/prd-design-spec/SKILL.md' }),
      { nativeReads: true }
    );

    expect(prompt).toContain(
      'Write required output files with the built-in Write / create_file tool'
    );
    expect(prompt).toContain('.ai-pilot/output/');
    expect(prompt).not.toContain('document-staging/write-back MCP tools');
  });

  it('keeps staging MCP instructions for native-read document assistants', () => {
    const prompt = buildInitialPrompt(
      baseKickoff({
        skillPath: '.cursor/skills/prd-design-spec/SKILL.md',
        assistantType: 'design-doc',
        freeformContext: 'doc_id: doc-1\nthread_id: t-1',
      }),
      { nativeReads: true }
    );

    expect(prompt).toContain('document-staging/write-back MCP tools');
    expect(prompt).toContain('Do NOT write proposed design-doc content to `.ai-pilot/output/`');
  });

  it('AC-0 / DoD-4: freezes skill content for local-only worker reads with broad search disabled', async () => {
    const prompt = await buildBackgroundWorkflowPrompt(
      baseKickoff({
        skillPath: '.cursor/skills/to-prd/SKILL.md',
        skillProvider: 'github',
      }),
      'Begin.'
    );

    expect(prompt).toContain('local checkout-backed read-only tools');
    expect(prompt).toContain(
      'Never use the GitHub or ADO provider MCP servers'
    );
    expect(prompt).toContain('Broad search is restricted');
    expect(prompt).toContain('# Pre-loaded skill content');
    expect(prompt).toContain('# Frozen skill content');
    expect(prompt).toContain('Begin.');
    expect(prompt).not.toContain('# MCP tools (github-repo server)');
    expect(prompt).toContain(
      'Write required output files with the built-in Write / create_file tool'
    );
    expect(prompt).not.toContain('document-staging/write-back MCP tools');
  });

  it('does not HTTP-fetch the provider skill catalog when local grounding has no checkout reader', async () => {
    const mockGetSkillFile = getSkillFile as jest.Mock;
    mockGetSkillFile.mockClear();

    const prompt = await buildBackgroundWorkflowPrompt(
      baseKickoff({
        skillPath: '.cursor/skills/prd-design-spec/SKILL.md',
        skillProvider: 'github',
      }),
      'Generate.',
      { skipProviderCatalogFetch: true }
    );

    expect(mockGetSkillFile).not.toHaveBeenCalled();
    expect(prompt).toContain('Load it with `get_skill_file` from the pinned checkout');
    expect(prompt).not.toContain('# Frozen skill content');
    expect(prompt).not.toContain('Skill pre-fetch failed');
    expect(prompt).not.toContain('# MCP tools (github-repo server)');
  });

  it('prepareBackgroundWorkflowTurn skips the provider catalog on local grounding without a reader', async () => {
    const mockGetSkillFile = getSkillFile as jest.Mock;
    mockEvaluateBindingContinuity.mockReset();
    mockEvaluateBindingContinuity.mockReturnValue({ decision: 'resume' });
    mockCallerGroundingSelectionToBinding.mockReturnValue({
      mode: 'local',
      sha: 'sha-gen',
    });
    mockCallerGroundingStart.mockResolvedValue({
      mode: 'local',
      cwd: 'C:\\data\\grounding-workspaces\\gen',
      profileId: 'profile-gen' as GroundingProfileId,
      resolvedSha: 'sha-gen',
      nativeReads: true,
      workingTree: true,
      release: jest.fn().mockResolvedValue(undefined),
    } satisfies CallerGroundingSelection);
    mockResolveConnectionProfile.mockRejectedValue(
      new Error('authorized checkout unavailable')
    );
    const thread = await createThread(
      'developer-1',
      baseKickoff({
        skillPath: '.cursor/skills/prd-design-spec/SKILL.md',
        skillProvider: 'github',
      }),
      { skipAutoKickoff: true }
    );
    mockGetSkillFile.mockClear();

    try {
      const prepared = await prepareBackgroundWorkflowTurn(thread.id, 'Generate.');

      expect(mockGetSkillFile).not.toHaveBeenCalled();
      expect(prepared.prompt).toContain(
        'Load it with `get_skill_file` from the pinned checkout'
      );
      expect(prepared.prompt).not.toContain('# Frozen skill content');
    } finally {
      await closeThread(thread.id);
    }
  });

  it('AC-1 / VT-06 fallback prompt remains sandbox and provider-MCP directed', () => {
    // Given a remote or non-native repository-reading turn.
    const kickoff = baseKickoff();

    // When the existing prompt variant is built without native activation.
    const prompt = buildInitialPrompt(kickoff, { nativeReads: false });

    // Then it retains the current provider-MCP instructions and rejects checkout semantics.
    expect(prompt).toContain('isolated sandbox');
    expect(prompt).toContain('must be fetched via MCP');
    expect(prompt).toContain('NOT a clone of the project repo');
    expect(prompt).not.toContain('local checkout-backed read-only tools');
  });

  it('does not advertise ado-skills read tools in ADO free-chat under native reads', () => {
    // Given a plain (no-skill) ADO chat with native reads engaged.
    const kickoff = baseKickoff({ skillProvider: 'ado', repo: 'Apex' });

    // When the free-chat prompt is built.
    const prompt = buildInitialPrompt(kickoff, { nativeReads: true });

    // Then reads are directed at the local checkout tools and the de-mounted
    // ado-skills repo-read tools are neither advertised nor invoked via get_skill.
    expect(prompt).toContain('local checkout-backed read-only tools');
    expect(prompt).not.toContain(
      '# Available MCP tools (via `ado-skills` server)'
    );
    expect(prompt).not.toContain('call `get_skill`');
  });

  it('AC-0 / DoD-0 / DoD-1 / BR-009 / BR-010 / VT-07 wires the exact pinned reader while retaining staging MCP', async () => {
    // Given native reads are authorized for one SHA-pinned GitHub grounding profile.
    const reader = pinnedReader();
    mockResolveConnectionProfile.mockResolvedValue(reader);
    const grounding = {
      mode: 'local',
      cwd: 'C:\\data\\grounding-workspaces\\pinned',
      profileId: 'profile-pinned' as GroundingProfileId,
      resolvedSha: 'sha-pinned',
      nativeReads: true,
      workingTree: true,
      release: jest.fn(),
    } satisfies CallerGroundingSelection;
    const kickoff = baseKickoff({
      assistantType: 'prd',
      freeformContext: 'prd_id: prd-1\nthread_id: thread-1',
    });

    // When the public runtime builder resolves the turn wiring.
    const runtime = await prepareRepositoryReadRuntime({
      grounding,
      kickoff,
      adoSkillsUrl: 'http://localhost:3001/mcp/ado-skills',
      sandboxCwd: 'C:\\sandbox\\thread-1',
    });

    // Then exactly three local tools use that profile, cwd stays sandboxed,
    // provider browse is absent, and document staging remains available.
    expect(mockResolveConnectionProfile).toHaveBeenCalledWith('profile-pinned');
    expect(runtime.nativeReads).toBe(true);
    expect(runtime.local.cwd).toBe('C:\\sandbox\\thread-1');
    expect(Object.keys(runtime.local.customTools ?? {})).toEqual([
      'get_skill_file',
      'list_repo_dir',
      'search_repo_code',
    ]);
    await runtime.local.customTools?.get_skill_file.execute(
      { path: 'src/pinned.ts' },
      {}
    );
    expect(reader.readFile).toHaveBeenCalledWith('src/pinned.ts');
    // Native reads engaged → the read-only github-repo MCP is de-mounted, while
    // ado-skills is retained for PRD write-back with its repo-read tools stripped.
    expect(runtime.mcpServers['github-repo']).toBeUndefined();
    expect(runtime.mcpServers['ado-skills']).toEqual({
      url: 'http://localhost:3001/mcp/ado-skills?enableRepoBrowse=false',
    });
  });

  it('AC-1 / BR-009 / VT-08 fails closed to unchanged provider MCP when the checkout reader is unusable', async () => {
    // Given native activation was selected but the exact authorized reader cannot be resolved.
    mockResolveConnectionProfile.mockRejectedValue(
      new Error('authorized checkout unavailable')
    );
    const grounding = {
      mode: 'local',
      cwd: 'C:\\data\\grounding-workspaces\\missing',
      profileId: 'profile-missing' as GroundingProfileId,
      resolvedSha: 'sha-missing',
      nativeReads: true,
      workingTree: true,
      release: jest.fn(),
    } satisfies CallerGroundingSelection;

    // When runtime wiring is prepared.
    const runtime = await prepareRepositoryReadRuntime({
      grounding,
      kickoff: baseKickoff(),
      adoSkillsUrl: 'http://localhost:3001/mcp/ado-skills',
      sandboxCwd: 'C:\\sandbox\\thread-1',
    });

    // Then no native tool is exposed and provider repo MCP is NOT restored.
    expect(runtime.nativeReads).toBe(false);
    expect(runtime.local).toEqual({ cwd: 'C:\\sandbox\\thread-1' });
    expect(runtime.mcpServers['github-repo']).toBeUndefined();
  });

  it('AC-3 / VT-12 rebuilds prompt, custom tools, and MCP wiring across a SHA-to-remote recreation boundary', async () => {
    // Given the first turn is native at one pinned SHA and the next selection is remote.
    const firstReader = pinnedReader();
    mockResolveConnectionProfile.mockResolvedValue(firstReader);
    const first = await prepareRepositoryReadRuntime({
      grounding: {
        mode: 'local',
        cwd: 'C:\\checkouts\\sha-pinned',
        profileId: 'profile-first' as GroundingProfileId,
        resolvedSha: 'sha-pinned',
        nativeReads: true,
        workingTree: true,
        release: jest.fn(),
      },
      kickoff: baseKickoff(),
      adoSkillsUrl: 'http://localhost:3001/mcp/ado-skills',
      sandboxCwd: 'C:\\sandbox\\thread-1',
    });
    const second = await prepareRepositoryReadRuntime({
      grounding: {
        mode: 'remote',
        release: jest.fn(),
      },
      kickoff: baseKickoff(),
      adoSkillsUrl: 'http://localhost:3001/mcp/ado-skills',
      sandboxCwd: 'C:\\sandbox\\thread-1',
    });

    // When lifecycle recreation prepares the next turn.
    const create = jest.fn().mockResolvedValue(second);
    const acquisition = await resumeOrCreateAgent({
      cursorAgentId: 'stale-native-agent',
      forceRecreate: true,
      resume: jest.fn(),
      create,
    });

    // Then no stale native tool/MCP/prompt state survives into the recreated turn.
    expect(first.local.customTools).toBeDefined();
    // Native turn de-mounts the read-only github-repo MCP entirely...
    expect(first.mcpServers['github-repo']).toBeUndefined();
    expect(second.local.customTools).toBeUndefined();
    // ...and the remote recreation restores it.
    expect(second.mcpServers['github-repo']).toBeDefined();
    expect(
      buildInitialPrompt(baseKickoff(), { nativeReads: first.nativeReads })
    ).toContain('local checkout-backed read-only tools');
    expect(
      buildInitialPrompt(baseKickoff(), { nativeReads: second.nativeReads })
    ).toContain('must be fetched via MCP');
    expect(acquisition).toEqual({ agent: second, mode: 'recreated' });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

// ── closeThread — thread retention ────────────────────────────────────────────

describe('closeThread — thread retention', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockIsThreadRunAlive.mockResolvedValue(false);
    mockDb.query.prds.findFirst.mockResolvedValue(null);
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('does not delete the chat_threads row when the thread is interview-backed', async () => {
    const thread = await createThread(
      'user-1',
      { project: 'proj', repo: 'org/repo', branch: 'main' },
      { skipAutoKickoff: true }
    );
    markAsInterviewThread(thread.id);

    await closeThread(thread.id);

    expect(mockPgDeleteThread).not.toHaveBeenCalled();
  });

  it('does not delete the chat_threads row when the thread backs a PRD', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue({ id: 'prd-1' });

    const thread = await createThread(
      'user-1',
      { project: 'proj', repo: 'org/repo', branch: 'main' },
      { skipAutoKickoff: true }
    );

    await closeThread(thread.id);

    expect(mockPgDeleteThread).not.toHaveBeenCalled();
  });

  it('does not delete the chat_threads row when the thread backs a design doc', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue({ id: 'dd-1' });

    const thread = await createThread(
      'user-1',
      { project: 'proj', repo: 'org/repo', branch: 'main' },
      { skipAutoKickoff: true }
    );

    await closeThread(thread.id);

    expect(mockPgDeleteThread).not.toHaveBeenCalled();
  });

  it('upserts with status=closed for a standalone thread (never deletes)', async () => {
    const thread = await createThread(
      'user-1',
      { project: 'proj', repo: 'org/repo', branch: 'main' },
      { skipAutoKickoff: true }
    );

    await closeThread(thread.id);

    expect(mockPgDeleteThread).not.toHaveBeenCalled();
    expect(mockPgUpsertThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: thread.id, status: 'closed' })
    );
  });

  it('DoD-2 keeps the profile checkout runtime-only without copying sandbox inputs into it', async () => {
    // Arrange
    const mockedFs = jest.requireMock('fs') as {
      cpSync: jest.Mock;
      rmSync: jest.Mock;
    };
    const thread = await createThread(
      'user-1',
      { project: 'proj', repo: 'org/repo', branch: 'main' },
      { skipAutoKickoff: true }
    );
    const scratchWorkspace = thread.workspaceDir;
    const profileCheckout = '/tmp/test-data/grounding-workspaces/opaque';

    // Act
    await closeThread(thread.id);

    // Assert
    expect(thread.workspaceDir).toBe(scratchWorkspace);
    expect(mockPgUpsertThread).not.toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: profileCheckout })
    );
    expect(mockedFs.cpSync).not.toHaveBeenCalled();
    expect(mockedFs.rmSync).toHaveBeenCalledWith(scratchWorkspace, {
      recursive: true,
      force: true,
    });
    expect(mockedFs.rmSync).not.toHaveBeenCalledWith(
      profileCheckout,
      expect.anything()
    );
  });

  it('does not delete the generation workspace while a worker run is still alive', async () => {
    mockIsThreadRunAlive.mockResolvedValue(true);
    const mockedFs = jest.requireMock('fs') as { rmSync: jest.Mock };
    const thread = await createThread(
      'user-1',
      { project: 'proj', repo: 'org/repo', branch: 'main' },
      { skipAutoKickoff: true }
    );
    mockedFs.rmSync.mockClear();

    await closeThread(thread.id);

    expect(mockedFs.rmSync).not.toHaveBeenCalled();
    expect(mockPgUpsertThread).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: thread.id, status: 'closed' })
    );
  });

  it('is a no-op for a thread ID that no longer exists in memory or DB', async () => {
    await closeThread('nonexistent-thread-id');

    expect(mockPgDeleteThread).not.toHaveBeenCalled();
  });
});

// ── permanentlyDeleteThread ───────────────────────────────────────────────────

describe('permanentlyDeleteThread', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockDb.query.prds.findFirst.mockResolvedValue(null);
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('calls pgDeleteThread for explicit user deletion', async () => {
    const thread = await createThread(
      'user-1',
      { project: 'proj', repo: 'org/repo', branch: 'main' },
      { skipAutoKickoff: true }
    );

    await permanentlyDeleteThread(thread.id);

    expect(mockPgDeleteThread).toHaveBeenCalledWith(thread.id);
  });

  it('calls pgDeleteThread even for a thread not in memory', async () => {
    await permanentlyDeleteThread('nonexistent-thread-id');

    expect(mockPgDeleteThread).toHaveBeenCalledWith('nonexistent-thread-id');
  });
});

// ── markAsInterviewThread ─────────────────────────────────────────────────────

describe('markAsInterviewThread', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockDb.query.prds.findFirst.mockResolvedValue(null);
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('marks the thread so closeThread skips DB deletion', async () => {
    const thread = await createThread(
      'user-1',
      { project: 'proj', repo: 'org/repo', branch: 'main' },
      { skipAutoKickoff: true }
    );

    markAsInterviewThread(thread.id);
    await closeThread(thread.id);

    expect(mockPgDeleteThread).not.toHaveBeenCalled();
  });

  it('is idempotent — calling it twice does not throw', async () => {
    const thread = await createThread(
      'user-1',
      { project: 'proj', repo: 'org/repo', branch: 'main' },
      { skipAutoKickoff: true }
    );

    expect(() => {
      markAsInterviewThread(thread.id);
      markAsInterviewThread(thread.id);
    }).not.toThrow();

    await closeThread(thread.id);
    expect(mockPgDeleteThread).not.toHaveBeenCalled();
  });

  it('is a no-op for a thread ID not present in memory', () => {
    expect(() => markAsInterviewThread('ghost-thread')).not.toThrow();
  });
});

function baseKickoff(
  overrides: Partial<ChatThreadKickoff> = {}
): ChatThreadKickoff {
  return {
    project: 'Apex',
    repo: 'org/AI-Pilot',
    branch: 'main',
    skillProvider: 'github',
    ...overrides,
  };
}

describe('document assistant MCP wiring', () => {
  it.each([
    ['local', 'opaque-profile'],
    ['remote', undefined],
  ] as const)(
    'AC-2 / VT-05 / VT-06 preserves repository and staging MCP boundaries for %s profile',
    (_profile, groundingProfileId) => {
      // Given the same PRD assistant runs with a local-backed or remote profile.
      const servers = buildMcpServers(
        baseKickoff({
          assistantType: 'prd',
          freeformContext: 'prd_id: prd-1\nthread_id: thread-1',
        }),
        'http://localhost:3001/mcp/ado-skills',
        {
          groundingProfileId: groundingProfileId as
            | import('../../shared/types/repoReader').GroundingProfileId
            | undefined,
        }
      );

      // When its repository and document-staging transports are assembled.
      // Then both remain MCP URLs, with only local mode carrying the opaque profile.
      expect(servers['github-repo']).toEqual({
        url: groundingProfileId
          ? 'http://localhost:3001/mcp/github-repo/grounding/opaque-profile'
          : 'http://localhost:3001/mcp/github-repo',
      });
      expect(servers['ado-skills']).toEqual({
        url: groundingProfileId
          ? 'http://localhost:3001/mcp/ado-skills/grounding/opaque-profile'
          : 'http://localhost:3001/mcp/ado-skills',
      });
      expect(
        buildDocumentAssistantEditGuidance(
          baseKickoff({
            assistantType: 'prd',
            freeformContext: 'prd_id: prd-1\nthread_id: thread-1',
          })
        ).join('\n')
      ).toContain('update_prd');
    }
  );

  it('AC-3 / VT-07 adds no Apex native-read wiring for conversational or design agents', () => {
    // Given SDK 1.0.24 is installed without a completed native-read capability proof.
    const conversational = buildMcpServers(
      baseKickoff(),
      'http://localhost:3001/mcp/ado-skills'
    );
    const design = buildMcpServers(
      baseKickoff({
        assistantType: 'design-doc',
        freeformContext: 'doc_id: doc-1\nthread_id: thread-1',
      }),
      'http://localhost:3001/mcp/ado-skills'
    );

    // When the observable Apex repository transports are inspected.
    // Then this phase adds only URL-based MCP configuration. Host-level native
    // tool denial is the separate real-runtime capability gate in FEAT-005.
    expect(conversational).toEqual({
      'github-repo': { url: 'http://localhost:3001/mcp/github-repo' },
    });
    expect(design).toEqual({
      'github-repo': { url: 'http://localhost:3001/mcp/github-repo' },
      'ado-skills': { url: 'http://localhost:3001/mcp/ado-skills' },
    });
    expect(JSON.stringify({ conversational, design })).not.toMatch(
      /native|shell|read_file|search_files/i
    );
  });

  it.each([
    [{ assistantType: 'adr' as const }, 'interview'],
    [{ assistantType: 'prd' as const }, 'prd'],
    [{ assistantType: 'design-doc' as const }, 'design-doc'],
    [{ skillPath: '.cursor/skills/grill-with-docs/SKILL.md' }, 'interview'],
    [{ skillPath: '.cursor/skills/kick-off/SKILL.md' }, 'interview'],
    [{ skillPath: '.cursor/skills/to-prd/SKILL.md' }, 'prd'],
    [{ skillPath: '.cursor/skills/prd-spec-review/SKILL.md' }, 'prd'],
    [{ skillPath: '.cursor/skills/prd-design-spec/SKILL.md' }, 'design-doc'],
    [
      { skillPath: '.cursor/skills/walkthrough-generation/SKILL.md' },
      'walkthrough',
    ],
    [
      { skillPath: '.cursor/skills/design-module-doc/SKILL.md' },
      'design-module',
    ],
    [{}, 'agent-home'],
  ])(
    'AC-0 identifies centralized chat cohort %s as %s',
    (overrides, expectedCaller) => {
      expect(resolveGroundingCallerKey(baseKickoff(overrides))).toBe(
        expectedCaller
      );
    }
  );

  it.each([
    [
      { isInterviewThread: true, assistantType: 'prd' as const },
      'interview',
    ],
    [{ assistantType: 'prd' as const }, 'assistant'],
    [{ assistantType: 'design-doc' as const }, 'assistant'],
    [{ skillPath: '.cursor/skills/adr-finalize/SKILL.md' }, 'adr'],
    [{ isDevSession: true }, 'assistant'],
    [{}, 'home-chat'],
  ])(
    'routes interactive class %j as %s',
    (
      overrides: {
        isInterviewThread?: boolean;
        isDevSession?: boolean;
        assistantType?: 'prd' | 'design-doc';
        skillPath?: string;
      },
      expected
    ) => {
      expect(
        resolveInteractiveWorkflowClass({
          isInterviewThread: Boolean(overrides.isInterviewThread),
          isDevSession: Boolean(overrides.isDevSession),
          thread: {
            kickoff: baseKickoff({
              assistantType: overrides.assistantType,
              skillPath: overrides.skillPath,
            }),
          },
        } as Parameters<typeof resolveInteractiveWorkflowClass>[0]),
      ).toBe(expected);
    }
  );

  it('AC-0 pins chat caller grounding to skillBranch before branch', async () => {
    // Given the skills contract selects a different branch than the runtime branch.
    const stopAfterGrounding = new Error('stop after grounding selection');
    mockCallerGroundingStart.mockRejectedValueOnce(stopAfterGrounding);
    process.env.CURSOR_API_KEY = 'test-key';
    const thread = await createThread(
      'developer-1',
      baseKickoff({
        branch: 'runtime-branch',
        skillBranch: 'skills-snapshot',
      }),
      { skipAutoKickoff: true }
    );

    try {
      // When the first chat turn selects its shared caller grounding.
      await expect(
        sendMessage(thread.id, 'Read the selected skill snapshot')
      ).rejects.toBe(stopAfterGrounding);

      // Then the pin uses the same skillBranch ?? branch contract as prompt/preload.
      expect(mockCallerGroundingStart).toHaveBeenCalledWith(
        expect.objectContaining({
          caller: 'agent-home',
          repository: {
            provider: 'github',
            repo: 'org/AI-Pilot',
            branch: 'skills-snapshot',
          },
        })
      );
      const provisionalInsert = mockDb.insert.mock.results[0].value as {
        values: jest.Mock;
      };
      expect(provisionalInsert.values).toHaveBeenCalledWith(
        expect.objectContaining({
          progressLabel: 'Preparing the latest repository requirements…',
          status: 'queued',
        })
      );
    } finally {
      delete process.env.CURSOR_API_KEY;
      await closeThread(thread.id);
    }
  });

  it('broadcasts user message before grounding completes', async () => {
    // Given a thread that has been idle and grounding is slow.
    const groundingStarted = { value: false };
    const { insertMessage: mockPgInsertMessage } = jest.requireMock(
      '../services/chatThreadRepository'
    ) as {
      insertMessage: jest.Mock;
    };
    mockPgInsertMessage.mockClear();

    // Track ordering: was the message persisted before grounding started?
    let messagePersisted = false;
    let messagePersistedBeforeGrounding = false;
    mockPgInsertMessage.mockImplementation(async () => {
      messagePersisted = true;
    });

    // Grounding will resolve after a tick, letting us observe the order.
    mockCallerGroundingStart.mockImplementation(async () => {
      groundingStarted.value = true;
      messagePersistedBeforeGrounding = messagePersisted;
      // Return a valid selection but throw downstream so the test
      // doesn't need the full agent lifecycle mocked.
      return {
        mode: 'remote' as const,
        release: jest.fn().mockResolvedValue(undefined),
      } satisfies CallerGroundingSelection;
    });
    const resolved = { mode: 'remote' as const, sha: null };
    mockCallerGroundingSelectionToBinding.mockReturnValue(resolved);
    // Throw after grounding to short-circuit before agent acquisition.
    const stopAfterBinding = new Error('stop after binding');
    mockEvaluateBindingContinuity.mockImplementation(() => {
      throw stopAfterBinding;
    });

    process.env.CURSOR_API_KEY = 'test-key';
    const thread = await createThread('developer-1', baseKickoff(), {
      skipAutoKickoff: true,
    });

    try {
      await expect(sendMessage(thread.id, 'Hello after idle')).rejects.toBe(
        stopAfterBinding
      );

      // Then the user message was persisted (via pgInsertMessage) before
      // ensureThreadGrounding ran.
      expect(groundingStarted.value).toBe(true);
      expect(messagePersistedBeforeGrounding).toBe(true);
      expect(mockPgInsertMessage).toHaveBeenCalledWith(
        thread.id,
        expect.objectContaining({ role: 'user', text: 'Hello after idle' })
      );
    } finally {
      delete process.env.CURSOR_API_KEY;
      await closeThread(thread.id);
    }
  });

  it('PLAN-S3-AC-4 promotes the same persisted turn after preparing without duplicating the user message', async () => {
    jest.useFakeTimers();
    const { insertMessage: mockPgInsertMessage } = jest.requireMock(
      '../services/chatThreadRepository'
    ) as {
      insertMessage: jest.Mock;
    };
    mockPgInsertMessage.mockClear();
    mockCallerGroundingStart.mockReset();
    let markCheckoutReady!: () => void;
    const checkoutReady = new Promise<void>((resolve) => {
      markCheckoutReady = resolve;
    });
    const waitUntilReady = jest.fn(() => checkoutReady);
    mockCallerGroundingStart
      .mockResolvedValueOnce({
        mode: 'preparing',
        retryAfterMs: 1_000,
        waitUntilReady,
        release: jest.fn().mockResolvedValue(undefined),
      })
      .mockResolvedValueOnce({
        mode: 'remote',
        release: jest.fn().mockResolvedValue(undefined),
      });
    mockCallerGroundingSelectionToBinding.mockReturnValue({
      mode: 'remote',
      sha: null,
    });
    const stopAfterPromotion = new Error('stop after promotion');
    mockEvaluateBindingContinuity.mockImplementation(() => {
      throw stopAfterPromotion;
    });
    process.env.CURSOR_API_KEY = 'test-key';
    const thread = await createThread('developer-1', baseKickoff(), {
      skipAutoKickoff: true,
    });
    const events: Array<{ type: string; status?: string }> = [];
    const unsubscribe = subscribeToThread(thread.id, (event) => {
      events.push(event);
    });

    try {
      const sending = sendMessage(thread.id, 'Keep this turn pending');
      const expectedRejection =
        expect(sending).rejects.toBe(stopAfterPromotion);
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(0);
      expect(waitUntilReady).toHaveBeenCalledTimes(1);
      markCheckoutReady();
      await jest.advanceTimersByTimeAsync(0);
      await expectedRejection;

      expect(mockCallerGroundingStart).toHaveBeenCalledTimes(2);
      expect(mockPgInsertMessage).toHaveBeenCalledTimes(1);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'grounding',
            status: 'preparing',
          }),
        ])
      );
    } finally {
      unsubscribe();
      delete process.env.CURSOR_API_KEY;
      await closeThread(thread.id);
      jest.useRealTimers();
    }
  });

  it('persists the user message before dispatching an interactive actor turn', async () => {
    const { insertMessage: mockPgInsertMessage } = jest.requireMock(
      '../services/chatThreadRepository'
    ) as {
      insertMessage: jest.Mock;
    };
    const originalFetch = global.fetch;
    process.env.AI_RUNS_INTERACTIVE_DISPATCH_URL = 'https://interactive.test';
    mockIsFeatureEnabled.mockImplementation(
      async (key: string) => key === 'ai-runs-interactive'
    );
    mockPgInsertMessage.mockClear();
    mockPgUpsertThread.mockClear();
    mockEnqueueAgentRun.mockResolvedValue({ runId: 'interactive-run-1' });
    mockInteractiveWorkflowRoute.mockImplementation(
      async (input: {
        dispatchToActor(dispatch: {
          runId: string;
          dispatchMessageId: string;
        }): Promise<void>;
      }) => {
        await input.dispatchToActor({
          runId: 'interactive-run-1',
          dispatchMessageId: 'dispatch-1',
        });
        return {
          route: 'actor',
          runId: 'interactive-run-1',
          dispatchMessageId: 'dispatch-1',
          slot: 'reserved',
        };
      }
    );
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accepted: true }),
    }) as unknown as typeof fetch;
    const repoReader: RepoReader = {
      identity: {
        provider: 'github',
        project: 'Apex',
        repo: 'AI-Pilot',
        sha: 'interactive-sha',
      },
      readFile: jest.fn().mockResolvedValue('# repository context'),
      listDir: jest.fn().mockResolvedValue([]),
      searchCode: jest.fn().mockResolvedValue([]),
    };
    mockCallerGroundingStart.mockResolvedValue({
      mode: 'local',
      cwd: '/tmp/interactive-checkout',
      profileId: 'interactive-profile' as GroundingProfileId,
      resolvedSha: 'interactive-sha',
      nativeReads: true,
      workingTree: true,
      release: jest.fn().mockResolvedValue(undefined),
    });
    mockResolveConnectionProfile.mockResolvedValue(repoReader);
    mockCallerGroundingSelectionToBinding.mockReturnValue({
      mode: 'local',
      sha: 'interactive-sha',
    });
    mockEvaluateBindingContinuity.mockReturnValue({
      decision: 'recreate',
      reason: 'legacy-binding-missing',
    });

    const thread = await createThread('developer-1', baseKickoff(), {
      skipAutoKickoff: true,
    });

    try {
      await sendMessage(thread.id, 'A simple UI counter');

      expect(mockPgInsertMessage).toHaveBeenCalledTimes(1);
      expect(mockPgInsertMessage).toHaveBeenCalledWith(
        thread.id,
        expect.objectContaining({
          role: 'user',
          text: 'A simple UI counter',
        })
      );
      expect(mockPgUpsertThread).toHaveBeenLastCalledWith(
        expect.objectContaining({
          id: thread.id,
          status: 'running',
          activeRunId: 'interactive-run-1',
        })
      );
      expect(global.fetch).toHaveBeenCalledWith(
        'https://interactive.test/dispatch',
        expect.objectContaining({ method: 'POST' })
      );
    } finally {
      global.fetch = originalFetch;
      delete process.env.AI_RUNS_INTERACTIVE_DISPATCH_URL;
      mockIsFeatureEnabled.mockReset();
      mockIsFeatureEnabled.mockResolvedValue(false);
      mockInteractiveWorkflowRoute.mockReset();
      mockEnqueueAgentRun.mockReset();
      await closeThread(thread.id);
      mockCallerGroundingStart.mockReset();
      mockResolveConnectionProfile.mockReset();
      mockCallerGroundingSelectionToBinding.mockReset();
      mockEvaluateBindingContinuity.mockReset();
    }
  });

  it('dispatches interactive turns from a bare mirror when the worker can read it', async () => {
    const { insertMessage: mockPgInsertMessage } = jest.requireMock(
      '../services/chatThreadRepository'
    ) as {
      insertMessage: jest.Mock;
    };
    const originalFetch = global.fetch;
    process.env.AI_RUNS_INTERACTIVE_DISPATCH_URL = 'https://interactive.test';
    mockIsFeatureEnabled.mockImplementation(
      async (key: string) => key === 'ai-runs-interactive'
    );
    mockPgInsertMessage.mockClear();
    mockEnqueueAgentRun.mockResolvedValue({ runId: 'interactive-run-2' });
    mockInteractiveWorkflowRoute.mockImplementation(
      async (input: {
        dispatchToActor(dispatch: {
          runId: string;
          dispatchMessageId: string;
        }): Promise<void>;
      }) => {
        await input.dispatchToActor({
          runId: 'interactive-run-2',
          dispatchMessageId: 'dispatch-2',
        });
        return {
          route: 'actor',
          runId: 'interactive-run-2',
          dispatchMessageId: 'dispatch-2',
          slot: 'reserved',
        };
      }
    );
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accepted: true }),
    }) as unknown as typeof fetch;
    const repoReader: RepoReader = {
      identity: {
        provider: 'github',
        project: 'Apex',
        repo: 'AI-Pilot',
        sha: 'interactive-sha',
      },
      readFile: jest.fn().mockResolvedValue('# repository context'),
      listDir: jest.fn().mockResolvedValue([]),
      searchCode: jest.fn().mockResolvedValue([]),
    };
    mockCallerGroundingStart.mockResolvedValue({
      mode: 'local',
      cwd: '/tmp/interactive-sandbox',
      profileId: 'interactive-profile' as GroundingProfileId,
      resolvedSha: 'interactive-sha',
      nativeReads: true,
      workingTree: false,
      mirrorPath: 'C:\\repo-cache\\apex.git',
      release: jest.fn().mockResolvedValue(undefined),
    });
    mockResolveConnectionProfile.mockResolvedValue(repoReader);
    mockCallerGroundingSelectionToBinding.mockReturnValue({
      mode: 'local',
      sha: 'interactive-sha',
    });
    mockEvaluateBindingContinuity.mockReturnValue({
      decision: 'recreate',
      reason: 'legacy-binding-missing',
    });

    const thread = await createThread('developer-1', baseKickoff(), {
      skipAutoKickoff: true,
    });

    try {
      await sendMessage(thread.id, 'A simple UI counter');

      expect(mockEnqueueAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshot: expect.objectContaining({
            workspaceRef: '/tmp/interactive-sandbox',
            mirrorRef: 'C:\\repo-cache\\apex.git',
            groundedSha: 'interactive-sha',
            repository: 'AI-Pilot',
            provider: 'github',
          }),
        }),
      );
      expect(global.fetch).toHaveBeenCalledWith(
        'https://interactive.test/dispatch',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      global.fetch = originalFetch;
      delete process.env.AI_RUNS_INTERACTIVE_DISPATCH_URL;
      mockIsFeatureEnabled.mockReset();
      mockIsFeatureEnabled.mockResolvedValue(false);
      mockInteractiveWorkflowRoute.mockReset();
      mockEnqueueAgentRun.mockReset();
      await closeThread(thread.id);
      mockCallerGroundingStart.mockReset();
      mockResolveConnectionProfile.mockReset();
      mockCallerGroundingSelectionToBinding.mockReset();
      mockEvaluateBindingContinuity.mockReset();
    }
  });

  it('keeps workspace-bound file-output skills on the in-process path when interactive is enabled', async () => {
    const originalFetch = global.fetch;
    process.env.AI_RUNS_INTERACTIVE_DISPATCH_URL = 'https://interactive.test';
    process.env.CURSOR_API_KEY = 'test-key';
    mockIsFeatureEnabled.mockImplementation(
      async (key: string) => key === 'ai-runs-interactive'
    );
    mockInteractiveWorkflowRoute.mockClear();
    global.fetch = jest.fn() as unknown as typeof fetch;

    // Short-circuit the in-process path after interactive bypass is decided.
    const stopAfterBinding = new Error('stop after binding');
    mockCallerGroundingStart.mockResolvedValue({
      mode: 'remote' as const,
      release: jest.fn().mockResolvedValue(undefined),
    });
    mockCallerGroundingSelectionToBinding.mockReturnValue({
      mode: 'remote',
      sha: null,
    });
    mockEvaluateBindingContinuity.mockImplementation(() => {
      throw stopAfterBinding;
    });

    const thread = await createThread(
      'developer-1',
      baseKickoff({
        skillPath: '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
        freeformContext: '## Candidates\n[]',
      }),
      { skipAutoKickoff: true }
    );

    try {
      await expect(sendMessage(thread.id, 'Begin.')).rejects.toBe(
        stopAfterBinding
      );
      expect(mockInteractiveWorkflowRoute).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
      delete process.env.AI_RUNS_INTERACTIVE_DISPATCH_URL;
      delete process.env.CURSOR_API_KEY;
      mockIsFeatureEnabled.mockReset();
      mockIsFeatureEnabled.mockResolvedValue(false);
      mockInteractiveWorkflowRoute.mockReset();
      await closeThread(thread.id);
      mockCallerGroundingStart.mockReset();
      mockCallerGroundingSelectionToBinding.mockReset();
      mockEvaluateBindingContinuity.mockReset();
    }
  });

  it('AC-0 skips shared repository grounding for calendar-only assistants', () => {
    // Given the calendar assistant builds only its restricted calendar MCP server.
    const kickoff = baseKickoff({
      assistantType: 'calendar-work-item',
      calendarAssistantSessionId: 'calendar-session-1',
    });
    const servers = buildMcpServers(
      kickoff,
      'http://localhost:3001/mcp/ado-skills',
      { calendarSessionId: 'calendar-session-1' }
    );

    // When chat decides whether this caller needs shared repository grounding.
    const repositoryReading = isRepositoryReadingChatCaller(kickoff, false);

    // Then no repository profile is started for the calendar-only MCP contract.
    expect(Object.keys(servers)).toEqual(['calendar-assistant']);
    expect(repositoryReading).toBe(false);
  });

  it('AC-0 keeps normal GitHub and ADO chat callers repository-reading', () => {
    expect(isRepositoryReadingChatCaller(baseKickoff(), false)).toBe(true);
    expect(
      isRepositoryReadingChatCaller(
        baseKickoff({
          skillProvider: 'ado',
          repo: 'Apex',
        }),
        false
      )
    ).toBe(true);
    expect(isRepositoryReadingChatCaller(baseKickoff(), true)).toBe(false);
  });

  it('identifies ADR / PRD / design-doc assistant types', () => {
    expect(isDocumentAssistant('adr')).toBe(true);
    expect(isDocumentAssistant('prd')).toBe(true);
    expect(isDocumentAssistant('design-doc')).toBe(true);
    expect(isDocumentAssistant('calendar-work-item')).toBe(false);
    expect(isDocumentAssistant(undefined)).toBe(false);
  });

  it('flags walkthrough and other file-output skills as interactive-ineligible', () => {
    expect(
      isInteractiveWorkspaceBoundSkill(
        '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md'
      )
    ).toBe(true);
    expect(
      isInteractiveWorkspaceBoundSkill(
        '.cursor/skills/walkthrough-generation/SKILL.md'
      )
    ).toBe(true);
    expect(
      isInteractiveWorkspaceBoundSkill(
        '.cursor/skills/walkthrough-anchor-discovery/SKILL.md'
      )
    ).toBe(true);
    expect(
      isInteractiveWorkspaceBoundSkill(
        '.cursor/skills/k6-load-test-generation/SKILL.md'
      )
    ).toBe(true);
    expect(
      isInteractiveWorkspaceBoundSkill(
        '.cursor/skills/design-module-scoping/SKILL.md'
      )
    ).toBe(true);
    expect(
      isInteractiveWorkspaceBoundSkill('.cursor/skills/to-prd/SKILL.md')
    ).toBe(true);
    expect(
      isInteractiveWorkspaceBoundSkill(
        '.cursor/skills/create-test-case/SKILL.md'
      )
    ).toBe(true);
    expect(
      isInteractiveWorkspaceBoundSkill(
        '.cursor/skills/prd-design-spec/SKILL.md'
      )
    ).toBe(true);
    expect(
      isInteractiveWorkspaceBoundSkill('.cursor/skills/adr-finalize/SKILL.md')
    ).toBe(true);
    expect(
      isInteractiveWorkspaceBoundSkill(
        '.cursor/skills/prd-spec-review/SKILL.md'
      )
    ).toBe(true);
    expect(
      isInteractiveWorkspaceBoundSkill(
        '.cursor/skills/grill-with-docs/SKILL.md'
      )
    ).toBe(false);
    expect(isInteractiveWorkspaceBoundSkill(undefined)).toBe(false);
  });

  it('infers document assistant type from freeform context markers', () => {
    expect(
      resolveDocumentAssistantType(
        baseKickoff({
          freeformContext:
            '# ADR Assistant Context\nadr_id: adr-1\nthread_id: t-1',
        })
      )
    ).toBe('adr');
    expect(
      resolveDocumentAssistantType(
        baseKickoff({
          freeformContext: 'prd_id: prd-1\nthread_id: t-1',
        })
      )
    ).toBe('prd');
    expect(
      resolveDocumentAssistantType(
        baseKickoff({
          freeformContext: 'doc_id: doc-1\nthread_id: t-1',
        })
      )
    ).toBe('design-doc');
  });

  it('does not classify validation threads as document assistants', () => {
    const kickoff = baseKickoff({
      freeformContext: [
        'document_operation: validation',
        'prd_id: prd-1',
        'thread_id: validation-thread',
      ].join('\n'),
    });

    expect(resolveDocumentAssistantType(kickoff)).toBeUndefined();
    expect(buildDocumentAssistantEditGuidance(kickoff)).toEqual([]);
    expect(
      buildMcpServers(kickoff, 'http://localhost:3001/mcp/ado-skills')[
        'ado-skills'
      ]
    ).toBeUndefined();
  });

  it('mounts both github-repo and ado-skills for GitHub ADR assistants', () => {
    const servers = buildMcpServers(
      baseKickoff({
        assistantType: 'adr',
        freeformContext: 'adr_id: adr-1\nthread_id: t-1',
      }),
      'http://localhost:3001/mcp/ado-skills'
    );

    expect(servers['github-repo']).toEqual({
      url: 'http://localhost:3001/mcp/github-repo',
    });
    expect(servers['ado-skills']).toEqual({
      url: 'http://localhost:3001/mcp/ado-skills',
    });
  });

  it('mounts ado-skills for GitHub design-doc assistants inferred from freeform context', () => {
    const servers = buildMcpServers(
      baseKickoff({
        freeformContext: 'doc_id: doc-1\nthread_id: t-1',
      }),
      'http://localhost:3001/mcp/ado-skills'
    );

    expect(servers['github-repo']).toBeDefined();
    expect(servers['ado-skills']).toBeDefined();
  });

  it('does not mount ado-skills for plain GitHub free-chat threads', () => {
    const servers = buildMcpServers(
      baseKickoff(),
      'http://localhost:3001/mcp/ado-skills'
    );

    expect(servers['github-repo']).toBeDefined();
    expect(servers['ado-skills']).toBeUndefined();
  });

  it('still mounts only ado-skills for ADO-backed document assistants', () => {
    const servers = buildMcpServers(
      baseKickoff({
        skillProvider: 'ado',
        repo: 'Apex',
        assistantType: 'prd',
        freeformContext: 'prd_id: prd-1\nthread_id: t-1',
      }),
      'http://localhost:3001/mcp/ado-skills'
    );

    expect(servers['github-repo']).toBeUndefined();
    expect(servers['ado-skills']).toBeDefined();
  });

  it('de-mounts github-repo entirely on the native-read success path', () => {
    const servers = buildMcpServers(
      baseKickoff(),
      'http://localhost:3001/mcp/ado-skills',
      { nativeReads: true, enableRepoBrowse: false }
    );

    // GitHub free-chat + native reads → no provider repo-read MCP at all.
    expect(servers['github-repo']).toBeUndefined();
    expect(servers['ado-skills']).toBeUndefined();
  });

  it('PLAN-S4-AC-0 retains ADO work-item/wiki tools while native reads strip repository browsing', () => {
    const servers = buildMcpServers(
      baseKickoff({ skillProvider: 'ado', repo: 'Apex' }),
      'http://localhost:3001/mcp/ado-skills',
      { nativeReads: true, enableRepoBrowse: false }
    );

    expect(servers['github-repo']).toBeUndefined();
    expect(servers['ado-skills']).toEqual({
      url: 'http://localhost:3001/mcp/ado-skills?enableRepoBrowse=false',
    });
  });

  it('PLAN-S4-AC-1 gives native agents explicit checkout provenance', () => {
    const prompt = buildInitialPrompt(
      baseKickoff({ skillProvider: 'ado', repo: 'Platform/MaxView' }),
      {
        nativeReads: true,
        groundingProvenance: {
          storage: 'Azure Files checkout',
          repository: 'Platform/MaxView',
          branch: 'development',
          sha: 'abc123',
        },
      }
    );

    expect(prompt).toContain('Azure Files checkout');
    expect(prompt).toContain('repository: "Platform/MaxView"');
    expect(prompt).toContain('branch: "development"');
    expect(prompt).toContain('pinned SHA: "abc123"');
  });

  it('labels native-read provenance as a bare mirror when there is no working tree', () => {
    const prompt = buildInitialPrompt(
      baseKickoff({ skillProvider: 'ado', repo: 'Platform/MaxView' }),
      {
        nativeReads: true,
        groundingProvenance: {
          storage: 'bare mirror',
          repository: 'Platform/MaxView',
          branch: 'development',
          sha: 'abc123',
        },
      }
    );

    expect(prompt).toContain('bare mirror');
    expect(prompt).not.toContain('Azure Files checkout');
  });

  it('retains ado-skills for document write-back under native reads with repo browse stripped', () => {
    const servers = buildMcpServers(
      baseKickoff({
        assistantType: 'prd',
        freeformContext: 'prd_id: prd-1\nthread_id: t-1',
      }),
      'http://localhost:3001/mcp/ado-skills',
      { nativeReads: true, enableRepoBrowse: false }
    );

    // GitHub PRD assistant: reads go native, write-back stays on ado-skills.
    expect(servers['github-repo']).toBeUndefined();
    expect(servers['ado-skills']).toEqual({
      url: 'http://localhost:3001/mcp/ado-skills?enableRepoBrowse=false',
    });
  });

  it('uses repository MCP profiles without broad code search for interviews', () => {
    const githubServers = buildMcpServers(
      baseKickoff(),
      'http://localhost:3001/mcp/ado-skills',
      { restrictRepoSearch: true }
    );
    expect(githubServers['github-repo']).toEqual({
      url: 'http://localhost:3001/mcp/github-repo?profile=interview',
    });

    const adoServers = buildMcpServers(
      baseKickoff({ skillProvider: 'ado', repo: 'Apex' }),
      'http://localhost:3001/mcp/ado-skills',
      { restrictRepoSearch: true }
    );
    expect(adoServers['ado-skills']).toEqual({
      url: 'http://localhost:3001/mcp/ado-skills?profile=interview',
    });
  });

  it('DoD-2 transports the shared profile on chat-agent MCP URLs', () => {
    const profileId =
      'opaque-profile' as import('../../shared/types/repoReader').GroundingProfileId;
    const githubServers = buildMcpServers(
      baseKickoff(),
      'http://localhost:3001/mcp/ado-skills',
      { groundingProfileId: profileId, restrictRepoSearch: true }
    );
    const adoServers = buildMcpServers(
      baseKickoff({ skillProvider: 'ado', repo: 'Apex' }),
      'http://localhost:3001/mcp/ado-skills',
      { groundingProfileId: profileId, restrictRepoSearch: true }
    );

    expect(githubServers['github-repo']).toEqual({
      url: 'http://localhost:3001/mcp/github-repo/grounding/opaque-profile?profile=interview',
    });
    expect(adoServers['ado-skills']).toEqual({
      url: 'http://localhost:3001/mcp/ado-skills/grounding/opaque-profile?profile=interview',
    });
  });
});

describe('buildDocumentAssistantEditGuidance', () => {
  it('AC-0 / VT-06 keeps update_adr staging reachable for ADR assistants', () => {
    const guidance = buildDocumentAssistantEditGuidance(
      baseKickoff({
        assistantType: 'adr',
        freeformContext: 'adr_id: adr-1\nthread_id: thread-1',
      })
    ).join('\n');

    expect(guidance).toContain('update_adr');
    expect(guidance).toContain('adr_id:    adr-1');
    expect(guidance).toContain('thread_id: thread-1');
    expect(guidance).toContain(
      'Do NOT write proposed ADR content to `.ai-pilot/output/`'
    );
    expect(guidance).toContain('staging tool is missing');
  });

  it('AC-0 / VT-06 keeps update_prd staging reachable for PRD assistants', () => {
    const guidance = buildDocumentAssistantEditGuidance(
      baseKickoff({
        assistantType: 'prd',
        freeformContext: 'prd_id: prd-1\nthread_id: thread-1',
      })
    ).join('\n');

    expect(guidance).toContain('update_prd');
    expect(guidance).toContain(
      'Do NOT write proposed PRD/backlog content to `.ai-pilot/output/`'
    );
  });

  it('AC-0 / VT-06 keeps update_design_doc staging reachable for design-doc assistants', () => {
    const guidance = buildDocumentAssistantEditGuidance(
      baseKickoff({
        assistantType: 'design-doc',
        freeformContext: 'doc_id: doc-1\nthread_id: thread-1',
      })
    ).join('\n');

    expect(guidance).toContain('update_design_doc');
    expect(guidance).toContain(
      'Do NOT write proposed design-doc content to `.ai-pilot/output/`'
    );
  });
});
