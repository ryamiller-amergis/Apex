/**
 * Integration-style tests for the /api/interviews routes.
 *
 * - interviewService and prdService are fully mocked.
 * - RBAC middleware is mocked to pass-through.
 * - requestUser.getUserId is mocked to return a fixed user ID.
 */
import request from 'supertest';
import express from 'express';
import interviewRouter from '../routes/interviews';
import * as interviewService from '../services/interviewService';
import * as prdService from '../services/prdService';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../services/interviewService');
jest.mock('../services/prdService');
jest.mock('../services/chatAgentService', () => ({
  readOutputPrd: jest.fn().mockReturnValue(null),
  readOutputBacklog: jest.fn().mockReturnValue(null),
  readOutputDesignDoc: jest.fn().mockReturnValue(null),
  readOutputTechSpec: jest.fn().mockReturnValue(null),
  readOutputAssumptions: jest.fn().mockReturnValue(null),
  readOutputValidationScorecard: jest.fn().mockReturnValue(null),
  readOutputValidationScorecardMd: jest.fn().mockReturnValue(null),
  createThread: jest.fn().mockResolvedValue({ id: 'thread-mock' }),
  getThreadAsync: jest.fn().mockResolvedValue(null),
}));

jest.mock('../services/designDocService');
jest.mock('../services/documentApprovalService');
jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn().mockResolvedValue('global-default-model'),
  getAppSetting: jest.fn().mockResolvedValue(null),
  setAppSetting: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../middleware/rbac', () => ({
  requirePermission: (..._keys: string[]) =>
    (_req: any, _res: any, next: any) => next(),
  requireAnyPermission: (..._keys: string[]) =>
    (_req: any, _res: any, next: any) => next(),
  attachPermissions: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: jest.fn().mockReturnValue('user-test'),
}));

const mockInterviewService = interviewService as jest.Mocked<typeof interviewService>;
const mockPrdService = prdService as jest.Mocked<typeof prdService>;

const {
  readOutputPrd: mockReadOutputPrd,
  readOutputBacklog: mockReadOutputBacklog,
  createThread: mockCreateThread,
} = jest.requireMock('../services/chatAgentService') as {
  readOutputPrd: jest.Mock;
  readOutputBacklog: jest.Mock;
  createThread: jest.Mock;
};

const { getSkillConfig: mockGetSkillConfig } = jest.requireMock(
  '../services/projectSettingsService',
) as { getSkillConfig: jest.Mock };

const { getDefaultModel: mockGetDefaultModel } = jest.requireMock(
  '../services/appSettingsService',
) as { getDefaultModel: jest.Mock };

const {
  createDesignDoc: mockCreateDesignDoc,
  startDesignDocWatcher: mockStartDesignDocWatcher,
  getDesignDoc: mockGetDesignDoc,
  listDesignDocs: mockListDesignDocs,
  updateDesignDocContent: mockUpdateDesignDocContent,
  submitForReview: mockSubmitDesignDocForReview,
  withdrawFromReview: mockWithdrawDesignDocFromReview,
  reviewDesignDoc: mockReviewDesignDoc,
  deleteDesignDoc: mockDeleteDesignDoc,
  syncDesignDocContent: mockSyncDesignDocContent,
  markValidationReady: mockMarkValidationReady,
  autoStartValidation: mockAutoStartValidation,
  syncValidationResult: mockSyncValidationResult,
} = jest.requireMock('../services/designDocService') as {
  createDesignDoc: jest.Mock;
  startDesignDocWatcher: jest.Mock;
  getDesignDoc: jest.Mock;
  listDesignDocs: jest.Mock;
  updateDesignDocContent: jest.Mock;
  submitForReview: jest.Mock;
  withdrawFromReview: jest.Mock;
  reviewDesignDoc: jest.Mock;
  deleteDesignDoc: jest.Mock;
  syncDesignDocContent: jest.Mock;
  markValidationReady: jest.Mock;
  autoStartValidation: jest.Mock;
  syncValidationResult: jest.Mock;
};

const {
  getAssignments: mockGetAssignments,
  getAvailableApprovers: mockGetAvailableApprovers,
  reassignApprovers: mockReassignApprovers,
} = jest.requireMock('../services/documentApprovalService') as {
  getAssignments: jest.Mock;
  getAvailableApprovers: jest.Mock;
  reassignApprovers: jest.Mock;
};

// autoStartValidation is called with `.catch()` in the route, so it must return a Promise.
mockAutoStartValidation.mockResolvedValue(undefined);

// ── App factory ────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/interviews', interviewRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = err.status ?? 500;
    res.status(status).json({ error: err.message ?? 'Internal server error' });
  });
  return app;
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const interviewSummary = {
  id: 'interview-1',
  chatThreadId: 'thread-1',
  authorId: 'user-test',
  title: 'Sprint Review',
  project: 'proj-alpha',
  repo: 'org/repo',
  status: 'in_progress' as const,
  prdCount: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const interview = { ...interviewSummary, prds: [] };

const prdSummary = {
  id: 'prd-1',
  interviewId: 'interview-1',
  chatThreadId: 'thread-2',
  authorId: 'user-test',
  project: 'proj-alpha',
  title: 'Feature PRD',
  status: 'draft' as const,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const prd = { ...prdSummary, content: 'PRD content', backlogJson: null };

// ── GET /api/interviews ────────────────────────────────────────────────────────

describe('GET /api/interviews', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with interview list', async () => {
    mockInterviewService.listInterviews.mockResolvedValue([interviewSummary]);

    const res = await request(buildApp()).get('/api/interviews');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: 'interview-1', title: 'Sprint Review' });
  });

  it('passes status filter to the service', async () => {
    mockInterviewService.listInterviews.mockResolvedValue([]);

    await request(buildApp()).get('/api/interviews?status=complete');

    expect(mockInterviewService.listInterviews).toHaveBeenCalledWith('user-test', { status: 'complete' });
  });

  it('passes project filter to the service', async () => {
    mockInterviewService.listInterviews.mockResolvedValue([]);

    await request(buildApp()).get('/api/interviews?project=proj-alpha');

    expect(mockInterviewService.listInterviews).toHaveBeenCalledWith('user-test', { project: 'proj-alpha' });
  });

  it('passes both project and status filters to the service', async () => {
    mockInterviewService.listInterviews.mockResolvedValue([]);

    await request(buildApp()).get('/api/interviews?project=proj-alpha&status=complete');

    expect(mockInterviewService.listInterviews).toHaveBeenCalledWith('user-test', {
      project: 'proj-alpha',
      status: 'complete',
    });
  });

  it('returns only interviews for the requested project', async () => {
    const alphaInterview = { ...interviewSummary, project: 'proj-alpha' };
    mockInterviewService.listInterviews.mockResolvedValue([alphaInterview]);

    const res = await request(buildApp()).get('/api/interviews?project=proj-alpha');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].project).toBe('proj-alpha');
  });

  it('returns 500 when service throws', async () => {
    mockInterviewService.listInterviews.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp()).get('/api/interviews');

    expect(res.status).toBe(500);
  });
});

// ── POST /api/interviews ───────────────────────────────────────────────────────

describe('POST /api/interviews', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 201 with the created interview identifiers', async () => {
    mockInterviewService.createInterview.mockResolvedValue({
      interviewId: 'interview-new',
      threadId: 'thread-new',
    });

    const res = await request(buildApp())
      .post('/api/interviews')
      .send({ project: 'proj', repo: 'org/repo', chatThreadId: 'thread-x' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ interviewId: 'interview-new', threadId: 'thread-new' });
    expect(mockInterviewService.createInterview).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-test', project: 'proj', repo: 'org/repo' }),
    );
  });

  it('returns 400 when project is missing', async () => {
    const res = await request(buildApp())
      .post('/api/interviews')
      .send({ repo: 'org/repo', chatThreadId: 'thread-x' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('project') });
    expect(mockInterviewService.createInterview).not.toHaveBeenCalled();
  });

  it('returns 400 when repo is missing', async () => {
    const res = await request(buildApp())
      .post('/api/interviews')
      .send({ project: 'proj', chatThreadId: 'thread-x' });

    expect(res.status).toBe(400);
    expect(mockInterviewService.createInterview).not.toHaveBeenCalled();
  });

  it('returns 400 when chatThreadId is missing', async () => {
    const res = await request(buildApp())
      .post('/api/interviews')
      .send({ project: 'proj', repo: 'org/repo' });

    expect(res.status).toBe(400);
    expect(mockInterviewService.createInterview).not.toHaveBeenCalled();
  });
});

// ── GET /api/interviews/:id ────────────────────────────────────────────────────

describe('GET /api/interviews/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with the interview', async () => {
    mockInterviewService.getInterview.mockResolvedValue(interview);

    const res = await request(buildApp()).get('/api/interviews/interview-1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'interview-1' });
  });

  it('returns 404 when the interview does not exist', async () => {
    mockInterviewService.getInterview.mockResolvedValue(null);

    const res = await request(buildApp()).get('/api/interviews/interview-missing');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Interview not found' });
  });
});

// ── PATCH /api/interviews/:id ──────────────────────────────────────────────────

describe('PATCH /api/interviews/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates the status and returns { ok: true }', async () => {
    mockInterviewService.updateInterviewStatus.mockResolvedValue(undefined);

    const res = await request(buildApp())
      .patch('/api/interviews/interview-1')
      .send({ status: 'complete' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockInterviewService.updateInterviewStatus).toHaveBeenCalledWith('interview-1', 'user-test', 'complete');
  });

  it('updates the title and returns { ok: true }', async () => {
    mockInterviewService.updateInterviewTitle.mockResolvedValue(undefined);

    const res = await request(buildApp())
      .patch('/api/interviews/interview-1')
      .send({ title: 'New Title' });

    expect(res.status).toBe(200);
    expect(mockInterviewService.updateInterviewTitle).toHaveBeenCalledWith('interview-1', 'user-test', 'New Title');
  });

  it('propagates service errors as HTTP errors', async () => {
    const err = Object.assign(new Error('Interview not found'), { status: 404 });
    mockInterviewService.updateInterviewStatus.mockRejectedValue(err);

    const res = await request(buildApp())
      .patch('/api/interviews/interview-1')
      .send({ status: 'complete' });

    expect(res.status).toBe(404);
  });
});

// ── DELETE /api/interviews/:id ─────────────────────────────────────────────────

describe('DELETE /api/interviews/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 204 on successful delete', async () => {
    mockInterviewService.deleteInterview.mockResolvedValue(undefined);

    const res = await request(buildApp()).delete('/api/interviews/interview-1');

    expect(res.status).toBe(204);
    expect(mockInterviewService.deleteInterview).toHaveBeenCalledWith('interview-1', 'user-test');
  });

  it('propagates service errors (e.g. 403)', async () => {
    const err = Object.assign(new Error('Only the author can delete the interview'), { status: 403 });
    mockInterviewService.deleteInterview.mockRejectedValue(err);

    const res = await request(buildApp()).delete('/api/interviews/interview-1');

    expect(res.status).toBe(403);
  });
});

// ── GET /api/interviews/prds ───────────────────────────────────────────────────

describe('GET /api/interviews/prds', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with the PRD list', async () => {
    mockPrdService.listPrds.mockResolvedValue([prdSummary]);

    const res = await request(buildApp()).get('/api/interviews/prds');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: 'prd-1' });
  });

  it('passes status filter to listPrds', async () => {
    mockPrdService.listPrds.mockResolvedValue([]);

    await request(buildApp()).get('/api/interviews/prds?status=approved');

    expect(mockPrdService.listPrds).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved' }),
    );
  });

  it('passes project filter to listPrds', async () => {
    mockPrdService.listPrds.mockResolvedValue([]);

    await request(buildApp()).get('/api/interviews/prds?project=proj-alpha');

    expect(mockPrdService.listPrds).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'proj-alpha' }),
    );
  });

  it('passes both project and status filters to listPrds', async () => {
    mockPrdService.listPrds.mockResolvedValue([]);

    await request(buildApp()).get('/api/interviews/prds?project=proj-alpha&status=draft');

    expect(mockPrdService.listPrds).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'proj-alpha', status: 'draft' }),
    );
  });

  it('returns only PRDs for the requested project', async () => {
    const alphaPrd = { ...prdSummary, id: 'prd-alpha' };
    mockPrdService.listPrds.mockResolvedValue([alphaPrd]);

    const res = await request(buildApp()).get('/api/interviews/prds?project=proj-alpha');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('prd-alpha');
  });
});

// ── GET /api/interviews/prds/:prdId ───────────────────────────────────────────

describe('GET /api/interviews/prds/:prdId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with the PRD', async () => {
    mockPrdService.getPrd.mockResolvedValue(prd);

    const res = await request(buildApp()).get('/api/interviews/prds/prd-1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'prd-1', content: 'PRD content' });
  });

  it('returns 404 when the PRD does not exist', async () => {
    mockPrdService.getPrd.mockResolvedValue(null);

    const res = await request(buildApp()).get('/api/interviews/prds/prd-missing');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'PRD not found' });
  });
});

// ── DELETE /api/interviews/prds/:prdId ────────────────────────────────────────

describe('DELETE /api/interviews/prds/:prdId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 204 on successful delete', async () => {
    mockPrdService.deletePrd.mockResolvedValue(undefined);

    const res = await request(buildApp()).delete('/api/interviews/prds/prd-1');

    expect(res.status).toBe(204);
    expect(mockPrdService.deletePrd).toHaveBeenCalledWith('prd-1', 'user-test');
  });
});

// ── PUT /api/interviews/prds/:prdId/content ───────────────────────────────────

describe('PUT /api/interviews/prds/:prdId/content', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 { ok: true } on success', async () => {
    mockPrdService.updatePrdContent.mockResolvedValue(undefined);

    const res = await request(buildApp())
      .put('/api/interviews/prds/prd-1/content')
      .send({ content: 'Updated content' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockPrdService.updatePrdContent).toHaveBeenCalledWith('prd-1', 'user-test', 'Updated content');
  });

  it('returns 400 when content is not a string', async () => {
    const res = await request(buildApp())
      .put('/api/interviews/prds/prd-1/content')
      .send({ content: 123 });

    expect(res.status).toBe(400);
    expect(mockPrdService.updatePrdContent).not.toHaveBeenCalled();
  });

  it('propagates service errors', async () => {
    const err = Object.assign(new Error('Approved PRDs cannot be edited'), { status: 409 });
    mockPrdService.updatePrdContent.mockRejectedValue(err);

    const res = await request(buildApp())
      .put('/api/interviews/prds/prd-1/content')
      .send({ content: 'x' });

    expect(res.status).toBe(409);
  });
});

// ── POST /api/interviews/prds/:prdId/submit ───────────────────────────────────

describe('POST /api/interviews/prds/:prdId/submit', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 { ok: true } on success', async () => {
    mockPrdService.submitForReview.mockResolvedValue(undefined);

    const res = await request(buildApp()).post('/api/interviews/prds/prd-1/submit');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockPrdService.submitForReview).toHaveBeenCalledWith('prd-1', 'user-test', { prdApproverIds: [], designDocApproverIds: [] });
  });

  it('propagates 409 conflict from service', async () => {
    const err = Object.assign(new Error('PRD content must be non-empty before submitting for review'), { status: 409 });
    mockPrdService.submitForReview.mockRejectedValue(err);

    const res = await request(buildApp()).post('/api/interviews/prds/prd-1/submit');

    expect(res.status).toBe(409);
  });
});

// ── POST /api/interviews/prds/:prdId/withdraw ─────────────────────────────────

describe('POST /api/interviews/prds/:prdId/withdraw', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 { ok: true } on success', async () => {
    mockPrdService.withdrawFromReview.mockResolvedValue(undefined);

    const res = await request(buildApp()).post('/api/interviews/prds/prd-1/withdraw');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

// ── POST /api/interviews/prds/:prdId/review ───────────────────────────────────

describe('POST /api/interviews/prds/:prdId/review', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 { ok: true } on approve', async () => {
    mockPrdService.reviewPrd.mockResolvedValue(undefined);

    const res = await request(buildApp())
      .post('/api/interviews/prds/prd-1/review')
      .send({ action: 'approve' });

    expect(res.status).toBe(200);
    expect(mockPrdService.reviewPrd).toHaveBeenCalledWith('prd-1', 'user-test', { action: 'approve' });
  });

  it('propagates 403 when author tries to self-review', async () => {
    const err = Object.assign(new Error('You cannot review your own PRD'), { status: 403 });
    mockPrdService.reviewPrd.mockRejectedValue(err);

    const res = await request(buildApp())
      .post('/api/interviews/prds/prd-1/review')
      .send({ action: 'approve' });

    expect(res.status).toBe(403);
  });
});

// ── POST /api/interviews/prds/:prdId/sync ─────────────────────────────────────

describe('POST /api/interviews/prds/:prdId/sync', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with content when output files are ready', async () => {
    mockPrdService.getPrd.mockResolvedValue(prd);
    mockReadOutputPrd.mockReturnValue('# Generated PRD');
    mockReadOutputBacklog.mockReturnValue({ items: [] });
    mockPrdService.syncPrdContent.mockResolvedValue(undefined);

    const res = await request(buildApp()).post('/api/interviews/prds/prd-1/sync');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, content: '# Generated PRD' });
    expect(mockPrdService.syncPrdContent).toHaveBeenCalledWith('prd-1', '# Generated PRD', { items: [] });
  });

  it('returns 404 when PRD does not exist', async () => {
    mockPrdService.getPrd.mockResolvedValue(null);

    const res = await request(buildApp()).post('/api/interviews/prds/prd-missing/sync');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'PRD not found' });
  });

  it('returns 404 when PRD output is not yet available', async () => {
    mockPrdService.getPrd.mockResolvedValue(prd);
    mockReadOutputPrd.mockReturnValue(null);

    const res = await request(buildApp()).post('/api/interviews/prds/prd-1/sync');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'PRD output not yet available from generation thread' });
  });

  it('returns 400 when PRD has no associated chat thread', async () => {
    mockPrdService.getPrd.mockResolvedValue({ ...prd, chatThreadId: '' });

    const res = await request(buildApp()).post('/api/interviews/prds/prd-1/sync');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'PRD has no associated chat thread' });
  });
});

// ── POST /api/interviews/:interviewId/prds ────────────────────────────────────

describe('POST /api/interviews/:interviewId/prds', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 201 with prdId and threadId and starts the watcher', async () => {
    mockInterviewService.getInterview.mockResolvedValue(interview);
    mockPrdService.createPrd.mockResolvedValue({ prdId: 'prd-new', threadId: 'thread-new' });
    mockPrdService.startPrdWatcher.mockReturnValue(undefined);

    const res = await request(buildApp())
      .post('/api/interviews/interview-1/prds')
      .send({ chatThreadId: 'thread-new', title: 'My PRD' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ prdId: 'prd-new' });
    expect(mockPrdService.createPrd).toHaveBeenCalledWith({
      interviewId: 'interview-1',
      project: 'proj-alpha',
      userId: 'user-test',
      chatThreadId: 'thread-new',
      title: 'My PRD',
    });
    expect(mockPrdService.startPrdWatcher).toHaveBeenCalledWith('prd-new', 'thread-new');
  });

  it('returns 404 when interview does not exist', async () => {
    mockInterviewService.getInterview.mockResolvedValue(null);

    const res = await request(buildApp())
      .post('/api/interviews/interview-missing/prds')
      .send({ chatThreadId: 'thread-new' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Interview not found' });
  });

  it('returns 400 when chatThreadId is missing', async () => {
    const res = await request(buildApp())
      .post('/api/interviews/interview-1/prds')
      .send({ title: 'My PRD' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'chatThreadId is required' });
    expect(mockPrdService.createPrd).not.toHaveBeenCalled();
  });
});

// ── POST /api/interviews/prds/:prdId/review — design doc model resolution ─────

describe('POST /api/interviews/prds/:prdId/review (approve) — design doc model resolution', () => {
  const approvedPrd = { ...prd, status: 'pending_review' as const };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrdService.reviewPrd.mockResolvedValue(undefined);
    mockCreateDesignDoc.mockResolvedValue({ designDocId: 'design-doc-1' });
    mockStartDesignDocWatcher.mockReturnValue(undefined);
  });

  it('passes designDocModel from skillConfig to createThread when set', async () => {
    mockPrdService.getPrd.mockResolvedValue(approvedPrd);
    mockGetSkillConfig.mockResolvedValue({
      project: 'proj-alpha',
      skillRepo: 'org/skills',
      skillBranch: 'main',
      designDocSkillPath: null,
      designDocModel: 'gpt-4o',
    });

    await request(buildApp())
      .post('/api/interviews/prds/prd-1/review')
      .send({ action: 'approve' });

    expect(mockCreateThread).toHaveBeenCalledWith(
      'user-test',
      expect.objectContaining({ model: 'gpt-4o' }),
    );
  });

  it('falls back to global default model when skillConfig.designDocModel is null', async () => {
    mockPrdService.getPrd.mockResolvedValue(approvedPrd);
    mockGetSkillConfig.mockResolvedValue({
      project: 'proj-alpha',
      skillRepo: 'org/skills',
      skillBranch: 'main',
      designDocSkillPath: null,
      designDocModel: null,
    });
    mockGetDefaultModel.mockResolvedValue('claude-3.5-sonnet');

    await request(buildApp())
      .post('/api/interviews/prds/prd-1/review')
      .send({ action: 'approve' });

    expect(mockCreateThread).toHaveBeenCalledWith(
      'user-test',
      expect.objectContaining({ model: 'claude-3.5-sonnet' }),
    );
  });

  it('falls back to global default model when skillConfig is null (no config for project)', async () => {
    mockPrdService.getPrd.mockResolvedValue(approvedPrd);
    mockGetSkillConfig.mockResolvedValue(null);
    mockGetDefaultModel.mockResolvedValue('claude-3.5-sonnet');

    await request(buildApp())
      .post('/api/interviews/prds/prd-1/review')
      .send({ action: 'approve' });

    expect(mockCreateThread).toHaveBeenCalledWith(
      'user-test',
      expect.objectContaining({ model: 'claude-3.5-sonnet' }),
    );
  });

  it('returns 200 { ok: true, designDocId } on successful approval with design doc creation', async () => {
    mockPrdService.getPrd.mockResolvedValue(approvedPrd);
    mockGetSkillConfig.mockResolvedValue({
      project: 'proj-alpha',
      skillRepo: 'org/skills',
      skillBranch: 'main',
      designDocSkillPath: null,
      designDocModel: 'gpt-4o',
    });

    const res = await request(buildApp())
      .post('/api/interviews/prds/prd-1/review')
      .send({ action: 'approve' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, designDocId: 'design-doc-1' });
  });
});

// ── POST /api/interviews/prds/:prdId/design-docs — model resolution ───────────

describe('POST /api/interviews/prds/:prdId/design-docs — design doc model resolution', () => {
  const approvedPrd = { ...prd, status: 'approved' as const };

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateDesignDoc.mockResolvedValue({ designDocId: 'design-doc-1' });
    mockStartDesignDocWatcher.mockReturnValue(undefined);
  });

  it('passes designDocModel from skillConfig to createThread when set', async () => {
    mockPrdService.getPrd.mockResolvedValue(approvedPrd);
    mockGetSkillConfig.mockResolvedValue({
      project: 'proj-alpha',
      skillRepo: 'org/skills',
      skillBranch: 'main',
      designDocSkillPath: null,
      designDocModel: 'claude-3-opus',
    });

    await request(buildApp()).post('/api/interviews/prds/prd-1/design-docs');

    expect(mockCreateThread).toHaveBeenCalledWith(
      'user-test',
      expect.objectContaining({ model: 'claude-3-opus' }),
    );
  });

  it('falls back to global default model when skillConfig.designDocModel is null', async () => {
    mockPrdService.getPrd.mockResolvedValue(approvedPrd);
    mockGetSkillConfig.mockResolvedValue({
      project: 'proj-alpha',
      skillRepo: 'org/skills',
      skillBranch: 'main',
      designDocSkillPath: null,
      designDocModel: null,
    });
    mockGetDefaultModel.mockResolvedValue('global-default-model');

    await request(buildApp()).post('/api/interviews/prds/prd-1/design-docs');

    expect(mockCreateThread).toHaveBeenCalledWith(
      'user-test',
      expect.objectContaining({ model: 'global-default-model' }),
    );
  });

  it('falls back to global default model when there is no skill config for the project', async () => {
    mockPrdService.getPrd.mockResolvedValue(approvedPrd);
    mockGetSkillConfig.mockResolvedValue(null);
    mockGetDefaultModel.mockResolvedValue('global-default-model');

    await request(buildApp()).post('/api/interviews/prds/prd-1/design-docs');

    expect(mockCreateThread).toHaveBeenCalledWith(
      'user-test',
      expect.objectContaining({ model: 'global-default-model' }),
    );
  });

  it('returns 201 with designDocId and threadId', async () => {
    mockPrdService.getPrd.mockResolvedValue(approvedPrd);
    mockGetSkillConfig.mockResolvedValue({
      project: 'proj-alpha',
      skillRepo: 'org/skills',
      skillBranch: 'main',
      designDocSkillPath: null,
      designDocModel: 'gpt-4o',
    });

    const res = await request(buildApp()).post('/api/interviews/prds/prd-1/design-docs');

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ designDocId: 'design-doc-1', threadId: 'thread-mock' });
  });

  it('returns 404 when the PRD does not exist', async () => {
    mockPrdService.getPrd.mockResolvedValue(null);

    const res = await request(buildApp()).post('/api/interviews/prds/prd-missing/design-docs');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'PRD not found' });
  });

  it('returns 409 when the PRD is not approved', async () => {
    mockPrdService.getPrd.mockResolvedValue({ ...prd, status: 'draft' as const });

    const res = await request(buildApp()).post('/api/interviews/prds/prd-1/design-docs');

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'Design docs can only be created from approved PRDs' });
  });
});

// ── Design Doc fixtures ────────────────────────────────────────────────────────

const designDocSummary = {
  id: 'dd-1',
  prdId: 'prd-1',
  project: 'proj-alpha',
  chatThreadId: 'thread-dd',
  authorId: 'user-test',
  title: 'Feature Design',
  status: 'draft' as const,
  designContent: 'Design',
  techSpecContent: 'Tech',
  assumptionsContent: 'Assumptions',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

// ── GET /api/interviews/design-docs ───────────────────────────────────────────

describe('GET /api/interviews/design-docs', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with design doc list', async () => {
    mockListDesignDocs.mockResolvedValue([designDocSummary]);

    const res = await request(buildApp()).get('/api/interviews/design-docs');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: 'dd-1', title: 'Feature Design' });
  });

  it('passes project filter', async () => {
    mockListDesignDocs.mockResolvedValue([]);

    await request(buildApp()).get('/api/interviews/design-docs?project=proj-alpha');

    expect(mockListDesignDocs).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'proj-alpha' }),
    );
  });

  it('passes status filter', async () => {
    mockListDesignDocs.mockResolvedValue([]);

    await request(buildApp()).get('/api/interviews/design-docs?status=approved');

    expect(mockListDesignDocs).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved' }),
    );
  });
});

// ── GET /api/interviews/design-docs/:id ───────────────────────────────────────

describe('GET /api/interviews/design-docs/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with the design doc', async () => {
    mockGetDesignDoc.mockResolvedValue(designDocSummary);

    const res = await request(buildApp()).get('/api/interviews/design-docs/dd-1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'dd-1' });
  });

  it('returns 404 when design doc does not exist', async () => {
    mockGetDesignDoc.mockResolvedValue(null);

    const res = await request(buildApp()).get('/api/interviews/design-docs/dd-missing');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Design doc not found' });
  });
});

// ── PUT /api/interviews/design-docs/:id/content ──────────────────────────────

describe('PUT /api/interviews/design-docs/:id/content', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 on success', async () => {
    mockUpdateDesignDocContent.mockResolvedValue(undefined);

    const res = await request(buildApp())
      .put('/api/interviews/design-docs/dd-1/content')
      .send({ designContent: 'Updated design' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockUpdateDesignDocContent).toHaveBeenCalledWith(
      'dd-1',
      'user-test',
      { designContent: 'Updated design', techSpecContent: undefined, assumptionsContent: undefined },
    );
  });

  it('returns 400 when no content fields provided', async () => {
    const res = await request(buildApp())
      .put('/api/interviews/design-docs/dd-1/content')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'at least one content field must be provided' });
  });

  it('returns 400 when content field is not a string', async () => {
    const res = await request(buildApp())
      .put('/api/interviews/design-docs/dd-1/content')
      .send({ designContent: 123 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'content fields must be strings' });
  });

  it('propagates service errors', async () => {
    const err = Object.assign(new Error('Approved design docs cannot be edited'), { status: 409 });
    mockUpdateDesignDocContent.mockRejectedValue(err);

    const res = await request(buildApp())
      .put('/api/interviews/design-docs/dd-1/content')
      .send({ designContent: 'x' });

    expect(res.status).toBe(409);
  });
});

// ── POST /api/interviews/design-docs/:id/submit ──────────────────────────────

describe('POST /api/interviews/design-docs/:id/submit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAutoStartValidation.mockResolvedValue(undefined);
  });

  it('returns 200 on success', async () => {
    mockSubmitDesignDocForReview.mockResolvedValue(undefined);

    const res = await request(buildApp()).post('/api/interviews/design-docs/dd-1/submit');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('propagates service errors', async () => {
    const err = Object.assign(new Error('Cannot submit'), { status: 409 });
    mockSubmitDesignDocForReview.mockRejectedValue(err);

    const res = await request(buildApp()).post('/api/interviews/design-docs/dd-1/submit');

    expect(res.status).toBe(409);
  });
});

// ── POST /api/interviews/design-docs/:id/withdraw ────────────────────────────

describe('POST /api/interviews/design-docs/:id/withdraw', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 on success', async () => {
    mockWithdrawDesignDocFromReview.mockResolvedValue(undefined);

    const res = await request(buildApp()).post('/api/interviews/design-docs/dd-1/withdraw');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

// ── POST /api/interviews/design-docs/:id/review ──────────────────────────────

describe('POST /api/interviews/design-docs/:id/review', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 on approve', async () => {
    mockReviewDesignDoc.mockResolvedValue(undefined);

    const res = await request(buildApp())
      .post('/api/interviews/design-docs/dd-1/review')
      .send({ action: 'approve' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockReviewDesignDoc).toHaveBeenCalledWith('dd-1', 'user-test', { action: 'approve' });
  });

  it('propagates 403 when author tries to self-review', async () => {
    const err = Object.assign(new Error('You cannot review your own design doc'), { status: 403 });
    mockReviewDesignDoc.mockRejectedValue(err);

    const res = await request(buildApp())
      .post('/api/interviews/design-docs/dd-1/review')
      .send({ action: 'approve' });

    expect(res.status).toBe(403);
  });
});

// ── DELETE /api/interviews/design-docs/:id ────────────────────────────────────

describe('DELETE /api/interviews/design-docs/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 204 on success', async () => {
    mockDeleteDesignDoc.mockResolvedValue(undefined);

    const res = await request(buildApp()).delete('/api/interviews/design-docs/dd-1');

    expect(res.status).toBe(204);
    expect(mockDeleteDesignDoc).toHaveBeenCalledWith('dd-1', 'user-test');
  });

  it('propagates 403 when non-author tries to delete', async () => {
    const err = Object.assign(new Error('Only the author can delete this design doc'), { status: 403 });
    mockDeleteDesignDoc.mockRejectedValue(err);

    const res = await request(buildApp()).delete('/api/interviews/design-docs/dd-1');

    expect(res.status).toBe(403);
  });
});

// ── POST /api/interviews/design-docs/:id/validation/mark-ready ───────────────

describe('POST /api/interviews/design-docs/:id/validation/mark-ready', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 on success', async () => {
    mockMarkValidationReady.mockResolvedValue(undefined);

    const res = await request(buildApp()).post('/api/interviews/design-docs/dd-1/validation/mark-ready');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockMarkValidationReady).toHaveBeenCalledWith('dd-1', 'user-test');
  });

  it('propagates 409 when score is too low', async () => {
    const err = Object.assign(new Error('Validation score must be >= 90'), { status: 409 });
    mockMarkValidationReady.mockRejectedValue(err);

    const res = await request(buildApp()).post('/api/interviews/design-docs/dd-1/validation/mark-ready');

    expect(res.status).toBe(409);
  });
});

// ── GET /api/interviews/design-docs/:id/validation ───────────────────────────

describe('GET /api/interviews/design-docs/:id/validation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns validation state', async () => {
    mockGetDesignDoc.mockResolvedValue({
      ...designDocSummary,
      validationThreadId: 'val-thread-1',
      validationScore: 92,
      validationScorecard: { overall_score: 92 },
      validationPhase: 'final',
    });

    const res = await request(buildApp()).get('/api/interviews/design-docs/dd-1/validation');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      validationThreadId: 'val-thread-1',
      validationScore: 92,
      validationPhase: 'final',
    });
  });

  it('returns 404 when design doc not found', async () => {
    mockGetDesignDoc.mockResolvedValue(null);

    const res = await request(buildApp()).get('/api/interviews/design-docs/dd-missing/validation');

    expect(res.status).toBe(404);
  });
});

// ── GET /api/interviews/prds/:prdId/assignments ──────────────────────────────

describe('GET /api/interviews/prds/:prdId/assignments', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with assignment array', async () => {
    const assignments = [
      { id: 'assign-1', documentId: 'prd-1', documentType: 'prd', approverUserId: 'u1', approverDisplayName: 'Alice', status: 'pending' },
    ];
    mockGetAssignments.mockResolvedValue(assignments);

    const res = await request(buildApp()).get('/api/interviews/prds/prd-1/assignments');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: 'assign-1', approverDisplayName: 'Alice' });
    expect(mockGetAssignments).toHaveBeenCalledWith('prd-1', 'prd');
  });

  it('returns 200 with empty array when no assignments', async () => {
    mockGetAssignments.mockResolvedValue([]);

    const res = await request(buildApp()).get('/api/interviews/prds/prd-1/assignments');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ── GET /api/interviews/design-docs/:id/assignments ──────────────────────────

describe('GET /api/interviews/design-docs/:id/assignments', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with assignment array', async () => {
    const assignments = [
      { id: 'assign-1', documentId: 'dd-1', documentType: 'design_doc', approverUserId: 'u1', approverDisplayName: 'Alice', status: 'approved' },
    ];
    mockGetAssignments.mockResolvedValue(assignments);

    const res = await request(buildApp()).get('/api/interviews/design-docs/dd-1/assignments');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockGetAssignments).toHaveBeenCalledWith('dd-1', 'design_doc');
  });
});

// ── GET /api/interviews/available-approvers/:project/:documentType ────────────

describe('GET /api/interviews/available-approvers/:project/:documentType', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with available approvers for prd type', async () => {
    const approvers = [
      { userId: 'u1', displayName: 'Alice' },
      { userId: 'u2', displayName: 'Bob' },
    ];
    mockGetAvailableApprovers.mockResolvedValue(approvers);

    const res = await request(buildApp()).get('/api/interviews/available-approvers/proj-alpha/prd?excludeSelf=true');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(mockGetAvailableApprovers).toHaveBeenCalledWith('proj-alpha', 'prd', 'user-test');
  });

  it('returns 200 with available approvers for design_doc type', async () => {
    mockGetAvailableApprovers.mockResolvedValue([]);

    const res = await request(buildApp()).get('/api/interviews/available-approvers/proj-alpha/design_doc?excludeSelf=true');

    expect(res.status).toBe(200);
    expect(mockGetAvailableApprovers).toHaveBeenCalledWith('proj-alpha', 'design_doc', 'user-test');
  });

  it('passes undefined excludeUserId when excludeSelf is not set', async () => {
    mockGetAvailableApprovers.mockResolvedValue([]);

    const res = await request(buildApp()).get('/api/interviews/available-approvers/proj-alpha/prd');

    expect(res.status).toBe(200);
    expect(mockGetAvailableApprovers).toHaveBeenCalledWith('proj-alpha', 'prd', undefined);
  });

  it('returns 400 for invalid documentType', async () => {
    const res = await request(buildApp()).get('/api/interviews/available-approvers/proj-alpha/invalid');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'documentType must be "prd" or "design_doc"' });
  });
});

// ── PUT /api/interviews/prds/:prdId/assignments ───────────────────────────────

describe('PUT /api/interviews/prds/:prdId/assignments', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with updated assignments', async () => {
    const assignments = [
      { id: 'a1', documentId: 'prd-1', documentType: 'prd', approverUserId: 'u1', approverDisplayName: 'Alice', status: 'pending' },
    ];
    mockReassignApprovers.mockResolvedValue(assignments);

    const res = await request(buildApp())
      .put('/api/interviews/prds/prd-1/assignments')
      .send({ approverUserIds: ['u1'] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: 'a1', approverDisplayName: 'Alice' });
    expect(mockReassignApprovers).toHaveBeenCalledWith('prd-1', 'prd', ['u1'], 'user-test');
  });

  it('returns 200 with empty array to clear all pending approvers', async () => {
    mockReassignApprovers.mockResolvedValue([]);

    const res = await request(buildApp())
      .put('/api/interviews/prds/prd-1/assignments')
      .send({ approverUserIds: [] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 400 when approverUserIds is missing', async () => {
    const res = await request(buildApp())
      .put('/api/interviews/prds/prd-1/assignments')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'approverUserIds is required and must be an array' });
    expect(mockReassignApprovers).not.toHaveBeenCalled();
  });

  it('returns 400 when approverUserIds is not an array', async () => {
    const res = await request(buildApp())
      .put('/api/interviews/prds/prd-1/assignments')
      .send({ approverUserIds: 'u1' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'approverUserIds is required and must be an array' });
  });
});

// ── PUT /api/interviews/design-docs/:id/assignments ───────────────────────────

describe('PUT /api/interviews/design-docs/:id/assignments', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with updated assignments', async () => {
    const assignments = [
      { id: 'a1', documentId: 'dd-1', documentType: 'design_doc', approverUserId: 'u2', approverDisplayName: 'Bob', status: 'pending' },
    ];
    mockReassignApprovers.mockResolvedValue(assignments);

    const res = await request(buildApp())
      .put('/api/interviews/design-docs/dd-1/assignments')
      .send({ approverUserIds: ['u2'] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockReassignApprovers).toHaveBeenCalledWith('dd-1', 'design_doc', ['u2'], 'user-test');
  });

  it('returns 400 when approverUserIds is missing', async () => {
    const res = await request(buildApp())
      .put('/api/interviews/design-docs/dd-1/assignments')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'approverUserIds is required and must be an array' });
    expect(mockReassignApprovers).not.toHaveBeenCalled();
  });
});
