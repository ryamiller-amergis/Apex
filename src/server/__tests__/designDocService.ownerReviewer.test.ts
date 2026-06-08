/**
 * Unit tests for the owner / reviewer resolution logic added to designDocService.
 *
 * Coverage:
 *  - getDesignDoc: ownerId/ownerName are sourced from the interview's designDocOwnerId
 *  - getDesignDoc: falls back to authorId/authorName when no interview owner is set
 *  - listDesignDocs: same resolution applied to every row
 *  - getDesignDoc: authorName remains the raw author, independent of owner
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
      query: { designDocs: { findFirst: jest.fn() } },
      insert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
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
jest.mock('../utils/rbacHelpers', () => ({ isAdminUser: jest.fn().mockResolvedValue(false) }));
jest.mock('../services/projectSettingsService', () => ({ getSkillConfig: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/appSettingsService', () => ({ getDefaultModel: jest.fn().mockResolvedValue('default-model') }));
jest.mock('../services/prdService', () => ({ getPrd: jest.fn().mockResolvedValue(null) }));
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

import { getDesignDoc, listDesignDocs } from '../services/designDocService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDocRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'doc-1',
    prdId: 'prd-1',
    chatThreadId: 'thread-1',
    authorId: 'user-author',
    project: 'proj-alpha',
    status: 'draft',
    designContent: '',
    techSpecContent: '',
    assumptionsContent: '',
    validationScorecardJson: null,
    validationScorecardMd: null,
    validationStatus: null,
    qaChatThreadId: null,
    docAssistantThreadId: null,
    reviewerId: null,
    reviewComment: null,
    reviewedAt: null,
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

// ── getDesignDoc — owner resolution ──────────────────────────────────────────

describe('getDesignDoc — owner resolution', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses the interview designDocOwner as ownerId and ownerName when set', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([{
      designDoc: makeDocRow(),
      reviewerDisplayName: null,
      authorDisplayName: 'Alice Author',
      designDocOwnerId: 'user-owner',
      designDocOwnerDisplayName: 'Bob Owner',
    }]));

    const result = await getDesignDoc('doc-1');

    expect(result!.ownerId).toBe('user-owner');
    expect(result!.ownerName).toBe('Bob Owner');
  });

  it('falls back to authorId as ownerId when no interview designDocOwner is set', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([{
      designDoc: makeDocRow(),
      reviewerDisplayName: null,
      authorDisplayName: 'Alice Author',
      designDocOwnerId: null,
      designDocOwnerDisplayName: null,
    }]));

    const result = await getDesignDoc('doc-1');

    expect(result!.ownerId).toBe('user-author');
  });

  it('falls back to authorName as ownerName when no interview designDocOwner is set', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([{
      designDoc: makeDocRow(),
      reviewerDisplayName: null,
      authorDisplayName: 'Alice Author',
      designDocOwnerId: null,
      designDocOwnerDisplayName: null,
    }]));

    const result = await getDesignDoc('doc-1');

    expect(result!.ownerName).toBe('Alice Author');
  });

  it('ownerName is undefined when neither interview owner nor author has a display name', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([{
      designDoc: makeDocRow(),
      reviewerDisplayName: null,
      authorDisplayName: null,
      designDocOwnerId: null,
      designDocOwnerDisplayName: null,
    }]));

    const result = await getDesignDoc('doc-1');

    expect(result!.ownerName).toBeUndefined();
    expect(result!.ownerId).toBe('user-author');
  });

  it('authorName always reflects the doc creator, independent of owner', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([{
      designDoc: makeDocRow(),
      reviewerDisplayName: null,
      authorDisplayName: 'Alice Author',
      designDocOwnerId: 'user-owner',
      designDocOwnerDisplayName: 'Bob Owner',
    }]));

    const result = await getDesignDoc('doc-1');

    expect(result!.ownerName).toBe('Bob Owner');
    expect(result!.authorName).toBe('Alice Author');
  });

  it('returns null when the design doc is not found', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([]));

    const result = await getDesignDoc('doc-missing');

    expect(result).toBeNull();
  });
});

// ── listDesignDocs — owner resolution ────────────────────────────────────────

describe('listDesignDocs — owner resolution', () => {
  beforeEach(() => jest.clearAllMocks());

  it('populates ownerId/ownerName from the interview designDocOwner for each row', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([{
      designDoc: makeDocRow(),
      reviewerDisplayName: null,
      authorDisplayName: 'Alice',
      prdTitle: 'PRD Title',
      designDocOwnerId: 'user-owner-1',
      designDocOwnerDisplayName: 'Carol Owner',
    }], 'orderBy'));

    const result = await listDesignDocs();

    expect(result[0].ownerId).toBe('user-owner-1');
    expect(result[0].ownerName).toBe('Carol Owner');
  });

  it('falls back to authorId/authorName when no interview owner is present', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([{
      designDoc: makeDocRow(),
      reviewerDisplayName: null,
      authorDisplayName: 'Dave Author',
      prdTitle: null,
      designDocOwnerId: null,
      designDocOwnerDisplayName: null,
    }], 'orderBy'));

    const result = await listDesignDocs();

    expect(result[0].ownerId).toBe('user-author');
    expect(result[0].ownerName).toBe('Dave Author');
  });

  it('handles mixed rows — some with owners, some without', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([
      {
        designDoc: makeDocRow({ id: 'doc-with-owner' }),
        reviewerDisplayName: null,
        authorDisplayName: 'Alice',
        prdTitle: null,
        designDocOwnerId: 'user-owner',
        designDocOwnerDisplayName: 'Bob Owner',
      },
      {
        designDoc: makeDocRow({ id: 'doc-no-owner', authorId: 'user-alice' }),
        reviewerDisplayName: null,
        authorDisplayName: 'Alice',
        prdTitle: null,
        designDocOwnerId: null,
        designDocOwnerDisplayName: null,
      },
    ], 'orderBy'));

    const result = await listDesignDocs();

    expect(result[0].ownerName).toBe('Bob Owner');
    expect(result[1].ownerId).toBe('user-alice');
    expect(result[1].ownerName).toBe('Alice');
  });
});
