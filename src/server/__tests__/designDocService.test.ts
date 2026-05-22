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
}));

jest.mock('../utils/rbacHelpers', () => ({
  isAdminUser: jest.fn().mockResolvedValue(false),
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
} from '../services/designDocService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

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

  it('returns all design docs when no filters are given', async () => {
    const orderByMock = jest.fn().mockResolvedValue([{ designDoc: makeDocRow(), reviewerDisplayName: null }]);
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const leftJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listDesignDocs();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'doc-1', status: 'draft' });
  });

  it('returns an empty array when no design docs match', async () => {
    const orderByMock = jest.fn().mockResolvedValue([]);
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const leftJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listDesignDocs({ userId: 'user-nobody' });

    expect(result).toEqual([]);
  });

  it('returns only design docs linked to the specified prdId', async () => {
    const orderByMock = jest.fn().mockResolvedValue([{ designDoc: makeDocRow(), reviewerDisplayName: null }]);
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const leftJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listDesignDocs({ prdId: 'prd-1' });

    expect(result).toHaveLength(1);
    expect(result[0].prdId).toBe('prd-1');
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when no design docs exist for the given project', async () => {
    const orderByMock = jest.fn().mockResolvedValue([]);
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const leftJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listDesignDocs({ project: 'proj-nonexistent' });

    expect(result).toEqual([]);
  });

  it('includes reviewerName when the reviewer display name is available', async () => {
    const orderByMock = jest.fn().mockResolvedValue([
      { designDoc: makeDocRow({ reviewerId: 'reviewer-1' }), reviewerDisplayName: 'Alice' },
    ]);
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const leftJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listDesignDocs();

    expect(result[0].reviewerName).toBe('Alice');
  });
});

// ── getDesignDoc ───────────────────────────────────────────────────────────────

describe('getDesignDoc', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns a full design doc with all three content fields', async () => {
    const docRow = makeDocRow({ designContent: 'Design', techSpecContent: 'Tech', assumptionsContent: 'Assumptions' });
    const limitMock = jest.fn().mockResolvedValue([{ designDoc: docRow, reviewerDisplayName: null }]);
    const whereMock = jest.fn().mockReturnValue({ limit: limitMock });
    const leftJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await getDesignDoc('doc-1');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('doc-1');
    expect(result!.designContent).toBe('Design');
    expect(result!.techSpecContent).toBe('Tech');
    expect(result!.assumptionsContent).toBe('Assumptions');
  });

  it('returns null when the design doc does not exist', async () => {
    const limitMock = jest.fn().mockResolvedValue([]);
    const whereMock = jest.fn().mockReturnValue({ limit: limitMock });
    const leftJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await getDesignDoc('doc-missing');

    expect(result).toBeNull();
  });

  it('includes reviewerName from the joined appUsers row', async () => {
    const docRow = makeDocRow({ reviewerId: 'reviewer-1' });
    const limitMock = jest.fn().mockResolvedValue([{ designDoc: docRow, reviewerDisplayName: 'Bob' }]);
    const whereMock = jest.fn().mockReturnValue({ limit: limitMock });
    const leftJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

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
      expect.objectContaining({ status: 'draft', reviewerId: null, reviewComment: null }),
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

  it('throws 409 when design doc is already pending_review', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'pending_review' }));

    await expect(submitForReview('doc-1', 'user-1')).rejects.toMatchObject({
      message: expect.stringContaining("Cannot submit design doc from status 'pending_review'"),
    });
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

  it('approves a pending_review design doc', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDoc);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', reviewerId: 'user-reviewer' }),
    );
  });

  it('rejects a pending_review design doc with a comment', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDoc);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewDesignDoc('doc-1', 'user-reviewer', { action: 'reject', comment: 'Not ready' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected', reviewComment: 'Not ready' }),
    );
  });

  it('requests revision with a comment', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDoc);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewDesignDoc('doc-1', 'user-reviewer', { action: 'request_revision', comment: 'Revise section 2' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'revision_requested' }),
    );
  });

  it('throws 400 when rejecting without a comment', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDoc);

    await expect(
      reviewDesignDoc('doc-1', 'user-reviewer', { action: 'reject' }),
    ).rejects.toMatchObject({
      message: 'A comment is required when rejecting or requesting revision',
    });
  });

  it('throws 400 when requesting revision without a comment', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDoc);

    await expect(
      reviewDesignDoc('doc-1', 'user-reviewer', { action: 'request_revision' }),
    ).rejects.toMatchObject({
      message: 'A comment is required when rejecting or requesting revision',
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
