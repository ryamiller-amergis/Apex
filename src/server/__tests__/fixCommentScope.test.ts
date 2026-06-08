/**
 * Tests for the fixCommentId scoping fix:
 *
 * When a user clicks the per-comment sparkle ("Fix with Apex") button, the
 * resulting AI change should ONLY resolve that specific comment when accepted —
 * not all open comments.
 *
 * The bulk "Fix with Apex" header button should still resolve ALL open comments.
 *
 * Coverage:
 *   POST /api/interviews/prds/:prdId/fix-comment-with-ai   — stores fixCommentId
 *   POST /api/interviews/prds/:prdId/fix-with-ai           — clears fixCommentId
 *   POST /api/interviews/prds/:prdId/apply-proposed        — resolves only scoped comment OR all
 *
 *   POST /api/interviews/design-docs/:id/fix-comment-with-ai — stores fixCommentId
 *   POST /api/interviews/design-docs/:id/fix-with-ai         — clears fixCommentId
 *   POST /api/interviews/design-docs/:id/apply-proposed      — resolves only scoped comment OR all
 */

import request from 'supertest';
import express from 'express';
import interviewRouter from '../routes/interviews';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../services/interviewService');
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

jest.mock('../services/designDocService', () => ({
  getDesignDoc: jest.fn(),
  createDesignDoc: jest.fn(),
  listDesignDocs: jest.fn(),
  reviewDesignDoc: jest.fn(),
  deleteDesignDoc: jest.fn(),
  generateFallbackReport: jest.fn(),
  startDesignDocWatcher: jest.fn(),
  submitForReview: jest.fn(),
  syncDesignDocContent: jest.fn(),
  triggerFixValidation: jest.fn(),
  cancelValidation: jest.fn(),
  acceptFixValidation: jest.fn(),
  updateDesignDocContent: jest.fn(),
  updatePrdBacklog: jest.fn(),
}));

jest.mock('../services/reviewCommentService', () => ({
  getComments: jest.fn(),
}));

jest.mock('../services/bedrockService', () => ({
  fixPrdContentWithBedrock: jest.fn().mockResolvedValue('## Fixed PRD content'),
  fixPrdBacklogWithBedrock: jest.fn().mockResolvedValue({ epics: [] }),
  fixDesignDocSectionWithBedrock: jest.fn().mockResolvedValue('## Fixed section'),
  BedrockModelTruncatedError: class BedrockModelTruncatedError extends Error {},
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

jest.mock('../middleware/rbac', () => ({
  requirePermission: jest.fn((..._keys: string[]) => (_req: any, _res: any, next: any) => next()),
  requireAnyPermission: jest.fn((..._keys: string[]) => (_req: any, _res: any, next: any) => next()),
  attachPermissions: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: jest.fn().mockReturnValue('user-test'),
}));

jest.mock('../db/drizzle', () => {
  const makeUpdateChain = () => ({
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue(undefined),
  });
  return {
    db: {
      update: jest.fn().mockImplementation(makeUpdateChain),
      execute: jest.fn().mockResolvedValue(undefined),
      query: {
        prds: { findFirst: jest.fn().mockResolvedValue(null) },
        designDocs: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    },
  };
});

// ── Typed mock references ─────────────────────────────────────────────────────

const { getPrd: mockGetPrd } = jest.requireMock('../services/prdService') as { getPrd: jest.Mock };
const { getDesignDoc: mockGetDesignDoc } = jest.requireMock('../services/designDocService') as { getDesignDoc: jest.Mock };
const { getComments: mockGetComments } = jest.requireMock('../services/reviewCommentService') as { getComments: jest.Mock };
const { db: mockDb } = jest.requireMock('../db/drizzle') as {
  db: {
    update: jest.Mock;
    execute: jest.Mock;
    query: { prds: { findFirst: jest.Mock }; designDocs: { findFirst: jest.Mock } };
  };
};

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
  prdAssistantThreadId: null,
  proposedContent: null,
  proposedBacklogJson: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const baseDesignDoc = {
  id: 'doc-1',
  prdId: 'prd-1',
  project: 'proj-alpha',
  authorId: 'user-test',
  title: 'My Design Doc',
  status: 'draft',
  designContent: '## Design content',
  techSpecContent: '## Tech spec content',
  assumptionsContent: '## Assumptions content',
  proposedDesignContent: null,
  proposedTechSpecContent: null,
  proposedAssumptionsContent: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const openCommentPrd = {
  id: 'comment-prd-1',
  documentId: 'prd-1',
  documentType: 'prd' as const,
  sectionKey: 'prd' as const,
  authorUserId: 'reviewer-1',
  authorDisplayName: 'Alice',
  selector: { exact: 'Some content', prefix: '', suffix: '', start: 7, end: 19 },
  body: 'Please clarify this.',
  status: 'open' as const,
  replies: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const openCommentDesign = {
  id: 'comment-design-1',
  documentId: 'doc-1',
  documentType: 'design_doc' as const,
  sectionKey: 'design' as const,
  authorUserId: 'reviewer-1',
  authorDisplayName: 'Bob',
  selector: { exact: 'Design content', prefix: '', suffix: '', start: 3, end: 17 },
  body: 'Expand this section.',
  status: 'open' as const,
  replies: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

// ── PRD fix-comment-with-ai — stores fixCommentId ────────────────────────────

describe('POST /api/interviews/prds/:prdId/fix-comment-with-ai — stores fixCommentId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPrd.mockResolvedValue(basePrd);
    mockGetComments.mockResolvedValue([openCommentPrd]);
    mockDb.update.mockImplementation(() => ({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    }));
  });

  it('persists fixCommentId equal to the triggering comment ID', async () => {
    const mockSet = jest.fn().mockReturnThis();
    const mockWhere = jest.fn().mockResolvedValue(undefined);
    mockDb.update.mockReturnValue({ set: mockSet, where: mockWhere });

    const res = await request(buildApp())
      .post('/api/interviews/prds/prd-1/fix-comment-with-ai')
      .send({ commentId: 'comment-prd-1' });

    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ fixCommentId: 'comment-prd-1' }),
    );
  });

  it('returns 404 when PRD is not found', async () => {
    mockGetPrd.mockResolvedValue(null);

    const res = await request(buildApp())
      .post('/api/interviews/prds/prd-1/fix-comment-with-ai')
      .send({ commentId: 'comment-prd-1' });

    expect(res.status).toBe(404);
  });

  it('returns 404 when the comment does not belong to the PRD', async () => {
    mockGetComments.mockResolvedValue([]);

    const res = await request(buildApp())
      .post('/api/interviews/prds/prd-1/fix-comment-with-ai')
      .send({ commentId: 'non-existent-comment' });

    expect(res.status).toBe(404);
  });
});

// ── PRD fix-with-ai (bulk) — clears fixCommentId ─────────────────────────────

describe('POST /api/interviews/prds/:prdId/fix-with-ai — clears fixCommentId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPrd.mockResolvedValue(basePrd);
    mockGetComments.mockResolvedValue([openCommentPrd]);
  });

  it('sets fixCommentId to null so accept resolves all comments', async () => {
    const mockSet = jest.fn().mockReturnThis();
    const mockWhere = jest.fn().mockResolvedValue(undefined);
    mockDb.update.mockReturnValue({ set: mockSet, where: mockWhere });

    const res = await request(buildApp())
      .post('/api/interviews/prds/prd-1/fix-with-ai');

    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ fixCommentId: null }),
    );
  });
});

// ── PRD apply-proposed — bulk resolution (fixCommentId is null) ───────────────

describe('POST /api/interviews/prds/:prdId/apply-proposed — bulk resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.execute.mockResolvedValue(undefined);
    // No fixCommentId — simulates bulk "Fix with Apex" header button
    mockDb.query.prds.findFirst.mockResolvedValue(null);
  });

  it('resolves all open comments when fixCommentId is null', async () => {
    const mockSet = jest.fn().mockReturnThis();
    const mockWhere = jest.fn().mockResolvedValue(undefined);
    mockDb.update.mockReturnValue({ set: mockSet, where: mockWhere });

    const res = await request(buildApp())
      .post('/api/interviews/prds/prd-1/apply-proposed');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'resolved', resolvedBy: 'user-test' }),
    );
    // db.update is called once — for the bulk resolve (no ID filter)
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });

  it('calls db.query.prds.findFirst to read fixCommentId before the SQL update', async () => {
    mockDb.update.mockImplementation(() => ({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    }));

    await request(buildApp()).post('/api/interviews/prds/prd-1/apply-proposed');

    expect(mockDb.query.prds.findFirst).toHaveBeenCalledTimes(1);
  });

  it('runs the raw SQL promotion exactly once', async () => {
    mockDb.update.mockImplementation(() => ({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    }));

    await request(buildApp()).post('/api/interviews/prds/prd-1/apply-proposed');

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
  });
});

// ── PRD apply-proposed — single-comment resolution (fixCommentId is set) ──────

describe('POST /api/interviews/prds/:prdId/apply-proposed — single-comment resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.execute.mockResolvedValue(undefined);
    // fixCommentId set — simulates per-comment sparkle fix
    mockDb.query.prds.findFirst.mockResolvedValue({ fixCommentId: 'comment-prd-1' });
  });

  it('resolves only the triggering comment when fixCommentId is set', async () => {
    const mockSet = jest.fn().mockReturnThis();
    const mockWhere = jest.fn().mockResolvedValue(undefined);
    mockDb.update.mockReturnValue({ set: mockSet, where: mockWhere });

    const res = await request(buildApp())
      .post('/api/interviews/prds/prd-1/apply-proposed');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // The resolve update should be called with status resolved
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'resolved', resolvedBy: 'user-test' }),
    );
    // db.update is called exactly once — only the specific comment
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });

  it('returns 200 and ok: true whether or not the comment exists', async () => {
    mockDb.update.mockImplementation(() => ({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    }));

    const res = await request(buildApp())
      .post('/api/interviews/prds/prd-1/apply-proposed');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

// ── Design doc fix-comment-with-ai — stores fixCommentId ─────────────────────

describe('POST /api/interviews/design-docs/:id/fix-comment-with-ai — stores fixCommentId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDesignDoc.mockResolvedValue(baseDesignDoc);
    mockGetComments.mockResolvedValue([openCommentDesign]);
    mockDb.update.mockImplementation(() => ({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    }));
  });

  it('persists fixCommentId equal to the triggering comment ID', async () => {
    const mockSet = jest.fn().mockReturnThis();
    const mockWhere = jest.fn().mockResolvedValue(undefined);
    mockDb.update.mockReturnValue({ set: mockSet, where: mockWhere });

    const res = await request(buildApp())
      .post('/api/interviews/design-docs/doc-1/fix-comment-with-ai')
      .send({ commentId: 'comment-design-1' });

    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ fixCommentId: 'comment-design-1' }),
    );
  });

  it('returns 404 when the design doc is not found', async () => {
    mockGetDesignDoc.mockResolvedValue(null);

    const res = await request(buildApp())
      .post('/api/interviews/design-docs/doc-1/fix-comment-with-ai')
      .send({ commentId: 'comment-design-1' });

    expect(res.status).toBe(404);
  });

  it('returns 404 when the comment does not belong to the design doc', async () => {
    mockGetComments.mockResolvedValue([]);

    const res = await request(buildApp())
      .post('/api/interviews/design-docs/doc-1/fix-comment-with-ai')
      .send({ commentId: 'non-existent-comment' });

    expect(res.status).toBe(404);
  });
});

// ── Design doc fix-with-ai (bulk) — clears fixCommentId ──────────────────────

describe('POST /api/interviews/design-docs/:id/fix-with-ai — clears fixCommentId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDesignDoc.mockResolvedValue(baseDesignDoc);
    mockGetComments.mockResolvedValue([openCommentDesign]);
  });

  it('sets fixCommentId to null so accept resolves all comments', async () => {
    const mockSet = jest.fn().mockReturnThis();
    const mockWhere = jest.fn().mockResolvedValue(undefined);
    mockDb.update.mockReturnValue({ set: mockSet, where: mockWhere });

    const res = await request(buildApp())
      .post('/api/interviews/design-docs/doc-1/fix-with-ai');

    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ fixCommentId: null }),
    );
  });
});

// ── Design doc apply-proposed — bulk resolution (fixCommentId is null) ────────

describe('POST /api/interviews/design-docs/:id/apply-proposed — bulk resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.execute.mockResolvedValue(undefined);
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);
  });

  it('resolves all open comments when fixCommentId is null', async () => {
    const mockSet = jest.fn().mockReturnThis();
    const mockWhere = jest.fn().mockResolvedValue(undefined);
    mockDb.update.mockReturnValue({ set: mockSet, where: mockWhere });

    const res = await request(buildApp())
      .post('/api/interviews/design-docs/doc-1/apply-proposed');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'resolved', resolvedBy: 'user-test' }),
    );
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });

  it('calls db.query.designDocs.findFirst to read fixCommentId before the SQL update', async () => {
    mockDb.update.mockImplementation(() => ({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    }));

    await request(buildApp()).post('/api/interviews/design-docs/doc-1/apply-proposed');

    expect(mockDb.query.designDocs.findFirst).toHaveBeenCalledTimes(1);
  });

  it('runs the raw SQL promotion exactly once', async () => {
    mockDb.update.mockImplementation(() => ({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    }));

    await request(buildApp()).post('/api/interviews/design-docs/doc-1/apply-proposed');

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
  });
});

// ── Design doc apply-proposed — single-comment resolution (fixCommentId set) ──

describe('POST /api/interviews/design-docs/:id/apply-proposed — single-comment resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.execute.mockResolvedValue(undefined);
    mockDb.query.designDocs.findFirst.mockResolvedValue({ fixCommentId: 'comment-design-1' });
  });

  it('resolves only the triggering comment when fixCommentId is set', async () => {
    const mockSet = jest.fn().mockReturnThis();
    const mockWhere = jest.fn().mockResolvedValue(undefined);
    mockDb.update.mockReturnValue({ set: mockSet, where: mockWhere });

    const res = await request(buildApp())
      .post('/api/interviews/design-docs/doc-1/apply-proposed');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'resolved', resolvedBy: 'user-test' }),
    );
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });
});
