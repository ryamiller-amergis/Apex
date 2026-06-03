/**
 * Unit tests for reviewCommentService.
 *
 * Coverage:
 *  1. addReply — notifies all thread participants (commenter + prior repliers + doc owners),
 *                never notifies the replier themselves
 *  2. createComment — notifies document owners, excludes the commenter
 *  3. resolveComment — enforces doc owner / assigned-approver gate
 *  4. reopenComment  — same gate as resolve
 *  5. deleteComment  — allows comment author, doc owner, or assigned approver
 *  6. getUnresolvedCount — returns count of open comments
 */

// ── DB mock ─────────────────────────────────────────────────────────────────────

jest.mock('../db/drizzle', () => {
  const makeInsertChain = () => ({
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
  });

  const makeUpdateChain = () => ({
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
  });

  const makeSelectChain = () => ({
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
    limit: jest.fn().mockResolvedValue([]),
    orderBy: jest.fn().mockResolvedValue([]),
  });

  const makeDeleteChain = () => ({
    where: jest.fn().mockResolvedValue(undefined),
  });

  return {
    db: {
      insert: jest.fn().mockImplementation(makeInsertChain),
      update: jest.fn().mockImplementation(makeUpdateChain),
      select: jest.fn().mockImplementation(makeSelectChain),
      delete: jest.fn().mockImplementation(makeDeleteChain),
      query: {
        reviewComments: {
          findFirst: jest.fn(),
        },
      },
    },
  };
});

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue({}),
}));

jest.mock('../services/documentApprovalService', () => ({
  isAssignedApprover: jest.fn().mockResolvedValue(false),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────────

import {
  addReply,
  createComment,
  resolveComment,
  reopenComment,
  deleteComment,
  getUnresolvedCount,
} from '../services/reviewCommentService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };
const { createNotification: mockCreateNotification } = jest.requireMock(
  '../services/notificationService',
) as { createNotification: jest.Mock };
const { isAssignedApprover: mockIsAssignedApprover } = jest.requireMock(
  '../services/documentApprovalService',
) as { isAssignedApprover: jest.Mock };

// ── Chain helpers ───────────────────────────────────────────────────────────────

/** select → from → where  (resolves to rows) */
function makeWhereSelectChain(rows: any[]) {
  const whereMock = jest.fn().mockResolvedValue(rows);
  const fromMock = jest.fn().mockReturnValue({ where: whereMock });
  return { from: fromMock };
}

/** select → from → where → limit  (resolves to rows) */
function makeLimitSelectChain(rows: any[]) {
  const limitMock = jest.fn().mockResolvedValue(rows);
  const whereMock = jest.fn().mockReturnValue({ limit: limitMock });
  const fromMock = jest.fn().mockReturnValue({ where: whereMock });
  return { from: fromMock };
}

/** select → from → innerJoin → where → limit  (resolves to rows) */
function makeInnerJoinLimitSelectChain(rows: any[]) {
  const limitMock = jest.fn().mockResolvedValue(rows);
  const whereMock = jest.fn().mockReturnValue({ limit: limitMock });
  const innerJoinMock = jest.fn().mockReturnValue({ where: whereMock });
  const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoinMock });
  return { from: fromMock };
}

/** select → from → innerJoin → where → orderBy  (resolves to rows) */
function makeOrderBySelectChain(rows: any[]) {
  const orderByMock = jest.fn().mockResolvedValue(rows);
  const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
  const innerJoinMock = jest.fn().mockReturnValue({ where: whereMock });
  const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoinMock });
  return { from: fromMock };
}

// ── Fixtures ────────────────────────────────────────────────────────────────────

const baseComment = {
  id: 'comment-1',
  documentId: 'prd-1',
  documentType: 'prd',
  sectionKey: 'prd',
  authorUserId: 'owner-1',
  body: 'Original comment',
  selectorExact: 'some text',
  selectorPrefix: null,
  selectorSuffix: null,
  selectorStart: null,
  selectorEnd: null,
  status: 'open',
  resolvedBy: null,
  resolvedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const baseReplyRow = {
  id: 'reply-1',
  commentId: 'comment-1',
  authorUserId: 'approver-1',
  authorDisplayName: 'Alice Approver',
  body: 'A reply',
  createdAt: '2026-01-02T00:00:00Z',
};

// ── Shared select setup for addReply (PRD with separate owner) ──────────────────

/**
 * Sets up the four consecutive `db.select` calls made inside addReply for a PRD document:
 *   1. Prior replies lookup
 *   2. getDocumentAuthorId (prd) → from prds, limit
 *   3. getDocumentOwnerIds prd owner join → from prds innerJoin interviews, limit
 *   4. getDocumentTitle → from prds, limit
 *   5. Author display name → from appUsers, limit
 */
function setupAddReplySelects(opts: {
  priorReplies?: Array<{ authorUserId: string }>;
  authorId?: string;
  ownerId?: string | null;
  title?: string;
  replierDisplayName?: string;
}) {
  const {
    priorReplies = [],
    authorId = 'doc-author-1',
    ownerId = null,
    title = 'My PRD',
    replierDisplayName = 'Alice Approver',
  } = opts;

  mockDb.select
    .mockReturnValueOnce(makeWhereSelectChain(priorReplies))
    .mockReturnValueOnce(makeLimitSelectChain([{ authorId }]))
    .mockReturnValueOnce(makeInnerJoinLimitSelectChain(ownerId ? [{ prdOwnerId: ownerId }] : []))
    .mockReturnValueOnce(makeLimitSelectChain([{ title }]))
    .mockReturnValueOnce(makeLimitSelectChain([{ displayName: replierDisplayName }]));
}

// ── addReply ────────────────────────────────────────────────────────────────────

describe('addReply', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.query.reviewComments.findFirst.mockResolvedValue(baseComment);
    const returningMock = jest.fn().mockResolvedValue([baseReplyRow]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });
  });

  it('throws a 400 when body is empty', async () => {
    await expect(addReply('comment-1', 'approver-1', '   ')).rejects.toThrow(/Reply body is required/);
  });

  it('throws a 404 when the comment does not exist', async () => {
    mockDb.query.reviewComments.findFirst.mockResolvedValue(undefined);
    await expect(addReply('missing-id', 'approver-1', 'hello')).rejects.toThrow(/Comment not found/);
  });

  it('notifies the document author when an approver replies (no prior repliers)', async () => {
    // doc author is the same person as the comment author ('owner-1') so only 1 notification fires
    setupAddReplySelects({ authorId: 'owner-1', ownerId: null });

    await addReply('comment-1', 'approver-1', 'A reply');

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      'owner-1',
      expect.objectContaining({ type: 'user-action', title: 'New reply on a review comment' }),
    );
  });

  it('notifies the original comment author when someone else replies', async () => {
    // comment author and doc author are the same ('owner-1'); replier is 'approver-1'
    setupAddReplySelects({ authorId: 'owner-1', ownerId: null });

    await addReply('comment-1', 'approver-1', 'A reply');

    const notifiedIds = mockCreateNotification.mock.calls.map((c: any[]) => c[0] as string);
    expect(notifiedIds).toContain('owner-1');
  });

  it('notifies all prior repliers as well as the doc author', async () => {
    setupAddReplySelects({
      priorReplies: [{ authorUserId: 'replier-a' }, { authorUserId: 'replier-b' }],
      authorId: 'doc-author-1',
      ownerId: null,
    });

    await addReply('comment-1', 'new-replier', 'Another reply');

    const notifiedIds = mockCreateNotification.mock.calls.map((c: any[]) => c[0] as string);
    expect(notifiedIds).toContain('replier-a');
    expect(notifiedIds).toContain('replier-b');
    expect(notifiedIds).toContain('doc-author-1');
  });

  it('never notifies the person who just replied', async () => {
    const replier = 'approver-1';
    setupAddReplySelects({
      priorReplies: [{ authorUserId: replier }],
      authorId: 'doc-author-1',
      ownerId: null,
    });

    await addReply('comment-1', replier, 'Self reply');

    const notifiedIds = mockCreateNotification.mock.calls.map((c: any[]) => c[0] as string);
    expect(notifiedIds).not.toContain(replier);
  });

  it('deduplicates recipients so each person gets exactly one notification', async () => {
    // doc author is the same as the original comment author (baseComment.authorUserId = 'owner-1')
    // ownerId also resolves to the same person
    setupAddReplySelects({
      priorReplies: [{ authorUserId: 'owner-1' }],
      authorId: 'owner-1',
      ownerId: 'owner-1',
    });

    await addReply('comment-1', 'approver-1', 'Reply text');

    const notifiedIds = mockCreateNotification.mock.calls.map((c: any[]) => c[0] as string);
    const timesOwnerNotified = notifiedIds.filter((id) => id === 'owner-1').length;
    expect(timesOwnerNotified).toBe(1);
  });

  it('also notifies a separate document owner (prd.ownerId) when present', async () => {
    setupAddReplySelects({
      authorId: 'doc-author-1',
      ownerId: 'doc-owner-2',
    });

    await addReply('comment-1', 'approver-1', 'A reply');

    const notifiedIds = mockCreateNotification.mock.calls.map((c: any[]) => c[0] as string);
    expect(notifiedIds).toContain('doc-owner-2');
  });

  it('does not block the reply when notification delivery fails', async () => {
    setupAddReplySelects({ authorId: 'doc-author-1' });
    mockCreateNotification.mockRejectedValue(new Error('notification service down'));

    const reply = await addReply('comment-1', 'approver-1', 'A reply');

    expect(reply).toBeDefined();
    expect(reply.id).toBe('reply-1');
  });

  it('returns a reply with the author display name', async () => {
    setupAddReplySelects({ authorId: 'doc-author-1', replierDisplayName: 'Alice Approver' });

    const reply = await addReply('comment-1', 'approver-1', 'A reply');

    expect(reply.authorDisplayName).toBe('Alice Approver');
  });
});

// ── createComment ───────────────────────────────────────────────────────────────

describe('createComment', () => {
  const baseSelector = { exact: 'some text', prefix: '', suffix: '', start: 0, end: 9 };

  beforeEach(() => {
    jest.clearAllMocks();

    const returningMock = jest.fn().mockResolvedValue([{
      ...baseComment,
      id: 'new-comment-1',
    }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });
  });

  it('throws a 400 when body is empty', async () => {
    await expect(
      createComment('prd-1', 'prd', 'prd', 'author-1', '', baseSelector),
    ).rejects.toThrow(/Comment body is required/);
  });

  it('notifies the document owner, not the commenter', async () => {
    mockDb.select
      // autoTransitionToRevisionRequested — count query
      .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ value: 0 }]) }) })
      // getDocumentAuthorId (prd)
      .mockReturnValueOnce(makeLimitSelectChain([{ authorId: 'prd-owner' }]))
      // getDocumentOwnerIds prd join
      .mockReturnValueOnce(makeInnerJoinLimitSelectChain([]))
      // getDocumentTitle
      .mockReturnValueOnce(makeLimitSelectChain([{ title: 'Auth PRD' }]))
      // author display name
      .mockReturnValueOnce(makeLimitSelectChain([{ displayName: 'Bob Commenter' }]));

    await createComment('prd-1', 'prd', 'prd', 'commenter-1', 'Looks good', baseSelector);

    expect(mockCreateNotification).toHaveBeenCalledWith(
      'prd-owner',
      expect.objectContaining({ type: 'user-action', title: 'New review comment on your document' }),
    );
    const notifiedIds = mockCreateNotification.mock.calls.map((c: any[]) => c[0] as string);
    expect(notifiedIds).not.toContain('commenter-1');
  });

  it('does not send a notification when the commenter IS the document owner', async () => {
    const userId = 'owner-and-commenter';

    mockDb.select
      .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ value: 0 }]) }) })
      .mockReturnValueOnce(makeLimitSelectChain([{ authorId: userId }]))
      .mockReturnValueOnce(makeInnerJoinLimitSelectChain([]))
      .mockReturnValueOnce(makeLimitSelectChain([{ title: 'PRD' }]))
      .mockReturnValueOnce(makeLimitSelectChain([{ displayName: 'Owner' }]));

    await createComment('prd-1', 'prd', 'prd', userId, 'Self comment', baseSelector);

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});

// ── resolveComment ───────────────────────────────────────────────────────────────

describe('resolveComment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Explicitly reset the select mock to flush any stale mockReturnValueOnce queue
    // from prior describe blocks (jest.clearAllMocks does not flush the once-queue in
    // some Jest versions).
    mockDb.select.mockReset();
    mockDb.query.reviewComments.findFirst.mockResolvedValue(baseComment);

    const whereMock = jest.fn().mockResolvedValue([]);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });
  });

  it('allows the document author to resolve', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ authorId: 'doc-author-1' }]))
      .mockReturnValueOnce(makeInnerJoinLimitSelectChain([]));

    await expect(resolveComment('comment-1', 'doc-author-1')).resolves.toBeUndefined();
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });

  it('allows an assigned approver to resolve', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ authorId: 'doc-author-1' }]))
      .mockReturnValueOnce(makeInnerJoinLimitSelectChain([]));
    mockIsAssignedApprover.mockResolvedValue(true);

    await expect(resolveComment('comment-1', 'approver-99')).resolves.toBeUndefined();
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });

  it('throws 403 for a user who is neither owner nor approver', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ authorId: 'doc-author-1' }]))
      .mockReturnValueOnce(makeInnerJoinLimitSelectChain([]));
    mockIsAssignedApprover.mockResolvedValue(false);

    await expect(resolveComment('comment-1', 'random-user')).rejects.toMatchObject({ status: 403 });
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('throws 404 when the comment does not exist', async () => {
    mockDb.query.reviewComments.findFirst.mockResolvedValue(undefined);

    await expect(resolveComment('missing', 'doc-author-1')).rejects.toMatchObject({ status: 404 });
  });
});

// ── reopenComment ────────────────────────────────────────────────────────────────

describe('reopenComment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.select.mockReset();
    mockDb.query.reviewComments.findFirst.mockResolvedValue({ ...baseComment, status: 'resolved' });

    const whereMock = jest.fn().mockResolvedValue([]);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });
  });

  it('allows the document owner to reopen', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ authorId: 'doc-author-1' }]))
      .mockReturnValueOnce(makeInnerJoinLimitSelectChain([]));

    await expect(reopenComment('comment-1', 'doc-author-1')).resolves.toBeUndefined();
  });

  it('throws 403 for an unauthorised user', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ authorId: 'doc-author-1' }]))
      .mockReturnValueOnce(makeInnerJoinLimitSelectChain([]));
    mockIsAssignedApprover.mockResolvedValue(false);

    await expect(reopenComment('comment-1', 'outsider')).rejects.toMatchObject({ status: 403 });
  });
});

// ── deleteComment ────────────────────────────────────────────────────────────────

describe('deleteComment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.select.mockReset();
    mockDb.query.reviewComments.findFirst.mockResolvedValue(baseComment);
    mockDb.delete.mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
  });

  it('allows the comment author to delete their own comment', async () => {
    await expect(deleteComment('comment-1', 'owner-1')).resolves.toBeUndefined();
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
  });

  it('allows the document owner to delete any comment', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ authorId: 'doc-author-1' }]))
      .mockReturnValueOnce(makeInnerJoinLimitSelectChain([]));

    await expect(deleteComment('comment-1', 'doc-author-1')).resolves.toBeUndefined();
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
  });

  it('allows an assigned approver to delete a comment', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ authorId: 'doc-author-1' }]))
      .mockReturnValueOnce(makeInnerJoinLimitSelectChain([]));
    mockIsAssignedApprover.mockResolvedValue(true);

    await expect(deleteComment('comment-1', 'approver-99')).resolves.toBeUndefined();
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
  });

  it('throws 403 when a random user tries to delete', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ authorId: 'doc-author-1' }]))
      .mockReturnValueOnce(makeInnerJoinLimitSelectChain([]));
    mockIsAssignedApprover.mockResolvedValue(false);

    await expect(deleteComment('comment-1', 'intruder')).rejects.toMatchObject({ status: 403 });
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it('throws 404 when the comment does not exist', async () => {
    mockDb.query.reviewComments.findFirst.mockResolvedValue(undefined);

    await expect(deleteComment('missing', 'anyone')).rejects.toMatchObject({ status: 404 });
  });
});

// ── getUnresolvedCount ───────────────────────────────────────────────────────────

describe('getUnresolvedCount', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the count of open comments for a document', async () => {
    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ value: 3 }]),
      }),
    });

    const result = await getUnresolvedCount('prd-1', 'prd');

    expect(result).toBe(3);
  });

  it('returns 0 when there are no open comments', async () => {
    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ value: 0 }]),
      }),
    });

    const result = await getUnresolvedCount('prd-1', 'prd');

    expect(result).toBe(0);
  });

  it('returns 0 when the query returns no rows', async () => {
    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    });

    const result = await getUnresolvedCount('prd-1', 'prd');

    expect(result).toBe(0);
  });
});
