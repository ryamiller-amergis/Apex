/**
 * Integration-style tests for /api/review-comments routes.
 *
 * The key coverage goal is the route-ordering fix: before the fix,
 * POST /:commentId/replies was shadowed by POST /:documentType/:documentId,
 * causing replies to be silently dropped with a 400 "Invalid document type".
 *
 * Additional coverage:
 *  - GET  /:documentType/:documentId  — returns comments list
 *  - POST /:documentType/:documentId  — creates a new comment
 *  - POST /:commentId/replies         — creates a reply (ordering-fix target)
 *  - PATCH /:commentId/resolve        — resolves a comment
 *  - PATCH /:commentId/reopen         — reopens a comment
 *  - DELETE /:commentId               — deletes a comment
 */

import request from 'supertest';
import express from 'express';
import reviewCommentRouter from '../routes/reviewComments';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../middleware/rbac', () => ({
  requirePermission: (..._keys: string[]) =>
    (_req: any, _res: any, next: any) => next(),
  requireAnyPermission: (..._keys: string[]) =>
    (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: jest.fn().mockReturnValue('user-test'),
}));

jest.mock('../services/reviewCommentService', () => ({
  getComments: jest.fn(),
  createComment: jest.fn(),
  addReply: jest.fn(),
  resolveComment: jest.fn(),
  reopenComment: jest.fn(),
  deleteComment: jest.fn(),
  getUnresolvedCount: jest.fn(),
}));

import * as reviewCommentService from '../services/reviewCommentService';
import type { ReviewCommentWithReplies } from '../../shared/types/reviewComments';

const mockService = reviewCommentService as jest.Mocked<typeof reviewCommentService>;

// ── Test app ───────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', reviewCommentRouter);
  return app;
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const commentFixture: ReviewCommentWithReplies = {
  id: 'comment-uuid-1',
  documentId: 'prd-1',
  documentType: 'prd',
  sectionKey: 'prd',
  authorUserId: 'user-test',
  authorDisplayName: 'Test User',
  body: 'This is a comment',
  selector: { exact: 'some text', prefix: '', suffix: '', start: 0, end: 9 },
  status: 'open',
  resolvedBy: null,
  resolvedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  replies: [],
};

const replyFixture = {
  id: 'reply-uuid-1',
  commentId: 'comment-uuid-1',
  authorUserId: 'user-test',
  authorDisplayName: 'Test User',
  body: 'This is a reply',
  createdAt: '2026-01-02T00:00:00Z',
};

// ── GET /:documentType/:documentId ─────────────────────────────────────────────

describe('GET /:documentType/:documentId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with comments array for a valid document type', async () => {
    mockService.getComments.mockResolvedValue([commentFixture]);

    const res = await request(buildApp()).get('/prd/prd-1');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('comment-uuid-1');
  });

  it('returns 400 for an invalid document type', async () => {
    const res = await request(buildApp()).get('/invalid-type/prd-1');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid document type');
  });

  it('accepts design_doc as a valid document type', async () => {
    mockService.getComments.mockResolvedValue([]);

    const res = await request(buildApp()).get('/design_doc/doc-1');

    expect(res.status).toBe(200);
    expect(mockService.getComments).toHaveBeenCalledWith('doc-1', 'design_doc');
  });

  it('accepts adr as a valid document type', async () => {
    mockService.getComments.mockResolvedValue([]);

    const res = await request(buildApp()).get('/adr/adr-1');

    expect(res.status).toBe(200);
    expect(mockService.getComments).toHaveBeenCalledWith('adr-1', 'adr');
  });
});

// ── POST /:documentType/:documentId ────────────────────────────────────────────

describe('POST /:documentType/:documentId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a comment and returns 201', async () => {
    mockService.createComment.mockResolvedValue(commentFixture);

    const res = await request(buildApp())
      .post('/prd/prd-1')
      .send({
        sectionKey: 'prd',
        body: 'This is a comment',
        selector: { exact: 'some text' },
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('comment-uuid-1');
  });

  it('returns 400 when sectionKey is missing', async () => {
    const res = await request(buildApp())
      .post('/prd/prd-1')
      .send({ body: 'A comment', selector: { exact: 'text' } });

    expect(res.status).toBe(400);
    expect(mockService.createComment).not.toHaveBeenCalled();
  });

  it('returns 400 when body is missing', async () => {
    const res = await request(buildApp())
      .post('/prd/prd-1')
      .send({ sectionKey: 'prd', selector: { exact: 'text' } });

    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid document type', async () => {
    const res = await request(buildApp())
      .post('/not-a-valid-type/doc-1')
      .send({ sectionKey: 'prd', body: 'x', selector: { exact: 'y' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid document type');
  });
});

// ── POST /:commentId/replies — the route-ordering fix ─────────────────────────

describe('POST /:commentId/replies (route-ordering fix)', () => {
  beforeEach(() => jest.clearAllMocks());

  /**
   * Before the fix, a UUID comment ID like "a1b2c3d4-..." would match the more
   * general POST /:documentType/:documentId route first, since the replies route
   * was registered after it. The documentType validation would fail with 400.
   *
   * After the fix, the replies route is registered first and wins.
   */
  it('routes correctly when commentId looks like a UUID (not a known document type)', async () => {
    mockService.addReply.mockResolvedValue(replyFixture);

    const uuidCommentId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const res = await request(buildApp())
      .post(`/${uuidCommentId}/replies`)
      .send({ body: 'This is a reply' });

    expect(res.status).toBe(201);
    expect(mockService.addReply).toHaveBeenCalledWith(uuidCommentId, 'user-test', 'This is a reply');
  });

  it('returns 201 with the created reply', async () => {
    mockService.addReply.mockResolvedValue(replyFixture);

    const res = await request(buildApp())
      .post('/comment-uuid-1/replies')
      .send({ body: 'My reply' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('reply-uuid-1');
    expect(res.body.body).toBe('This is a reply');
  });

  it('returns 400 when body is missing', async () => {
    const res = await request(buildApp())
      .post('/comment-uuid-1/replies')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('body is required');
    expect(mockService.addReply).not.toHaveBeenCalled();
  });

  it('forwards service errors as 500', async () => {
    mockService.addReply.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp())
      .post('/comment-uuid-1/replies')
      .send({ body: 'A reply' });

    expect(res.status).toBe(500);
  });
});

// ── PATCH /:commentId/resolve ──────────────────────────────────────────────────

describe('PATCH /:commentId/resolve', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 on success', async () => {
    mockService.resolveComment.mockResolvedValue(undefined);

    const res = await request(buildApp()).patch('/comment-uuid-1/resolve');

    expect(res.status).toBe(200);
    expect(mockService.resolveComment).toHaveBeenCalledWith('comment-uuid-1', 'user-test');
  });

  it('forwards service errors to the error handler', async () => {
    const err: any = new Error('Forbidden');
    err.status = 403;
    mockService.resolveComment.mockRejectedValue(err);

    const res = await request(buildApp()).patch('/comment-uuid-1/resolve');

    expect(res.status).toBe(403);
  });
});

// ── PATCH /:commentId/reopen ───────────────────────────────────────────────────

describe('PATCH /:commentId/reopen', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 on success', async () => {
    mockService.reopenComment.mockResolvedValue(undefined);

    const res = await request(buildApp()).patch('/comment-uuid-1/reopen');

    expect(res.status).toBe(200);
    expect(mockService.reopenComment).toHaveBeenCalledWith('comment-uuid-1', 'user-test');
  });
});

// ── DELETE /:commentId ─────────────────────────────────────────────────────────

describe('DELETE /:commentId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 204 on success', async () => {
    mockService.deleteComment.mockResolvedValue(undefined);

    const res = await request(buildApp()).delete('/comment-uuid-1');

    expect(res.status).toBe(204);
    expect(mockService.deleteComment).toHaveBeenCalledWith('comment-uuid-1', 'user-test');
  });

  it('forwards a 403 from the service', async () => {
    const err: any = new Error('Forbidden');
    err.status = 403;
    mockService.deleteComment.mockRejectedValue(err);

    const res = await request(buildApp()).delete('/comment-uuid-1');

    expect(res.status).toBe(403);
  });
});
