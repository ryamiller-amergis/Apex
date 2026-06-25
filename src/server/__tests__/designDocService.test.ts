/**
 * Unit tests for designDocService.
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
        designDocs: { findFirst: jest.fn() },
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
  readOutputDesignDoc: jest.fn().mockReturnValue(null),
  readOutputTechSpec: jest.fn().mockReturnValue(null),
  readOutputAssumptions: jest.fn().mockReturnValue(null),
  readOutputValidationScorecard: jest.fn().mockReturnValue(null),
  readOutputValidationScorecardMd: jest.fn().mockReturnValue(null),
  readAllOutputDesignDocFeatures: jest.fn().mockReturnValue([]),
  isThreadIdle: jest.fn().mockReturnValue(false),
  createThread: jest.fn(),
  sendMessage: jest.fn(),
  cancelRun: jest.fn(),
}));

jest.mock('../utils/rbacHelpers', () => ({
  isAdminUser: jest.fn().mockResolvedValue(false),
}));

jest.mock('../services/projectSettingsService', () => {
  const getSkillConfig = jest.fn().mockResolvedValue(null);
  return {
    getSkillConfig,
    resolveSkillConfig: jest.fn().mockImplementation((opts: { project: string }) => getSkillConfig(opts.project)),
    getSkillSettingsName: jest.fn().mockResolvedValue(null),
  };
});
jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn().mockResolvedValue('default-model'),
}));
jest.mock('../services/prdService', () => ({
  getPrd: jest.fn().mockResolvedValue(null),
}));

jest.mock('../services/documentApprovalService', () => ({
  assignApprovers: jest.fn().mockResolvedValue([]),
  recordApproverResponse: jest.fn().mockResolvedValue(undefined),
  isAssignedApprover: jest.fn().mockResolvedValue(true),
  isApprovalComplete: jest.fn().mockResolvedValue({ complete: true, mode: 'any_one' }),
  propagateDesignDocApprovers: jest.fn().mockResolvedValue(undefined),
  notifyApproversDocumentReady: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/reviewCommentService', () => ({
  getUnresolvedCount: jest.fn().mockResolvedValue(0),
}));

import {
  createDesignDoc,
  listDesignDocs,
  getDesignDoc,
  updateDesignDocContent,
  submitForReview,
  withdrawFromReview,
  reviewDesignDoc,
  deleteDesignDoc,
  syncDesignDocContent,
  syncValidationResult,
  markValidationReady,
  startDesignDocWatcher,
} from '../services/designDocService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

// ── Select chain helper ────────────────────────────────────────────────────────
function makeSelectChain(data: unknown[], terminal: 'limit' | 'orderBy' = 'limit') {
  const resolved = jest.fn().mockResolvedValue(data);
  const chain: Record<string, jest.Mock> = {};
  chain.leftJoin = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.orderBy = terminal === 'orderBy' ? resolved : jest.fn().mockResolvedValue(data);
  chain.limit = terminal === 'limit' ? resolved : jest.fn().mockResolvedValue(data);
  return { from: jest.fn().mockReturnValue(chain) };
}
const { getSkillConfig: mockGetSkillConfig } = jest.requireMock('../services/projectSettingsService') as { getSkillConfig: jest.Mock };

const { isAdminUser: mockIsAdminUser } = jest.requireMock('../utils/rbacHelpers') as {
  isAdminUser: jest.Mock;
};

const {
  assignApprovers: mockAssignApprovers,
  recordApproverResponse: mockRecordApproverResponse,
  isAssignedApprover: mockIsAssignedApprover,
  isApprovalComplete: mockIsApprovalComplete,
  notifyApproversDocumentReady: mockNotifyApproversDocumentReady,
} = jest.requireMock('../services/documentApprovalService') as {
  assignApprovers: jest.Mock;
  recordApproverResponse: jest.Mock;
  isAssignedApprover: jest.Mock;
  isApprovalComplete: jest.Mock;
  notifyApproversDocumentReady: jest.Mock;
};

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeDocRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'doc-1',
    prdId: 'prd-1',
    chatThreadId: 'thread-1',
    authorId: 'user-1',
    project: 'proj-alpha',
    title: 'Feature Design Doc',
    designContent: 'Design content',
    techSpecContent: 'Tech spec content',
    assumptionsContent: 'Assumptions content',
    status: 'draft',
    reviewerId: null,
    reviewComment: null,
    reviewedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

// ── createDesignDoc ────────────────────────────────────────────────────────────

describe('createDesignDoc', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts a new design doc in "generating" status and returns designDocId', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'doc-new' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    const result = await createDesignDoc({
      prdId: 'prd-1',
      project: 'proj-alpha',
      userId: 'user-1',
      chatThreadId: 'thread-abc',
      title: 'My Design Doc',
    });

    expect(result).toEqual({ designDocId: 'doc-new' });
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prdId: 'prd-1',
        authorId: 'user-1',
        chatThreadId: 'thread-abc',
        title: 'My Design Doc',
        status: 'generating',
        designContent: '',
        techSpecContent: '',
        assumptionsContent: '',
      }),
    );
  });

  it('defaults title to "Untitled Design Doc" when not supplied', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'doc-untitled' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await createDesignDoc({ prdId: 'prd-1', project: 'proj-1', userId: 'u1', chatThreadId: 't1' });

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Untitled Design Doc' }),
    );
  });
});

// ── listDesignDocs ─────────────────────────────────────────────────────────────

describe('listDesignDocs', () => {
  beforeEach(() => jest.clearAllMocks());

  /**
   * Helper: builds a mock select chain that supports two consecutive leftJoin calls
   * (one for appUsers, one for prds) before where/orderBy.
   */
  function mockListSelectChain(rows: any[]) {
    const orderByMock = jest.fn().mockResolvedValue(rows);
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    // The chain object is shared across all leftJoin calls so chaining works naturally.
    const chain: any = {};
    chain.leftJoin = jest.fn().mockReturnValue(chain);
    chain.where = whereMock;
    const fromMock = jest.fn().mockReturnValue(chain);
    mockDb.select.mockReturnValue({ from: fromMock });
  }

  it('returns all design docs when no filters are given', async () => {
    mockListSelectChain([{ designDoc: makeDocRow(), reviewerDisplayName: null, prdTitle: null }]);

    const result = await listDesignDocs();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'doc-1', status: 'draft' });
  });

  it('returns an empty array when no design docs match', async () => {
    mockListSelectChain([]);

    const result = await listDesignDocs({ userId: 'user-nobody' });

    expect(result).toEqual([]);
  });

  it('returns only design docs linked to the specified prdId', async () => {
    mockListSelectChain([{ designDoc: makeDocRow(), reviewerDisplayName: null, prdTitle: 'My PRD' }]);

    const result = await listDesignDocs({ prdId: 'prd-1' });

    expect(result).toHaveLength(1);
    expect(result[0].prdId).toBe('prd-1');
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when no design docs exist for the given project', async () => {
    mockListSelectChain([]);

    const result = await listDesignDocs({ project: 'proj-nonexistent' });

    expect(result).toEqual([]);
  });

  it('includes reviewerName when the reviewer display name is available', async () => {
    mockListSelectChain([
      { designDoc: makeDocRow({ reviewerId: 'reviewer-1' }), reviewerDisplayName: 'Alice', prdTitle: null },
    ]);

    const result = await listDesignDocs();

    expect(result[0].reviewerName).toBe('Alice');
  });

  it('exposes prdTitle on the summary when the joined prd has a title', async () => {
    mockListSelectChain([
      { designDoc: makeDocRow(), reviewerDisplayName: null, prdTitle: 'Payment Service PRD' },
    ]);

    const result = await listDesignDocs();

    expect(result[0].prdTitle).toBe('Payment Service PRD');
  });
});

// ── getDesignDoc ───────────────────────────────────────────────────────────────

describe('getDesignDoc', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns a full design doc with all three content fields', async () => {
    const docRow = makeDocRow({ designContent: 'Design', techSpecContent: 'Tech', assumptionsContent: 'Assumptions' });
    mockDb.select.mockReturnValue(makeSelectChain([{ designDoc: docRow, reviewerDisplayName: null, authorDisplayName: null, designDocOwnerId: null, designDocOwnerDisplayName: null }]));

    const result = await getDesignDoc('doc-1');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('doc-1');
    expect(result!.designContent).toBe('Design');
    expect(result!.techSpecContent).toBe('Tech');
    expect(result!.assumptionsContent).toBe('Assumptions');
  });

  it('returns null when the design doc does not exist', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([]));

    const result = await getDesignDoc('doc-missing');

    expect(result).toBeNull();
  });

  it('includes reviewerName from the joined appUsers row', async () => {
    const docRow = makeDocRow({ reviewerId: 'reviewer-1' });
    mockDb.select.mockReturnValue(makeSelectChain([{ designDoc: docRow, reviewerDisplayName: 'Bob', authorDisplayName: null, designDocOwnerId: null, designDocOwnerDisplayName: null }]));

    const result = await getDesignDoc('doc-1');

    expect(result!.reviewerName).toBe('Bob');
  });
});

// ── updateDesignDocContent ─────────────────────────────────────────────────────

describe('updateDesignDocContent', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates designContent when author edits a draft doc', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'draft' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updateDesignDocContent('doc-1', 'user-1', { designContent: 'New design' });

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ designContent: 'New design' }));
  });

  it('can update techSpecContent and assumptionsContent independently', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'draft' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updateDesignDocContent('doc-1', 'user-1', { techSpecContent: 'New tech', assumptionsContent: 'New assumptions' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ techSpecContent: 'New tech', assumptionsContent: 'New assumptions' }),
    );
  });

  it('resets status to "draft" and clears review fields when editing a revision_requested doc', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'revision_requested', reviewerId: 'reviewer-1', reviewComment: 'Fix it' }),
    );
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updateDesignDocContent('doc-1', 'user-1', { designContent: 'Revised design' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft', reviewerId: null }),
    );
  });

  it('throws 404 when design doc does not exist', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);

    await expect(updateDesignDocContent('doc-missing', 'user-1', { designContent: 'x' })).rejects.toMatchObject({
      message: 'Design doc not found',
    });
  });

  it('throws 403 when a non-author tries to edit', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow());

    await expect(updateDesignDocContent('doc-1', 'user-other', { designContent: 'x' })).rejects.toMatchObject({
      message: 'Only the author can edit design doc content',
    });
  });

  it('throws 409 when trying to edit an approved design doc', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'approved' }));

    await expect(updateDesignDocContent('doc-1', 'user-1', { designContent: 'x' })).rejects.toMatchObject({
      message: 'Approved design docs cannot be edited',
    });
  });

  it('throws 409 when trying to edit a reviewer_approved design doc awaiting owner sign-off', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'reviewer_approved' }));

    await expect(updateDesignDocContent('doc-1', 'user-1', { designContent: 'x' })).rejects.toMatchObject({
      message: 'Approved design docs cannot be edited',
    });
  });
});

// ── submitForReview ────────────────────────────────────────────────────────────

describe('submitForReview', () => {
  beforeEach(() => jest.clearAllMocks());

  it('transitions a draft design doc to pending_review', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'draft' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await submitForReview('doc-1', 'user-1');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_review' }),
    );
  });

  it('throws 409 when all content fields are empty', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ designContent: '', techSpecContent: '', assumptionsContent: '' }),
    );

    await expect(submitForReview('doc-1', 'user-1')).rejects.toMatchObject({
      message: 'Design doc content must be non-empty before submitting for review',
    });
  });

  it('allows submit when at least one content field is non-empty', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ designContent: 'Has content', techSpecContent: '', assumptionsContent: '' }),
    );
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await submitForReview('doc-1', 'user-1');

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending_review' }));
  });

  it('allows resubmit when design doc is already pending_review', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'pending_review' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await submitForReview('doc-1', 'user-1');

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending_review' }));
  });

  it('throws 409 when design doc is already approved', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'approved' }));

    await expect(submitForReview('doc-1', 'user-1')).rejects.toMatchObject({
      message: expect.stringContaining("Cannot submit design doc from status 'approved'"),
    });
  });

  it('throws 404 when design doc does not exist', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);

    await expect(submitForReview('doc-missing', 'user-1')).rejects.toMatchObject({
      message: 'Design doc not found',
    });
  });

  it('throws 403 when a non-author tries to submit', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow());

    await expect(submitForReview('doc-1', 'user-other')).rejects.toMatchObject({
      message: 'Only the author can submit for review',
    });
  });

  it('calls assignApprovers when approverIds provided', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'draft' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await submitForReview('doc-1', 'user-1', { approverIds: ['a1', 'a2'] });

    expect(mockAssignApprovers).toHaveBeenCalledWith('doc-1', 'design_doc', ['a1', 'a2'], 'user-1');
  });
});

// ── withdrawFromReview ─────────────────────────────────────────────────────────

describe('withdrawFromReview', () => {
  beforeEach(() => jest.clearAllMocks());

  it('transitions a pending_review design doc back to draft', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'pending_review' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await withdrawFromReview('doc-1', 'user-1');

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
  });

  it('throws 409 when design doc is not in pending_review status', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'draft' }));

    await expect(withdrawFromReview('doc-1', 'user-1')).rejects.toMatchObject({
      message: expect.stringContaining("Cannot withdraw design doc from status 'draft'"),
    });
  });

  it('throws 404 when design doc does not exist', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);

    await expect(withdrawFromReview('doc-missing', 'user-1')).rejects.toMatchObject({
      message: 'Design doc not found',
    });
  });

  it('throws 403 when a non-author tries to withdraw', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'pending_review' }));

    await expect(withdrawFromReview('doc-1', 'user-other')).rejects.toMatchObject({
      message: 'Only the author can withdraw from review',
    });
  });
});

// ── reviewDesignDoc ────────────────────────────────────────────────────────────

describe('reviewDesignDoc', () => {
  beforeEach(() => jest.clearAllMocks());

  const pendingDoc = makeDocRow({ status: 'pending_review', authorId: 'user-author' });

  it('transitions a pending_review design doc to reviewer_approved (owner approval is separate)', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDoc);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reviewer_approved', reviewerId: 'user-reviewer' }),
    );
    expect(setMock).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'approved' }));
  });

  it('throws 400 for invalid review action', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDoc);

    await expect(
      reviewDesignDoc('doc-1', 'user-reviewer', { action: 'request_revision' } as any),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Invalid review action'),
      status: 400,
    });
  });

  it('throws 403 when the author tries to review their own design doc', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDoc);

    await expect(
      reviewDesignDoc('doc-1', 'user-author', { action: 'approve' }),
    ).rejects.toMatchObject({
      message: 'You cannot review your own design doc',
      status: 403,
    });
  });

  it('throws 409 when design doc is not in pending_review status', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'draft', authorId: 'user-author' }));

    await expect(
      reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Cannot review design doc from status 'draft'"),
    });
  });

  it('throws 404 when design doc does not exist', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);

    await expect(
      reviewDesignDoc('doc-missing', 'user-reviewer', { action: 'approve' }),
    ).rejects.toMatchObject({ message: 'Design doc not found' });
  });

  it('throws 403 when reviewer is not assigned and not admin', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDoc);
    mockIsAssignedApprover.mockResolvedValue(false);
    mockIsAdminUser.mockResolvedValue(false);

    await expect(
      reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' }),
    ).rejects.toMatchObject({
      message: 'You are not an assigned approver for this design doc',
      status: 403,
    });
  });

  it('allows admin to review even if not assigned', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDoc);
    mockIsAssignedApprover.mockResolvedValue(false);
    mockIsAdminUser.mockResolvedValue(true);
    mockIsApprovalComplete.mockResolvedValue({ complete: true, mode: 'any_one' });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reviewer_approved' }),
    );
  });

  it('gates approval transition on isApprovalComplete', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDoc);
    mockIsAssignedApprover.mockResolvedValue(true);
    mockIsAdminUser.mockResolvedValue(false);
    mockIsApprovalComplete.mockResolvedValue({ complete: false, mode: 'all_required' });

    await reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' });

    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

// ── deleteDesignDoc ────────────────────────────────────────────────────────────

describe('deleteDesignDoc', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes the design doc when the requesting user is the author', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow());
    const whereMock = jest.fn().mockResolvedValue(undefined);
    mockDb.delete.mockReturnValue({ where: whereMock });

    await deleteDesignDoc('doc-1', 'user-1');

    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(whereMock).toHaveBeenCalledTimes(1);
  });

  it('throws 404 when design doc does not exist', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);

    await expect(deleteDesignDoc('doc-missing', 'user-1')).rejects.toMatchObject({
      message: 'Design doc not found',
    });
  });

  it('throws 403 when a non-author tries to delete', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow());

    await expect(deleteDesignDoc('doc-1', 'user-other')).rejects.toMatchObject({
      message: 'Only the author can delete this design doc',
    });
    expect(mockDb.delete).not.toHaveBeenCalled();
  });
});

// ── syncDesignDocContent ───────────────────────────────────────────────────────

describe('syncDesignDocContent', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates designContent when provided', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await syncDesignDocContent('doc-1', { designContent: 'Generated design' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ designContent: 'Generated design' }),
    );
  });

  it('sets finalStatus to pending_review when all three content fields are synced', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await syncDesignDocContent('doc-1', {
      designContent: 'Design',
      techSpecContent: 'Tech',
      assumptionsContent: 'Assumptions',
      finalStatus: 'pending_review',
    });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_review' }),
    );
  });

  it('does not set status when finalStatus is not provided', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await syncDesignDocContent('doc-1', { designContent: 'Partial content' });

    const callArg = setMock.mock.calls[0][0];
    expect(callArg).not.toHaveProperty('status');
  });

  it('accepts a custom final status', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await syncDesignDocContent('doc-1', { finalStatus: 'draft' });

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
  });

  it('can sync techSpecContent and assumptionsContent independently', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await syncDesignDocContent('doc-1', { techSpecContent: 'Tech spec', assumptionsContent: 'Assumptions' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ techSpecContent: 'Tech spec', assumptionsContent: 'Assumptions' }),
    );
  });
});

// ── syncValidationResult ──────────────────────────────────────────────────────

describe('syncValidationResult', () => {
  beforeEach(() => jest.clearAllMocks());

  /** Minimal valid scorecard — generateFallbackReport requires verdict + features. */
  function makeScorecardFixture(overrides: Partial<Record<string, any>> = {}) {
    return {
      slug: 'feature-a',
      generated_at: '2026-01-01T00:00:00Z',
      review_phase: 'initial',
      overall_score: 85,
      ready_threshold: 90,
      is_ready: false,
      verdict: 'gaps',
      features: [],
      cross_cutting_checks: {},
      accepted_gaps: [],
      deferred_gaps: [],
      ...overrides,
    };
  }

  it('sets validationScore, validationScorecard, and validationPhase from the scorecard', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const scorecard = makeScorecardFixture({ overall_score: 85, review_phase: 'initial' });

    await syncValidationResult('doc-1', scorecard as any);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        validationScore: 85,
        validationScorecard: scorecard,
        validationPhase: 'initial',
      }),
    );
  });

  it('sets status to pending_review after validation completes (ready scorecard)', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const scorecard = makeScorecardFixture({ overall_score: 95, is_ready: true, review_phase: 'final', verdict: 'ready' });

    await syncValidationResult('doc-1', scorecard as any);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_review' }),
    );
  });

  it('sets status to pending_review after validation completes (gaps remain)', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const scorecard = makeScorecardFixture({ overall_score: 70, is_ready: false });

    await syncValidationResult('doc-1', scorecard as any);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_review' }),
    );
  });

  it('persists validationReportMd when provided', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const scorecard = makeScorecardFixture({ overall_score: 92, is_ready: true, verdict: 'ready', review_phase: 'final' });

    await syncValidationResult('doc-1', scorecard as any, '## Validation Report\nAll good.');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ validationReportMd: '## Validation Report\nAll good.' }),
    );
  });

  it('generates a fallback markdown report when none is provided', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const scorecard = makeScorecardFixture({ overall_score: 80, is_ready: false });

    await syncValidationResult('doc-1', scorecard as any);

    const callArg = setMock.mock.calls[0][0];
    expect(typeof callArg.validationReportMd).toBe('string');
    expect(callArg.validationReportMd).toContain('Validation Report');
  });
});

// ── markValidationReady ───────────────────────────────────────────────────────

describe('markValidationReady', () => {
  beforeEach(() => jest.clearAllMocks());

  it('transitions to pending_review when status is validating and score >= 90', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'validating', validationScore: 95 }),
    );
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await markValidationReady('doc-1', 'user-1');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_review' }),
    );
  });

  it('throws 404 when design doc does not exist', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);

    await expect(markValidationReady('doc-missing', 'user-1')).rejects.toMatchObject({
      message: 'Design doc not found',
      status: 404,
    });
  });

  it('throws 403 when a non-author/non-admin tries to mark ready', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'validating', validationScore: 95 }),
    );

    await expect(markValidationReady('doc-1', 'user-other')).rejects.toMatchObject({
      message: 'Only the author can mark validation as ready',
      status: 403,
    });
  });

  it('throws 409 when status is not validating', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'draft', validationScore: 95 }),
    );

    await expect(markValidationReady('doc-1', 'user-1')).rejects.toMatchObject({
      message: expect.stringContaining("Cannot mark ready from status 'draft'"),
      status: 409,
    });
  });

  it('throws 409 when validation score is below 90', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'validating', validationScore: 75 }),
    );

    await expect(markValidationReady('doc-1', 'user-1')).rejects.toMatchObject({
      message: expect.stringContaining('Validation score must be >= 90'),
      status: 409,
    });
  });

  it('throws 409 when validation score is null', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'validating', validationScore: null }),
    );

    await expect(markValidationReady('doc-1', 'user-1')).rejects.toMatchObject({
      message: expect.stringContaining('Validation score must be >= 90'),
      status: 409,
    });
  });
});

// ── reviewDesignDoc (approve with validation gate) ────────────────────────────

describe('reviewDesignDoc (approve with validation gate)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws 409 when validation is configured and score is below 90', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'pending_review', authorId: 'user-author', validationScore: 50 }),
    );
    mockGetSkillConfig.mockResolvedValue({ designDocValidationSkillPath: '/skills/validate.md' });

    await expect(
      reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Validation score must be >= 90'),
      status: 409,
    });
  });

  it('throws 409 when validation is configured and score is null', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'pending_review', authorId: 'user-author', validationScore: null }),
    );
    mockGetSkillConfig.mockResolvedValue({ designDocValidationSkillPath: '/skills/validate.md' });

    await expect(
      reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('not scored'),
      status: 409,
    });
  });

  it('allows approve when validation is configured and score >= 90', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'pending_review', authorId: 'user-author', validationScore: 92 }),
    );
    mockGetSkillConfig.mockResolvedValue({ designDocValidationSkillPath: '/skills/validate.md' });
    mockIsAssignedApprover.mockResolvedValue(true);
    mockIsApprovalComplete.mockResolvedValue({ complete: true, mode: 'any_one' });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reviewer_approved', reviewerId: 'user-reviewer' }),
    );
  });
});

// ── startDesignDocWatcher ─────────────────────────────────────────────────────

describe('startDesignDocWatcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resets design doc to draft when watcher times out without finding features', async () => {
    const { readAllOutputDesignDocFeatures: mockReadFeatures } =
      jest.requireMock('../services/chatAgentService') as { readAllOutputDesignDocFeatures: jest.Mock };
    mockReadFeatures.mockReturnValue([]);

    // The watcher queries the seed doc on each tick to check if syncOutputToDb already handled it
    mockDb.query.designDocs.findFirst.mockResolvedValue({
      id: 'doc-seed',
      chatThreadId: 'thread-dd',
      prdId: 'prd-1',
      project: 'proj-alpha',
      authorId: 'user-1',
    });

    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    startDesignDocWatcher('doc-seed', 'thread-dd');

    // Max attempts = 360, advance past all ticks + 1
    for (let i = 0; i <= 360; i++) {
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft' }),
    );
  });
});

// ── Notification on pending_review transition ─────────────────────────────────

describe('notifyApproversDocumentReady integration', () => {
  beforeEach(() => jest.clearAllMocks());

  it('markValidationReady notifies approvers when transitioning to pending_review', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'validating', validationScore: 95 }),
    );
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await markValidationReady('doc-1', 'user-1');

    expect(mockNotifyApproversDocumentReady).toHaveBeenCalledWith('doc-1', 'design_doc');
  });

  it('syncValidationResult notifies approvers when scorecard.is_ready is true', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const scorecard = {
      slug: 'feature-a',
      generated_at: '2026-01-01T00:00:00Z',
      review_phase: 'final',
      overall_score: 95,
      ready_threshold: 90,
      is_ready: true,
      verdict: 'ready',
      features: [],
      cross_cutting_checks: {},
      accepted_gaps: [],
      deferred_gaps: [],
    };

    await syncValidationResult('doc-1', scorecard as any);

    expect(mockNotifyApproversDocumentReady).toHaveBeenCalledWith('doc-1', 'design_doc');
  });

  it('syncValidationResult notifies approvers when validation transitions to pending_review', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const scorecard = {
      slug: 'feature-a',
      generated_at: '2026-01-01T00:00:00Z',
      review_phase: 'initial',
      overall_score: 70,
      ready_threshold: 90,
      is_ready: false,
      verdict: 'gaps',
      features: [],
      cross_cutting_checks: {},
      accepted_gaps: [],
      deferred_gaps: [],
    };

    await syncValidationResult('doc-1', scorecard as any);

    expect(mockNotifyApproversDocumentReady).toHaveBeenCalledWith('doc-1', 'design_doc');
  });

  it('syncDesignDocContent notifies approvers when finalStatus is pending_review', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await syncDesignDocContent('doc-1', {
      designContent: 'Design',
      techSpecContent: 'Tech',
      assumptionsContent: 'Assumptions',
      finalStatus: 'pending_review',
    });

    expect(mockNotifyApproversDocumentReady).toHaveBeenCalledWith('doc-1', 'design_doc');
  });

  it('syncDesignDocContent does NOT notify approvers when finalStatus is draft', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await syncDesignDocContent('doc-1', { designContent: 'Content', finalStatus: 'draft' });

    expect(mockNotifyApproversDocumentReady).not.toHaveBeenCalled();
  });
});

// ── reviewDesignDoc (admin override & designated approver) ────────────────────

describe('reviewDesignDoc (admin override & designated approver)', () => {
  beforeEach(() => jest.clearAllMocks());

  const pendingDocWithValidation = makeDocRow({
    status: 'pending_review',
    authorId: 'user-author',
    validationScore: 95,
  });

  it('admin approval bypasses isApprovalComplete check entirely', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDocWithValidation);
    mockIsAssignedApprover.mockResolvedValue(false);
    mockIsAdminUser.mockResolvedValue(true);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewDesignDoc('doc-1', 'user-admin', { action: 'approve' });

    expect(mockIsApprovalComplete).not.toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reviewer_approved' }),
    );
  });

  it('designated approver with green validation transitions to reviewer_approved', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDocWithValidation);
    mockGetSkillConfig.mockResolvedValue({ designDocValidationSkillPath: '/skills/validate.md' });
    mockIsAssignedApprover.mockResolvedValue(true);
    mockIsAdminUser.mockResolvedValue(false);
    mockIsApprovalComplete.mockResolvedValue({ complete: true, mode: 'any_one' });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reviewer_approved', reviewerId: 'user-reviewer' }),
    );
  });

  it('designated approver stays pending_review when all_required mode not fully met', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDocWithValidation);
    mockGetSkillConfig.mockResolvedValue(null);
    mockIsAssignedApprover.mockResolvedValue(true);
    mockIsAdminUser.mockResolvedValue(false);
    mockIsApprovalComplete.mockResolvedValue({ complete: false, mode: 'all_required' });

    await reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' });

    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

// ── Two-stage design doc approval workflow ────────────────────────────────────

describe('two-stage design doc approval workflow', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reviewer approval leaves doc in reviewer_approved until owner acts', async () => {
    const pendingDoc = makeDocRow({ status: 'pending_review', authorId: 'user-author' });
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDoc);
    mockIsAssignedApprover.mockResolvedValue(true);
    mockIsApprovalComplete.mockResolvedValue({ complete: true, mode: 'any_one' });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' });

    expect(mockRecordApproverResponse).toHaveBeenCalledWith('doc-1', 'design_doc', 'user-reviewer', 'approved');
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'reviewer_approved' }));
    expect(setMock).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'approved' }));
  });

  it('records partial reviewer response without status change when quorum is incomplete', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'pending_review', authorId: 'user-author' }));
    mockIsAssignedApprover.mockResolvedValue(true);
    mockIsAdminUser.mockResolvedValue(false);
    mockIsApprovalComplete.mockResolvedValue({ complete: false, mode: 'all_required' });

    await reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' });

    expect(mockRecordApproverResponse).toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});
