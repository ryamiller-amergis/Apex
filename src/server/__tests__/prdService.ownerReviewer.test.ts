/**
 * Unit tests for the owner / reviewer resolution logic added to prdService.
 *
 * Coverage:
 *  - getPrd: ownerId/ownerName are sourced from the interview's prdOwnerId
 *  - getPrd: falls back to authorId/authorName when no interview owner is set
 *  - listPrds: same resolution applied to every row in the list
 *  - getPrd: authorName is always the raw author display name (separate from owner)
 */

// ── DB mock ───────────────────────────────────────────────────────────────────

jest.mock('../db/drizzle', () => {
  const makeSelectChain = () => ({
    from: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockResolvedValue([]),
    limit: jest.fn().mockResolvedValue([]),
  });

  return {
    db: {
      query: { prds: { findFirst: jest.fn() } },
      insert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      select: jest.fn().mockImplementation(makeSelectChain),
    },
  };
});

jest.mock('../services/chatAgentService', () => ({
  readOutputPrd: jest.fn().mockReturnValue(null),
  readOutputBacklog: jest.fn().mockReturnValue(null),
}));
jest.mock('../utils/rbacHelpers', () => ({ isAdminUser: jest.fn().mockResolvedValue(false) }));
jest.mock('../services/documentApprovalService', () => ({
  assignApprovers: jest.fn().mockResolvedValue([]),
  recordApproverResponse: jest.fn().mockResolvedValue(undefined),
  isAssignedApprover: jest.fn().mockResolvedValue(true),
  isApprovalComplete: jest.fn().mockResolvedValue({ complete: true, mode: 'any_one' }),
}));
jest.mock('../services/reviewCommentService', () => ({
  getUnresolvedCount: jest.fn().mockResolvedValue(0),
}));

import { getPrd, listPrds } from '../services/prdService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePrdRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'prd-1',
    interviewId: 'interview-1',
    chatThreadId: 'thread-1',
    authorId: 'user-author',
    project: 'proj-alpha',
    title: 'Feature PRD',
    content: 'Some content',
    backlogJson: null,
    status: 'draft',
    reviewerId: null,
    reviewComment: null,
    reviewedAt: null,
    designDocApproverIds: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

/** Build a fluent select chain that supports any number of .leftJoin() calls. */
function makeSelectChain(data: unknown[], terminal: 'limit' | 'orderBy' = 'limit') {
  const resolved = jest.fn().mockResolvedValue(data);
  const chain: Record<string, jest.Mock> = {};
  chain.leftJoin = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.orderBy = terminal === 'orderBy' ? resolved : jest.fn().mockResolvedValue(data);
  chain.limit = terminal === 'limit' ? resolved : jest.fn().mockResolvedValue(data);
  return { from: jest.fn().mockReturnValue(chain) };
}

// ── getPrd — owner resolution ─────────────────────────────────────────────────

describe('getPrd — owner resolution', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses the interview prdOwner as ownerId and ownerName when set', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([{
      prd: makePrdRow(),
      reviewerDisplayName: null,
      authorDisplayName: 'Alice Author',
      prdOwnerId: 'user-owner',
      prdOwnerDisplayName: 'Bob Owner',
    }]));

    const result = await getPrd('prd-1');

    expect(result!.ownerId).toBe('user-owner');
    expect(result!.ownerName).toBe('Bob Owner');
  });

  it('falls back to authorId as ownerId when no interview prdOwner is set', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([{
      prd: makePrdRow(),
      reviewerDisplayName: null,
      authorDisplayName: 'Alice Author',
      prdOwnerId: null,
      prdOwnerDisplayName: null,
    }]));

    const result = await getPrd('prd-1');

    expect(result!.ownerId).toBe('user-author');
  });

  it('falls back to authorName as ownerName when no interview prdOwner is set', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([{
      prd: makePrdRow(),
      reviewerDisplayName: null,
      authorDisplayName: 'Alice Author',
      prdOwnerId: null,
      prdOwnerDisplayName: null,
    }]));

    const result = await getPrd('prd-1');

    expect(result!.ownerName).toBe('Alice Author');
  });

  it('ownerName is undefined when neither interview owner nor author has a display name', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([{
      prd: makePrdRow(),
      reviewerDisplayName: null,
      authorDisplayName: null,
      prdOwnerId: null,
      prdOwnerDisplayName: null,
    }]));

    const result = await getPrd('prd-1');

    expect(result!.ownerName).toBeUndefined();
    expect(result!.ownerId).toBe('user-author');
  });

  it('authorName always reflects the PRD creator, independent of owner', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([{
      prd: makePrdRow(),
      reviewerDisplayName: null,
      authorDisplayName: 'Alice Author',
      prdOwnerId: 'user-owner',
      prdOwnerDisplayName: 'Bob Owner',
    }]));

    const result = await getPrd('prd-1');

    // ownerName is Bob (from interview), authorName is still Alice
    expect(result!.ownerName).toBe('Bob Owner');
    expect(result!.authorName).toBe('Alice Author');
  });

  it('returns null when PRD is not found', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([]));

    const result = await getPrd('prd-missing');

    expect(result).toBeNull();
  });
});

// ── listPrds — owner resolution ───────────────────────────────────────────────

describe('listPrds — owner resolution', () => {
  beforeEach(() => jest.clearAllMocks());

  it('populates ownerId/ownerName from the interview prdOwner for each row', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([
      {
        prd: makePrdRow({ id: 'prd-a' }),
        reviewerDisplayName: null,
        authorDisplayName: 'Alice',
        prdOwnerId: 'user-owner-1',
        prdOwnerDisplayName: 'Carol Owner',
      },
    ], 'orderBy'));

    const result = await listPrds();

    expect(result[0].ownerId).toBe('user-owner-1');
    expect(result[0].ownerName).toBe('Carol Owner');
  });

  it('falls back to authorId/authorName when no interview owner is present', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([
      {
        prd: makePrdRow({ id: 'prd-b' }),
        reviewerDisplayName: null,
        authorDisplayName: 'Dave Author',
        prdOwnerId: null,
        prdOwnerDisplayName: null,
      },
    ], 'orderBy'));

    const result = await listPrds();

    expect(result[0].ownerId).toBe('user-author');
    expect(result[0].ownerName).toBe('Dave Author');
  });

  it('handles mixed rows — some with owners, some without', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([
      {
        prd: makePrdRow({ id: 'prd-with-owner' }),
        reviewerDisplayName: null,
        authorDisplayName: 'Alice',
        prdOwnerId: 'user-owner',
        prdOwnerDisplayName: 'Bob Owner',
      },
      {
        prd: makePrdRow({ id: 'prd-no-owner', authorId: 'user-alice' }),
        reviewerDisplayName: null,
        authorDisplayName: 'Alice',
        prdOwnerId: null,
        prdOwnerDisplayName: null,
      },
    ], 'orderBy'));

    const result = await listPrds();

    expect(result[0].ownerName).toBe('Bob Owner');
    expect(result[1].ownerId).toBe('user-alice');
    expect(result[1].ownerName).toBe('Alice');
  });
});
