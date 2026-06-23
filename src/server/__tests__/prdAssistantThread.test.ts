/**
 * Tests for PRD assistant thread routes:
 *   POST /api/interviews/prds/:prdId/assistant-thread
 *   POST /api/interviews/prds/:prdId/apply-proposed
 *   POST /api/interviews/prds/:prdId/reject-proposed
 */

import request from 'supertest';
import express from 'express';
import fs from 'fs';
import interviewRouter from '../routes/interviews';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../services/interviewService');
jest.mock('../services/designDocService');

jest.mock('../services/prdService', () => ({
  getPrd: jest.fn(),
  createPrd: jest.fn(),
  listPrds: jest.fn(),
  reviewPrd: jest.fn(),
  reopenForReview: jest.fn(),
  startPrdWatcher: jest.fn(),
  submitForReview: jest.fn(),
  syncPrdContent: jest.fn(),
  updatePrdContent: jest.fn(),
  withdrawFromReview: jest.fn(),
  deletePrd: jest.fn(),
  createPrdAdoWorkItems: jest.fn(),
  syncPrdAdoStatus: jest.fn(),
}));

jest.mock('../services/reviewCommentService', () => ({
  getComments: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/chatAgentService', () => ({
  readOutputPrd: jest.fn().mockReturnValue(null),
  readOutputBacklog: jest.fn().mockReturnValue(null),
  readOutputDesignDoc: jest.fn().mockReturnValue(null),
  readOutputTechSpec: jest.fn().mockReturnValue(null),
  readOutputAssumptions: jest.fn().mockReturnValue(null),
  readOutputValidationScorecard: jest.fn().mockReturnValue(null),
  readOutputValidationScorecardMd: jest.fn().mockReturnValue(null),
  readAllOutputDesignDocFeatures: jest.fn().mockReturnValue([]),
  createThread: jest.fn(),
  getThreadAsync: jest.fn().mockResolvedValue(null),
  updateThreadKickoffContext: jest.fn(),
}));

jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: jest.fn().mockResolvedValue(null),
}));

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn().mockResolvedValue('global-model'),
  getAppSetting: jest.fn().mockResolvedValue(null),
  setAppSetting: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/documentApprovalService', () => ({
  getAssignments: jest.fn().mockResolvedValue([]),
  getAvailableApprovers: jest.fn().mockResolvedValue([]),
  reassignApprovers: jest.fn().mockResolvedValue(undefined),
  isAssignedApprover: jest.fn().mockResolvedValue(false),
  isApprovalComplete: jest.fn().mockResolvedValue({ complete: false }),
  assignApprovers: jest.fn().mockResolvedValue(undefined),
  recordApproverResponse: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/threadAccessService', () => ({
  canCreateDesignDocAssistantThread: jest.fn().mockResolvedValue(true),
}));

jest.mock('../middleware/rbac', () => ({
  requirePermission: jest.fn((..._keys: string[]) => (_req: any, _res: any, next: any) => next()),
  requireAnyPermission: jest.fn((..._keys: string[]) => (_req: any, _res: any, next: any) => next()),
  requireGroupMembership: jest.fn((..._groupNames: string[]) => (_req: any, _res: any, next: any) => next()),
  attachPermissions: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: jest.fn().mockReturnValue('user-test'),
}));

// Direct DB calls in the route — mock the Drizzle instance.
jest.mock('../db/drizzle', () => {
  const makeSelectChain = () => ({
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  });
  const makeUpdateChain = () => ({
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue(undefined),
  });
  return {
    db: {
      select: jest.fn().mockImplementation(makeSelectChain),
      update: jest.fn().mockImplementation(makeUpdateChain),
      execute: jest.fn().mockResolvedValue(undefined),
      // apply-proposed reads fixCommentId via the relational query API.
      // Default: null → bulk resolution path (all open comments resolved).
      query: {
        prds: { findFirst: jest.fn().mockResolvedValue(null) },
        designDocs: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    },
  };
});

// ── Typed mock references ─────────────────────────────────────────────────────

const { getPrd: mockGetPrd } = jest.requireMock('../services/prdService') as { getPrd: jest.Mock };
// Capture permission calls from route registration (before any clearAllMocks)
let permissionsRequestedAtLoad: string[] = [];
const { getComments: mockGetComments } = jest.requireMock('../services/reviewCommentService') as { getComments: jest.Mock };
const { createThread: mockCreateThread } = jest.requireMock('../services/chatAgentService') as { createThread: jest.Mock };
const { db: mockDb } = jest.requireMock('../db/drizzle') as {
  db: {
    select: jest.Mock;
    update: jest.Mock;
    execute: jest.Mock;
    query: { prds: { findFirst: jest.Mock }; designDocs: { findFirst: jest.Mock } };
  };
};
const { requirePermission: mockRequirePermission } = jest.requireMock('../middleware/rbac') as { requirePermission: jest.Mock };

// Capture route-registration permission calls before any clearAllMocks
beforeAll(() => {
  permissionsRequestedAtLoad = mockRequirePermission.mock.calls.map((c: any[]) => c[0] as string);
});

// ── App factory ───────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/interviews', interviewRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' });
  });
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const basePrd = {
  id: 'prd-1',
  project: 'proj-alpha',
  chatThreadId: 'thread-gen-1',
  authorId: 'user-test',
  title: 'My PRD',
  status: 'draft',
  content: '# PRD\nSome content.',
  backlogJson: { epics: [] },
  prdAssistantThreadId: null as string | null,
  proposedContent: null as string | null,
  proposedBacklogJson: null as unknown,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const commentFixture = {
  id: 'comment-1',
  documentId: 'prd-1',
  documentType: 'prd' as const,
  authorUserId: 'reviewer-1',
  authorDisplayName: 'Alice',
  sectionKey: 'prd' as const,
  selector: { exact: 'some quoted text', prefix: '', suffix: '', start: 0, end: 16 },
  body: 'Please clarify this section.',
  status: 'open' as const,
  replies: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

// ── POST /prds/:prdId/assistant-thread — new thread ───────────────────────────

describe('POST /api/interviews/prds/:prdId/assistant-thread — new thread creation', () => {
  let writeSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequirePermission.mockImplementation((..._keys: string[]) => (_req: any, _res: any, next: any) => next());
    writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    mockCreateThread.mockResolvedValue({ id: 'thread-new', workspaceDir: '/workspace/new' });
    mockDb.update.mockImplementation(() => ({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    }));
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('creates a new thread and returns { threadId }', async () => {
    mockGetPrd.mockResolvedValue({ ...basePrd, prdAssistantThreadId: null });
    mockGetComments.mockResolvedValue([]);

    const res = await request(buildApp())
      .post('/api/interviews/prds/prd-1/assistant-thread');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ threadId: 'thread-new' });
    expect(mockCreateThread).toHaveBeenCalledTimes(1);
  });

  it('writes kickoff-context.md with PRD content and backlog', async () => {
    mockGetPrd.mockResolvedValue({ ...basePrd, prdAssistantThreadId: null, content: '# My PRD Content' });
    mockGetComments.mockResolvedValue([]);

    await request(buildApp()).post('/api/interviews/prds/prd-1/assistant-thread');

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [filePath, content] = writeSpy.mock.calls[0] as [string, string, string];
    expect(filePath).toContain('kickoff-context.md');
    expect(content).toContain('# My PRD Content');
    expect(content).toContain('thread-new');
    expect(content).not.toContain('__THREAD_ID__');
  });

  it('persists prdAssistantThreadId on the PRD row', async () => {
    mockGetPrd.mockResolvedValue({ ...basePrd, prdAssistantThreadId: null });
    mockGetComments.mockResolvedValue([]);

    const mockSet = jest.fn().mockReturnThis();
    const mockWhere = jest.fn().mockResolvedValue(undefined);
    mockDb.update.mockReturnValue({ set: mockSet, where: mockWhere });

    await request(buildApp()).post('/api/interviews/prds/prd-1/assistant-thread');

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ prdAssistantThreadId: 'thread-new' }),
    );
  });

  it('passes a kickoffMessage to createThread', async () => {
    mockGetPrd.mockResolvedValue({ ...basePrd, prdAssistantThreadId: null });
    mockGetComments.mockResolvedValue([]);

    await request(buildApp()).post('/api/interviews/prds/prd-1/assistant-thread');

    expect(mockCreateThread).toHaveBeenCalledWith(
      'user-test',
      expect.any(Object),
      expect.objectContaining({ kickoffMessage: expect.stringContaining('Apex') }),
    );
  });

  it('returns 404 when PRD is not found', async () => {
    mockGetPrd.mockResolvedValue(null);

    const res = await request(buildApp()).post('/api/interviews/prds/missing/assistant-thread');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'PRD not found' });
    expect(mockCreateThread).not.toHaveBeenCalled();
  });
});

// ── POST /prds/:prdId/assistant-thread — existing thread ──────────────────────

describe('POST /api/interviews/prds/:prdId/assistant-thread — existing thread', () => {
  let writeSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequirePermission.mockImplementation((..._keys: string[]) => (_req: any, _res: any, next: any) => next());
    writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('reuses existing threadId and does not create a new thread', async () => {
    mockGetPrd.mockResolvedValue({ ...basePrd, prdAssistantThreadId: 'thread-existing' });
    mockGetComments.mockResolvedValue([]);
    mockDb.select.mockImplementation(() => ({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ workspaceDir: '/tmp/workspace' }]),
    }));

    const res = await request(buildApp()).post('/api/interviews/prds/prd-1/assistant-thread');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ threadId: 'thread-existing' });
    expect(mockCreateThread).not.toHaveBeenCalled();
  });

  it('refreshes kickoff-context.md with latest content when reusing thread', async () => {
    mockGetPrd.mockResolvedValue({
      ...basePrd,
      prdAssistantThreadId: 'thread-existing',
      content: '# Updated PRD',
    });
    mockGetComments.mockResolvedValue([]);
    mockDb.select.mockImplementation(() => ({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ workspaceDir: '/workspace/dir' }]),
    }));

    await request(buildApp()).post('/api/interviews/prds/prd-1/assistant-thread');

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [filePath, content] = writeSpy.mock.calls[0] as [string, string, string];
    expect(filePath).toContain('kickoff-context.md');
    expect(content).toContain('# Updated PRD');
    expect(content).toContain('thread-existing');
  });

  it('includes review comment author and body in kickoff-context.md', async () => {
    mockGetPrd.mockResolvedValue({ ...basePrd, prdAssistantThreadId: null });
    mockGetComments.mockResolvedValue([commentFixture]);
    mockCreateThread.mockResolvedValue({ id: 'thread-new', workspaceDir: '/workspace/new' });
    mockDb.update.mockImplementation(() => ({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    }));

    await request(buildApp()).post('/api/interviews/prds/prd-1/assistant-thread');

    const [, content] = writeSpy.mock.calls[0] as [string, string, string];
    expect(content).toContain('Alice');
    expect(content).toContain('Please clarify this section.');
    expect(content).toContain('## Review Comments');
  });
});

// ── POST /prds/:prdId/apply-proposed ─────────────────────────────────────────

describe('POST /api/interviews/prds/:prdId/apply-proposed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequirePermission.mockImplementation((..._keys: string[]) => (_req: any, _res: any, next: any) => next());
    mockDb.update.mockImplementation(() => ({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    }));
    mockDb.execute.mockResolvedValue(undefined);
    // Default: no fixCommentId — bulk resolution path
    mockDb.query.prds.findFirst.mockResolvedValue(null);
  });

  it('atomically promotes proposed content via raw SQL and returns { ok: true }', async () => {
    const res = await request(buildApp()).post('/api/interviews/prds/prd-1/apply-proposed');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // Route uses db.execute(sql`UPDATE prds ...`) — not db.update — for the atomic promotion
    expect(mockDb.execute).toHaveBeenCalledTimes(1);
  });

  it('auto-resolves open comments after applying proposed content', async () => {
    const mockSet = jest.fn().mockReturnThis();
    const mockWhere = jest.fn().mockResolvedValue(undefined);
    mockDb.update.mockReturnValue({ set: mockSet, where: mockWhere });

    await request(buildApp()).post('/api/interviews/prds/prd-1/apply-proposed');

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'resolved', resolvedBy: 'user-test' }),
    );
  });

  it('returns 200 even when the PRD id does not match any row (atomic SQL is a no-op)', async () => {
    // The route no longer calls getPrd; the raw SQL UPDATE simply affects 0 rows if not found.
    const res = await request(buildApp()).post('/api/interviews/prds/missing/apply-proposed');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

// ── POST /prds/:prdId/reject-proposed ────────────────────────────────────────

describe('POST /api/interviews/prds/:prdId/reject-proposed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequirePermission.mockImplementation((..._keys: string[]) => (_req: any, _res: any, next: any) => next());
  });

  it('clears proposedContent and proposedBacklogJson', async () => {
    mockGetPrd.mockResolvedValue({
      ...basePrd,
      proposedContent: '# Rejected content',
      proposedBacklogJson: { epics: [] },
    });

    const mockSet = jest.fn().mockReturnThis();
    const mockWhere = jest.fn().mockResolvedValue(undefined);
    mockDb.update.mockReturnValue({ set: mockSet, where: mockWhere });

    const res = await request(buildApp()).post('/api/interviews/prds/prd-1/reject-proposed');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        proposedContent: null,
        proposedBacklogJson: null,
      }),
    );
  });

  it('returns 404 when PRD is not found', async () => {
    mockGetPrd.mockResolvedValue(null);

    const res = await request(buildApp()).post('/api/interviews/prds/missing/reject-proposed');

    expect(res.status).toBe(404);
  });
});

// ── Permission enforcement ────────────────────────────────────────────────────

describe('PRD assistant thread routes — permission guards', () => {
  it('registers assistant-thread route with interviews:view permission', () => {
    expect(permissionsRequestedAtLoad).toContain('interviews:view');
  });

  it('registers apply-proposed and reject-proposed routes with interviews:manage permission', () => {
    expect(permissionsRequestedAtLoad).toContain('interviews:manage');
  });
});
