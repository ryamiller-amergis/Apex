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
        interviews: { findFirst: jest.fn() },
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

jest.mock('../services/documentApprovalService', () => ({
  assignApprovers: jest.fn().mockResolvedValue([]),
  recordApproverResponse: jest.fn().mockResolvedValue(undefined),
  isAssignedApprover: jest.fn().mockResolvedValue(true),
  isApprovalComplete: jest.fn().mockResolvedValue({ complete: true, mode: 'any_one' }),
}));

jest.mock('../services/reviewCommentService', () => ({
  getUnresolvedCount: jest.fn().mockResolvedValue(0),
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
  startPrdWatcher,
} from '../services/prdService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

const {
  readOutputPrd: mockReadOutputPrd,
  readOutputBacklog: mockReadOutputBacklog,
} = jest.requireMock('../services/chatAgentService') as {
  readOutputPrd: jest.Mock;
  readOutputBacklog: jest.Mock;
};

const { isAdminUser: mockIsAdminUser } = jest.requireMock('../utils/rbacHelpers') as {
  isAdminUser: jest.Mock;
};

const {
  assignApprovers: mockAssignApprovers,
  recordApproverResponse: mockRecordApproverResponse,
  isAssignedApprover: mockIsAssignedApprover,
  isApprovalComplete: mockIsApprovalComplete,
} = jest.requireMock('../services/documentApprovalService') as {
  assignApprovers: jest.Mock;
  recordApproverResponse: jest.Mock;
  isAssignedApprover: jest.Mock;
  isApprovalComplete: jest.Mock;
};

// ── Select chain helper ────────────────────────────────────────────────────────
// Services now issue multiple .leftJoin() calls before .where()/.orderBy()/.limit().
// This helper builds a self-referential mock chain that satisfies any number of joins.

function makeSelectChain(data: unknown[], terminal: 'limit' | 'orderBy' = 'limit') {
  const resolved = jest.fn().mockResolvedValue(data);
  const chain: Record<string, jest.Mock> = {};
  chain.leftJoin = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.orderBy = terminal === 'orderBy' ? resolved : jest.fn().mockResolvedValue(data);
  chain.limit = terminal === 'limit' ? resolved : jest.fn().mockResolvedValue(data);
  return { from: jest.fn().mockReturnValue(chain) };
}

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
    mockDb.select.mockReturnValue(makeSelectChain([{ prd: makePrdRow(), reviewerDisplayName: null, authorDisplayName: null, prdOwnerId: null, prdOwnerDisplayName: null }], 'orderBy'));

    const result = await listPrds();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'prd-1', status: 'draft' });
  });

  it('returns an empty array when no PRDs match', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([], 'orderBy'));

    const result = await listPrds({ userId: 'user-nobody' });

    expect(result).toEqual([]);
  });

  it('returns only PRDs linked to the specified project', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([{ prd: makePrdRow(), reviewerDisplayName: null, authorDisplayName: null, prdOwnerId: null, prdOwnerDisplayName: null }], 'orderBy'));

    const result = await listPrds({ project: 'proj-alpha' });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('prd-1');
    expect(result[0].interviewId).toBe('interview-1');
    // The project filter is applied directly in the single query (no two-step lookup)
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when no PRDs exist for the given project', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([], 'orderBy'));

    const result = await listPrds({ project: 'proj-nonexistent' });

    expect(result).toEqual([]);
  });

  it('does not return PRDs from other projects', async () => {
    // The DB filters by project directly; mock returns only proj-alpha PRDs
    mockDb.select.mockReturnValue(makeSelectChain([{ prd: makePrdRow(), reviewerDisplayName: null, authorDisplayName: null, prdOwnerId: null, prdOwnerDisplayName: null }], 'orderBy'));

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
    mockDb.select.mockReturnValue(makeSelectChain([{ prd: prdRow, reviewerDisplayName: null, authorDisplayName: null, prdOwnerId: null, prdOwnerDisplayName: null }]));

    const result = await getPrd('prd-1');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('prd-1');
    expect(result!.content).toBe('Detailed content');
    expect(result!.backlogJson).toEqual({ items: [] });
  });

  it('returns null when the PRD does not exist', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([]));

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
      expect.objectContaining({ status: 'draft', reviewerId: null }),
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
      message: 'Only the author or owner can edit PRD content',
    });
  });

  it('throws 409 when trying to edit an approved PRD', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'approved' }));

    await expect(updatePrdContent('prd-1', 'user-1', 'x')).rejects.toMatchObject({
      message: 'Approved PRDs cannot be edited',
    });
  });

  it('allows the document owner (interview.prdOwnerId) to edit content', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft' }));
    mockDb.select.mockReturnValueOnce(makeSelectChain([{ prdOwnerId: 'owner-user' }]));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updatePrdContent('prd-1', 'owner-user', 'Owner updated content');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Owner updated content' }),
    );
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
      message: 'Only the author or owner can submit for review',
    });
  });

  it('allows the document owner to submit for review', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft', content: 'some content' }));
    mockDb.select.mockReturnValueOnce(makeSelectChain([{ prdOwnerId: 'owner-user' }]));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await submitForReview('prd-1', 'owner-user');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_review' }),
    );
  });

  it('calls assignApprovers when prdApproverIds provided', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft', content: 'some content' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await submitForReview('prd-1', 'user-1', { prdApproverIds: ['a1'], designDocApproverIds: ['a2'] });

    expect(mockAssignApprovers).toHaveBeenCalledWith('prd-1', 'prd', ['a1'], 'user-1');
  });

  it('stores designDocApproverIds on PRD row when provided', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft', content: 'some content' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await submitForReview('prd-1', 'user-1', { prdApproverIds: [], designDocApproverIds: ['a2'] });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ designDocApproverIds: ['a2'] }),
    );
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
      message: 'Only the author or owner can withdraw from review',
    });
  });

  it('allows the document owner to withdraw from review', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'pending_review' }));
    mockDb.select.mockReturnValueOnce(makeSelectChain([{ prdOwnerId: 'owner-user' }]));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await withdrawFromReview('prd-1', 'owner-user');

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
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

  it('throws 400 for invalid review action', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);

    await expect(
      reviewPrd('prd-1', 'user-reviewer', { action: 'request_revision' } as any),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Invalid review action'),
      status: 400,
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

  it('throws 403 when reviewer is not an assigned approver and not admin', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);
    mockIsAssignedApprover.mockResolvedValue(false);
    mockIsAdminUser.mockResolvedValue(false);

    await expect(
      reviewPrd('prd-1', 'user-reviewer', { action: 'approve' }),
    ).rejects.toMatchObject({
      message: 'You are not an assigned approver for this PRD',
      status: 403,
    });
  });

  it('allows admin to review even if not an assigned approver', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);
    mockIsAssignedApprover.mockResolvedValue(false);
    mockIsAdminUser.mockResolvedValue(true);
    mockIsApprovalComplete.mockResolvedValue({ complete: true, mode: 'any_one' });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewPrd('prd-1', 'user-reviewer', { action: 'approve' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved' }),
    );
  });

  it('does not transition to approved if isApprovalComplete returns false', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);
    mockIsAssignedApprover.mockResolvedValue(true);
    mockIsAdminUser.mockResolvedValue(false);
    mockIsApprovalComplete.mockResolvedValue({ complete: false, mode: 'all_required' });

    await reviewPrd('prd-1', 'user-reviewer', { action: 'approve' });

    expect(mockRecordApproverResponse).toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('transitions to approved when isApprovalComplete returns true', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);
    mockIsAssignedApprover.mockResolvedValue(true);
    mockIsAdminUser.mockResolvedValue(false);
    mockIsApprovalComplete.mockResolvedValue({ complete: true, mode: 'any_one' });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewPrd('prd-1', 'user-reviewer', { action: 'approve' });

    expect(mockRecordApproverResponse).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved' }),
    );
  });

  it('admin approval bypasses isApprovalComplete check entirely', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);
    mockIsAssignedApprover.mockResolvedValue(false);
    mockIsAdminUser.mockResolvedValue(true);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewPrd('prd-1', 'user-admin', { action: 'approve' });

    expect(mockIsApprovalComplete).not.toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved' }),
    );
  });

  it('designated approver approval transitions PRD to approved (any_one mode)', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);
    mockIsAssignedApprover.mockResolvedValue(true);
    mockIsAdminUser.mockResolvedValue(false);
    mockIsApprovalComplete.mockResolvedValue({ complete: true, mode: 'any_one' });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewPrd('prd-1', 'user-reviewer', { action: 'approve' });

    expect(mockRecordApproverResponse).toHaveBeenCalledWith(
      'prd-1', 'prd', 'user-reviewer', 'approved',
    );
    expect(mockIsApprovalComplete).toHaveBeenCalledWith('prd-1', 'prd', 'proj-alpha');
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', reviewerId: 'user-reviewer' }),
    );
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
      message: 'Only the author or owner can delete this PRD',
    });
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it('allows the document owner to delete the PRD', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow());
    mockDb.select.mockReturnValueOnce(makeSelectChain([{ prdOwnerId: 'owner-user' }]));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    mockDb.delete.mockReturnValue({ where: whereMock });

    await deletePrd('prd-1', 'owner-user');

    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(whereMock).toHaveBeenCalledTimes(1);
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
      message: 'Only the author or owner can update backlog',
    });
  });

  it('throws 409 when PRD status is approved', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'approved' }));

    await expect(updatePrdBacklog('prd-1', 'user-1', {})).rejects.toMatchObject({
      message: 'Approved PRDs cannot be edited',
    });
  });

  it('allows the document owner to update the backlog', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft' }));
    mockDb.select.mockReturnValueOnce(makeSelectChain([{ prdOwnerId: 'owner-user' }]));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const backlog = { items: [{ id: 2, title: 'Owner task' }] };
    await updatePrdBacklog('prd-1', 'owner-user', backlog);

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ backlogJson: backlog }));
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
});

// ── startPrdWatcher ───────────────────────────────────────────────────────────

describe('startPrdWatcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('syncs content to DB when both files are found', async () => {
    mockReadOutputPrd.mockReturnValue('# Generated PRD');
    mockReadOutputBacklog.mockReturnValue({ epics: [] });

    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    // Also mock the workspace cleanup query
    mockDb.query.prds.findFirst.mockResolvedValue(null);

    startPrdWatcher('prd-1', 'thread-1');

    // Advance past one interval tick
    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockReadOutputPrd).toHaveBeenCalledWith('thread-1');
    expect(mockReadOutputBacklog).toHaveBeenCalledWith('thread-1');
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ content: '# Generated PRD', status: 'pending_review' }),
    );
  });

  it('resets PRD to draft when watcher times out without finding files', async () => {
    mockReadOutputPrd.mockReturnValue(null);
    mockReadOutputBacklog.mockReturnValue(null);

    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    startPrdWatcher('prd-1', 'thread-1');

    // Advance past all 360 ticks + 1 to trigger the timeout
    for (let i = 0; i <= 360; i++) {
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft' }),
    );
  });

  it('does not sync when only PRD file is found without backlog', async () => {
    mockReadOutputPrd.mockReturnValue('# PRD');
    mockReadOutputBacklog.mockReturnValue(null);

    const setMock = jest.fn().mockReturnThis();
    mockDb.update.mockReturnValue({ set: setMock });

    startPrdWatcher('prd-1', 'thread-1');

    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
    await Promise.resolve();

    // syncPrdContent should NOT have been called (requires both files)
    expect(setMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.any(String), status: 'pending_review' }),
    );
  });
});
