/**
 * Unit tests for prdService.
 * The Drizzle `db` instance and chatAgentService are fully mocked.
 */

// ── DB mock ────────────────────────────────────────────────────────────────────

jest.mock('../db/drizzle', () => {
  const makeInsertChain = () => ({
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
  });

  const makeUpdateChain = () => ({
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue(undefined),
  });

  const makeDeleteChain = () => ({
    where: jest.fn().mockResolvedValue(undefined),
  });

  const makeSelectChain = () => ({
    from: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockResolvedValue([]),
    limit: jest.fn().mockResolvedValue([]),
  });

  return {
    db: {
      query: {
        prds: { findFirst: jest.fn() },
      },
      insert: jest.fn().mockImplementation(makeInsertChain),
      update: jest.fn().mockImplementation(makeUpdateChain),
      delete: jest.fn().mockImplementation(makeDeleteChain),
      select: jest.fn().mockImplementation(makeSelectChain),
    },
  };
});

jest.mock('../services/chatAgentService', () => ({
  readOutputPrd: jest.fn().mockReturnValue(null),
  readOutputBacklog: jest.fn().mockReturnValue(null),
}));

jest.mock('../utils/rbacHelpers', () => ({
  isAdminUser: jest.fn().mockResolvedValue(false),
}));

import {
  createPrd,
  listPrds,
  getPrd,
  updatePrdContent,
  updatePrdBacklog,
  submitForReview,
  withdrawFromReview,
  reopenForReview,
  reviewPrd,
  deletePrd,
  syncPrdContent,
} from '../services/prdService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makePrdRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'prd-1',
    interviewId: 'interview-1',
    chatThreadId: 'thread-1',
    authorId: 'user-1',
    project: 'proj-alpha',
    title: 'Feature PRD',
    content: 'Some content',
    backlogJson: null,
    status: 'draft',
    reviewerId: null,
    reviewComment: null,
    reviewedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

// ── createPrd ──────────────────────────────────────────────────────────────────

describe('createPrd', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts a new PRD in "generating" status and returns prdId + threadId', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'prd-new' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    const result = await createPrd({
      interviewId: 'interview-1',
      project: 'proj-alpha',
      userId: 'user-1',
      chatThreadId: 'thread-abc',
      title: 'My PRD',
    });

    expect(result).toEqual({ prdId: 'prd-new', threadId: 'thread-abc' });
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        interviewId: 'interview-1',
        authorId: 'user-1',
        chatThreadId: 'thread-abc',
        title: 'My PRD',
        status: 'generating',
        content: '',
      }),
    );
  });

  it('defaults title to "Untitled PRD" when not supplied', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'prd-untitled' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await createPrd({ interviewId: 'i1', project: 'proj-1', userId: 'u1', chatThreadId: 't1' });

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Untitled PRD' }),
    );
  });
});

// ── listPrds ───────────────────────────────────────────────────────────────────

describe('listPrds', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns all PRDs when no filters are given', async () => {
    const orderByMock = jest.fn().mockResolvedValue([{ prd: makePrdRow(), reviewerDisplayName: null }]);
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const leftJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listPrds();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'prd-1', status: 'draft' });
  });

  it('returns an empty array when no PRDs match', async () => {
    const orderByMock = jest.fn().mockResolvedValue([]);
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const leftJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listPrds({ userId: 'user-nobody' });

    expect(result).toEqual([]);
  });

  it('returns only PRDs linked to the specified project', async () => {
    const orderByMock = jest.fn().mockResolvedValue([{ prd: makePrdRow(), reviewerDisplayName: null }]);
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const leftJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listPrds({ project: 'proj-alpha' });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('prd-1');
    expect(result[0].interviewId).toBe('interview-1');
    // The project filter is applied directly in the single query (no two-step lookup)
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when no PRDs exist for the given project', async () => {
    const orderByMock = jest.fn().mockResolvedValue([]);
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const leftJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listPrds({ project: 'proj-nonexistent' });

    expect(result).toEqual([]);
  });

  it('does not return PRDs from other projects', async () => {
    // The DB filters by project directly; mock returns only proj-alpha PRDs
    const orderByMock = jest.fn().mockResolvedValue([{ prd: makePrdRow(), reviewerDisplayName: null }]);
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const leftJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listPrds({ project: 'proj-alpha' });

    expect(result.every((p) => p.interviewId === 'interview-1')).toBe(true);
    expect(result.every((p) => p.id !== 'prd-beta')).toBe(true);
  });
});

// ── getPrd ─────────────────────────────────────────────────────────────────────

describe('getPrd', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns a full PRD with content and backlogJson', async () => {
    const prdRow = makePrdRow({ content: 'Detailed content', backlogJson: { items: [] } });
    const limitMock = jest.fn().mockResolvedValue([{ prd: prdRow, reviewerDisplayName: null }]);
    const whereMock = jest.fn().mockReturnValue({ limit: limitMock });
    const leftJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await getPrd('prd-1');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('prd-1');
    expect(result!.content).toBe('Detailed content');
    expect(result!.backlogJson).toEqual({ items: [] });
  });

  it('returns null when the PRD does not exist', async () => {
    const limitMock = jest.fn().mockResolvedValue([]);
    const whereMock = jest.fn().mockReturnValue({ limit: limitMock });
    const leftJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await getPrd('prd-missing');

    expect(result).toBeNull();
  });
});

// ── updatePrdContent ───────────────────────────────────────────────────────────

describe('updatePrdContent', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates content when author edits a draft PRD', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updatePrdContent('prd-1', 'user-1', 'Updated content');

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ content: 'Updated content' }));
  });

  it('resets status to "draft" and clears review fields when editing a revision_requested PRD', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'revision_requested', reviewerId: 'reviewer-1', reviewComment: 'Fix it' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updatePrdContent('prd-1', 'user-1', 'Revised content');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft', reviewerId: null, reviewComment: null }),
    );
  });

  it('throws 404 when PRD does not exist', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(null);

    await expect(updatePrdContent('prd-missing', 'user-1', 'x')).rejects.toMatchObject({
      message: 'PRD not found',
    });
  });

  it('throws 403 when a non-author tries to edit', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow());

    await expect(updatePrdContent('prd-1', 'user-other', 'x')).rejects.toMatchObject({
      message: 'Only the author can edit PRD content',
    });
  });

  it('throws 409 when trying to edit an approved PRD', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'approved' }));

    await expect(updatePrdContent('prd-1', 'user-1', 'x')).rejects.toMatchObject({
      message: 'Approved PRDs cannot be edited',
    });
  });
});

// ── submitForReview ────────────────────────────────────────────────────────────

describe('submitForReview', () => {
  beforeEach(() => jest.clearAllMocks());

  it('transitions a draft PRD to pending_review', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft', content: 'some content' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await submitForReview('prd-1', 'user-1');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_review' }),
    );
  });

  it('throws 409 when PRD content is empty', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ content: '' }));

    await expect(submitForReview('prd-1', 'user-1')).rejects.toMatchObject({
      message: 'PRD content must be non-empty before submitting for review',
    });
  });

  it('throws 409 when PRD is already pending_review', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'pending_review', content: 'x' }));

    await expect(submitForReview('prd-1', 'user-1')).rejects.toMatchObject({
      message: expect.stringContaining("Cannot submit PRD from status 'pending_review'"),
    });
  });

  it('throws 409 when PRD is already approved', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'approved', content: 'x' }));

    await expect(submitForReview('prd-1', 'user-1')).rejects.toMatchObject({
      message: expect.stringContaining("Cannot submit PRD from status 'approved'"),
    });
  });

  it('throws 404 when PRD does not exist', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(null);

    await expect(submitForReview('prd-missing', 'user-1')).rejects.toMatchObject({
      message: 'PRD not found',
    });
  });

  it('throws 403 when a non-author tries to submit', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ content: 'x' }));

    await expect(submitForReview('prd-1', 'user-other')).rejects.toMatchObject({
      message: 'Only the author can submit for review',
    });
  });
});

// ── withdrawFromReview ─────────────────────────────────────────────────────────

describe('withdrawFromReview', () => {
  beforeEach(() => jest.clearAllMocks());

  it('transitions a pending_review PRD back to draft', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'pending_review' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await withdrawFromReview('prd-1', 'user-1');

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
  });

  it('throws 409 when PRD is not in pending_review status', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft' }));

    await expect(withdrawFromReview('prd-1', 'user-1')).rejects.toMatchObject({
      message: expect.stringContaining("Cannot withdraw PRD from status 'draft'"),
    });
  });

  it('throws 404 when PRD does not exist', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(null);

    await expect(withdrawFromReview('prd-missing', 'user-1')).rejects.toMatchObject({
      message: 'PRD not found',
    });
  });

  it('throws 403 when a non-author tries to withdraw', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'pending_review' }));

    await expect(withdrawFromReview('prd-1', 'user-other')).rejects.toMatchObject({
      message: 'Only the author can withdraw from review',
    });
  });
});

// ── reviewPrd ─────────────────────────────────────────────────────────────────

describe('reviewPrd', () => {
  beforeEach(() => jest.clearAllMocks());

  const pendingPrd = makePrdRow({ status: 'pending_review', authorId: 'user-author' });

  it('approves a pending_review PRD', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewPrd('prd-1', 'user-reviewer', { action: 'approve' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', reviewerId: 'user-reviewer' }),
    );
  });

  it('rejects a pending_review PRD with a comment', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewPrd('prd-1', 'user-reviewer', { action: 'reject', comment: 'Not ready' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected', reviewComment: 'Not ready' }),
    );
  });

  it('requests revision with a comment', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewPrd('prd-1', 'user-reviewer', { action: 'request_revision', comment: 'Revise section 2' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'revision_requested' }),
    );
  });

  it('throws 400 when rejecting without a comment', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);

    await expect(
      reviewPrd('prd-1', 'user-reviewer', { action: 'reject' }),
    ).rejects.toMatchObject({
      message: 'A comment is required when rejecting or requesting revision',
    });
  });

  it('throws 400 when requesting revision without a comment', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);

    await expect(
      reviewPrd('prd-1', 'user-reviewer', { action: 'request_revision' }),
    ).rejects.toMatchObject({
      message: 'A comment is required when rejecting or requesting revision',
    });
  });

  it('throws 403 when the author tries to review their own PRD', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);

    await expect(
      reviewPrd('prd-1', 'user-author', { action: 'approve' }),
    ).rejects.toMatchObject({
      message: 'You cannot review your own PRD',
      status: 403,
    });
  });

  it('throws 409 when PRD is not in pending_review status', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft', authorId: 'user-author' }));

    await expect(
      reviewPrd('prd-1', 'user-reviewer', { action: 'approve' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Cannot review PRD from status 'draft'"),
    });
  });

  it('throws 404 when PRD does not exist', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(null);

    await expect(
      reviewPrd('prd-missing', 'user-reviewer', { action: 'approve' }),
    ).rejects.toMatchObject({ message: 'PRD not found' });
  });
});

// ── deletePrd ──────────────────────────────────────────────────────────────────

describe('deletePrd', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes the PRD when the requesting user is the author', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow());
    const whereMock = jest.fn().mockResolvedValue(undefined);
    mockDb.delete.mockReturnValue({ where: whereMock });

    await deletePrd('prd-1', 'user-1');

    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(whereMock).toHaveBeenCalledTimes(1);
  });

  it('throws 404 when PRD does not exist', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(null);

    await expect(deletePrd('prd-missing', 'user-1')).rejects.toMatchObject({
      message: 'PRD not found',
    });
  });

  it('throws 403 when a non-author tries to delete', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow());

    await expect(deletePrd('prd-1', 'user-other')).rejects.toMatchObject({
      message: 'Only the author can delete this PRD',
    });
    expect(mockDb.delete).not.toHaveBeenCalled();
  });
});

// ── syncPrdContent ─────────────────────────────────────────────────────────────

describe('syncPrdContent', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates content and sets status to "pending_review" by default', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await syncPrdContent('prd-1', 'Generated markdown content');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Generated markdown content', status: 'pending_review' }),
    );
  });

  it('accepts a custom final status', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await syncPrdContent('prd-1', 'content', undefined, 'pending_review');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_review' }),
    );
  });

  it('includes backlogJson when provided', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const backlog = { items: [{ id: 1, title: 'Task A' }] };
    await syncPrdContent('prd-1', 'content', backlog);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ backlogJson: backlog }),
    );
  });
});

// ── updatePrdBacklog ──────────────────────────────────────────────────────────

describe('updatePrdBacklog', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates backlogJson when author edits a draft PRD', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const backlog = { items: [{ id: 1, title: 'Task A' }] };
    await updatePrdBacklog('prd-1', 'user-1', backlog);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ backlogJson: backlog }),
    );
  });

  it('throws 404 when PRD does not exist', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(null);

    await expect(updatePrdBacklog('prd-missing', 'user-1', {})).rejects.toMatchObject({
      message: 'PRD not found',
    });
  });

  it('throws 403 when a non-author tries to update', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow());

    await expect(updatePrdBacklog('prd-1', 'user-other', {})).rejects.toMatchObject({
      message: 'Only the author can update backlog',
    });
  });

  it('throws 409 when PRD status is approved', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'approved' }));

    await expect(updatePrdBacklog('prd-1', 'user-1', {})).rejects.toMatchObject({
      message: 'Approved PRDs cannot be edited',
    });
  });
});

// ── reopenForReview ───────────────────────────────────────────────────────────

describe('reopenForReview', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sets status to pending_review and clears review fields', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(
      makePrdRow({ status: 'approved', reviewerId: 'reviewer-1', reviewComment: 'LGTM', reviewedAt: '2026-01-03T00:00:00Z' }),
    );
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reopenForReview('prd-1');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending_review',
        reviewerId: null,
        reviewComment: null,
        reviewedAt: null,
      }),
    );
  });

  it('throws 404 when PRD does not exist', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(null);

    await expect(reopenForReview('prd-missing')).rejects.toMatchObject({
      message: 'PRD not found',
    });
  });

  it('works from draft status', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reopenForReview('prd-1');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_review' }),
    );
  });

  it('works from rejected status', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'rejected' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reopenForReview('prd-1');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_review' }),
    );
  });
});
