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

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  createThread,
  closeThread,
  permanentlyDeleteThread,
  markAsInterviewThread,
  buildMcpServers,
  buildDocumentAssistantEditGuidance,
  isDocumentAssistant,
  resolveDocumentAssistantType,
} from '../services/chatAgentService';
import type { ChatThreadKickoff } from '../../shared/types/chat';

const {
  deleteThread: mockPgDeleteThread,
  upsertThread: mockPgUpsertThread,
} = jest.requireMock('../services/chatThreadRepository') as {
  deleteThread: jest.Mock;
  upsertThread: jest.Mock;
};

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

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
