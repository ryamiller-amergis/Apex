/**
 * Unit tests for thread-retention behavior in chatAgentService.
 * Verifies that closeThread never deletes the chat_threads row when
 * the thread is interview-backed or referenced by any document row
 * (PRD or design doc), guarding against cascade data loss.
 */
import path from 'path';

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
    (row: { designPrototypeId?: string | null; featureIndex?: number | null }) =>
      row.designPrototypeId != null || row.featureIndex != null,
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

const mockCallerGroundingStart = jest.fn();
jest.mock('../services/callerGroundingService', () => ({
  callerGroundingService: {
    start: mockCallerGroundingStart,
  },
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
  resumeOrCreateAgent,
  resolveDocumentAssistantType,
  copyScratchInputsToGroundedCheckout,
} from '../services/chatAgentService';
import type { ChatMessage, ChatThreadKickoff } from '../../shared/types/chat';

const {
  deleteThread: mockPgDeleteThread,
  upsertThread: mockPgUpsertThread,
} = jest.requireMock('../services/chatThreadRepository') as {
  deleteThread: jest.Mock;
  upsertThread: jest.Mock;
};

const { db: mockDb } = jest.requireMock('../db/drizzle') as {
  db: {
    query: {
      prds: { findFirst: jest.Mock };
      designDocs: { findFirst: jest.Mock };
    };
  };
};

function chatMessage(
  id: string,
  role: ChatMessage['role'],
  text: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    text,
    ts: `2026-07-28T00:00:0${id.length}.000Z`,
    ...overrides,
  };
}

describe('replacement agent recovery', () => {
  it('builds history from visible user and agent messages only', () => {
    const recovery = buildAgentRecoveryContext([
      chatMessage('1', 'user', 'We need guided feature walkthroughs.'),
      chatMessage('2', 'tool', '→ search_repo_code', { toolName: 'search_repo_code' }),
      chatMessage('3', 'agent', 'Internal planning snapshot', { toolName: '_reasoning' }),
      chatMessage('4', 'user', 'Begin.', { hidden: true }),
      chatMessage('5', 'agent', 'Should walkthroughs remain separate from What’s New?'),
    ]);

    expect(recovery).not.toBeNull();
    expect(recovery?.totalMessageCount).toBe(2);
    expect(recovery?.truncated).toBe(false);
    expect(recovery?.content).toContain('We need guided feature walkthroughs.');
    expect(recovery?.content).toContain('Should walkthroughs remain separate from What’s New?');
    expect(recovery?.content).not.toContain('search_repo_code');
    expect(recovery?.content).not.toContain('Internal planning snapshot');
    expect(recovery?.content).not.toContain('Begin.');
  });

  it('returns no recovery context when only execution noise exists', () => {
    expect(buildAgentRecoveryContext([
      chatMessage('1', 'tool', '→ shell', { toolName: 'shell' }),
      chatMessage('2', 'agent', 'Analyzing', { toolName: '_reasoning' }),
      chatMessage('3', 'user', 'Begin.', { hidden: true }),
    ])).toBeNull();
  });

  it('bounds oversized history while preserving the beginning and latest turn', () => {
    const recovery = buildAgentRecoveryContext([
      chatMessage('1', 'user', `BEGINNING_DECISION ${'a'.repeat(700)}`),
      chatMessage('2', 'agent', `MIDDLE_HISTORY ${'b'.repeat(2_000)}`),
      chatMessage('3', 'user', `LATEST_TURN ${'c'.repeat(500)}`),
    ], 1_200);

    expect(recovery?.truncated).toBe(true);
    expect(recovery?.content).toContain('BEGINNING_DECISION');
    expect(recovery?.content).toContain('LATEST_TURN');
    expect(recovery?.content).toContain('middle messages omitted');
  });

  it('creates a replacement agent when resume fails', async () => {
    const resumeError = new Error('agent session no longer exists');
    const resume = jest.fn().mockRejectedValue(resumeError);
    const create = jest.fn().mockResolvedValue({ agentId: 'replacement-agent' });

    const result = await resumeOrCreateAgent({
      cursorAgentId: 'disposed-agent',
      resume,
      create,
    });

    expect(resume).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      agent: { agentId: 'replacement-agent' },
      mode: 'recreated',
      resumeError,
    });
  });

  it('does not create a replacement when resume succeeds', async () => {
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

// ── closeThread — thread retention ────────────────────────────────────────────

describe('closeThread — thread retention', () => {
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

  it('does not delete the chat_threads row when the thread is interview-backed', async () => {
    const thread = await createThread(
      'user-1',
      { project: 'proj', repo: 'org/repo', branch: 'main' },
      { skipAutoKickoff: true },
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
      { skipAutoKickoff: true },
    );

    await closeThread(thread.id);

    expect(mockPgDeleteThread).not.toHaveBeenCalled();
  });

  it('does not delete the chat_threads row when the thread backs a design doc', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue({ id: 'dd-1' });

    const thread = await createThread(
      'user-1',
      { project: 'proj', repo: 'org/repo', branch: 'main' },
      { skipAutoKickoff: true },
    );

    await closeThread(thread.id);

    expect(mockPgDeleteThread).not.toHaveBeenCalled();
  });

  it('upserts with status=closed for a standalone thread (never deletes)', async () => {
    const thread = await createThread(
      'user-1',
      { project: 'proj', repo: 'org/repo', branch: 'main' },
      { skipAutoKickoff: true },
    );

    await closeThread(thread.id);

    expect(mockPgDeleteThread).not.toHaveBeenCalled();
    expect(mockPgUpsertThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: thread.id, status: 'closed' }),
    );
  });

  it('DoD-2 keeps the profile checkout runtime-only and never deletes it', async () => {
    // Arrange
    const mockedFs = jest.requireMock('fs') as {
      existsSync: jest.Mock;
      readdirSync: jest.Mock;
      cpSync: jest.Mock;
      rmSync: jest.Mock;
    };
    const thread = await createThread(
      'user-1',
      { project: 'proj', repo: 'org/repo', branch: 'main' },
      { skipAutoKickoff: true },
    );
    const scratchWorkspace = thread.workspaceDir;
    const profileCheckout = '/tmp/test-data/grounding-workspaces/opaque';
    mockedFs.existsSync.mockReturnValueOnce(true);
    mockedFs.readdirSync.mockReturnValueOnce(['.ai-pilot']);

    // Act
    copyScratchInputsToGroundedCheckout(scratchWorkspace, profileCheckout);
    await closeThread(thread.id);

    // Assert
    expect(thread.workspaceDir).toBe(scratchWorkspace);
    expect(mockPgUpsertThread).not.toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: profileCheckout }),
    );
    expect(mockedFs.cpSync).toHaveBeenCalledWith(
      path.join(scratchWorkspace, '.ai-pilot'),
      path.join(profileCheckout, '.ai-pilot'),
      { recursive: true, force: true },
    );
    expect(mockedFs.rmSync).toHaveBeenCalledWith(
      scratchWorkspace,
      { recursive: true, force: true },
    );
    expect(mockedFs.rmSync).not.toHaveBeenCalledWith(
      profileCheckout,
      expect.anything(),
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
      { skipAutoKickoff: true },
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
      { skipAutoKickoff: true },
    );

    markAsInterviewThread(thread.id);
    await closeThread(thread.id);

    expect(mockPgDeleteThread).not.toHaveBeenCalled();
  });

  it('is idempotent — calling it twice does not throw', async () => {
    const thread = await createThread(
      'user-1',
      { project: 'proj', repo: 'org/repo', branch: 'main' },
      { skipAutoKickoff: true },
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

function baseKickoff(overrides: Partial<ChatThreadKickoff> = {}): ChatThreadKickoff {
  return {
    project: 'Apex',
    repo: 'org/AI-Pilot',
    branch: 'main',
    skillProvider: 'github',
    ...overrides,
  };
}

describe('document assistant MCP wiring', () => {
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
      { skipAutoKickoff: true },
    );

    try {
      // When the first chat turn selects its shared caller grounding.
      await expect(
        sendMessage(thread.id, 'Read the selected skill snapshot'),
      ).rejects.toBe(stopAfterGrounding);

      // Then the pin uses the same skillBranch ?? branch contract as prompt/preload.
      expect(mockCallerGroundingStart).toHaveBeenCalledWith(
        expect.objectContaining({
          repository: {
            provider: 'github',
            repo: 'org/AI-Pilot',
            branch: 'skills-snapshot',
          },
        }),
      );
    } finally {
      delete process.env.CURSOR_API_KEY;
      await closeThread(thread.id);
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
      { calendarSessionId: 'calendar-session-1' },
    );

    // When chat decides whether this caller needs shared repository grounding.
    const repositoryReading = isRepositoryReadingChatCaller(kickoff, false);

    // Then no repository profile is started for the calendar-only MCP contract.
    expect(Object.keys(servers)).toEqual(['calendar-assistant']);
    expect(repositoryReading).toBe(false);
  });

  it('AC-0 keeps normal GitHub and ADO chat callers repository-reading', () => {
    expect(isRepositoryReadingChatCaller(baseKickoff(), false)).toBe(true);
    expect(isRepositoryReadingChatCaller(baseKickoff({
      skillProvider: 'ado',
      repo: 'Apex',
    }), false)).toBe(true);
    expect(isRepositoryReadingChatCaller(baseKickoff(), true)).toBe(false);
  });

  it('identifies ADR / PRD / design-doc assistant types', () => {
    expect(isDocumentAssistant('adr')).toBe(true);
    expect(isDocumentAssistant('prd')).toBe(true);
    expect(isDocumentAssistant('design-doc')).toBe(true);
    expect(isDocumentAssistant('calendar-work-item')).toBe(false);
    expect(isDocumentAssistant(undefined)).toBe(false);
  });

  it('infers document assistant type from freeform context markers', () => {
    expect(resolveDocumentAssistantType(baseKickoff({
      freeformContext: '# ADR Assistant Context\nadr_id: adr-1\nthread_id: t-1',
    }))).toBe('adr');
    expect(resolveDocumentAssistantType(baseKickoff({
      freeformContext: 'prd_id: prd-1\nthread_id: t-1',
    }))).toBe('prd');
    expect(resolveDocumentAssistantType(baseKickoff({
      freeformContext: 'doc_id: doc-1\nthread_id: t-1',
    }))).toBe('design-doc');
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
      buildMcpServers(kickoff, 'http://localhost:3001/mcp/ado-skills')['ado-skills'],
    ).toBeUndefined();
  });

  it('mounts both github-repo and ado-skills for GitHub ADR assistants', () => {
    const servers = buildMcpServers(
      baseKickoff({
        assistantType: 'adr',
        freeformContext: 'adr_id: adr-1\nthread_id: t-1',
      }),
      'http://localhost:3001/mcp/ado-skills',
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
      'http://localhost:3001/mcp/ado-skills',
    );

    expect(servers['github-repo']).toBeDefined();
    expect(servers['ado-skills']).toBeDefined();
  });

  it('does not mount ado-skills for plain GitHub free-chat threads', () => {
    const servers = buildMcpServers(
      baseKickoff(),
      'http://localhost:3001/mcp/ado-skills',
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
      'http://localhost:3001/mcp/ado-skills',
    );

    expect(servers['github-repo']).toBeUndefined();
    expect(servers['ado-skills']).toBeDefined();
  });

  it('uses repository MCP profiles without broad code search for interviews', () => {
    const githubServers = buildMcpServers(
      baseKickoff(),
      'http://localhost:3001/mcp/ado-skills',
      { restrictRepoSearch: true },
    );
    expect(githubServers['github-repo']).toEqual({
      url: 'http://localhost:3001/mcp/github-repo?profile=interview',
    });

    const adoServers = buildMcpServers(
      baseKickoff({ skillProvider: 'ado', repo: 'Apex' }),
      'http://localhost:3001/mcp/ado-skills',
      { restrictRepoSearch: true },
    );
    expect(adoServers['ado-skills']).toEqual({
      url: 'http://localhost:3001/mcp/ado-skills?profile=interview',
    });
  });

  it('DoD-2 transports the shared profile on chat-agent MCP URLs', () => {
    const profileId = 'opaque-profile' as import('../../shared/types/repoReader').GroundingProfileId;
    const githubServers = buildMcpServers(
      baseKickoff(),
      'http://localhost:3001/mcp/ado-skills',
      { groundingProfileId: profileId, restrictRepoSearch: true },
    );
    const adoServers = buildMcpServers(
      baseKickoff({ skillProvider: 'ado', repo: 'Apex' }),
      'http://localhost:3001/mcp/ado-skills',
      { groundingProfileId: profileId, restrictRepoSearch: true },
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
  it('requires update_adr and forbids output-file fallbacks for ADR assistants', () => {
    const guidance = buildDocumentAssistantEditGuidance(baseKickoff({
      assistantType: 'adr',
      freeformContext: 'adr_id: adr-1\nthread_id: thread-1',
    })).join('\n');

    expect(guidance).toContain('update_adr');
    expect(guidance).toContain('adr_id:    adr-1');
    expect(guidance).toContain('thread_id: thread-1');
    expect(guidance).toContain('Do NOT write proposed ADR content to `.ai-pilot/output/`');
    expect(guidance).toContain('staging tool is missing');
  });

  it('requires update_prd for PRD assistants', () => {
    const guidance = buildDocumentAssistantEditGuidance(baseKickoff({
      assistantType: 'prd',
      freeformContext: 'prd_id: prd-1\nthread_id: thread-1',
    })).join('\n');

    expect(guidance).toContain('update_prd');
    expect(guidance).toContain('Do NOT write proposed PRD/backlog content to `.ai-pilot/output/`');
  });

  it('requires update_design_doc for design-doc assistants', () => {
    const guidance = buildDocumentAssistantEditGuidance(baseKickoff({
      assistantType: 'design-doc',
      freeformContext: 'doc_id: doc-1\nthread_id: thread-1',
    })).join('\n');

    expect(guidance).toContain('update_design_doc');
    expect(guidance).toContain('Do NOT write proposed design-doc content to `.ai-pilot/output/`');
  });
});
