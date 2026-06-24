/**
 * Unit tests for ownerApprovalService.
 * The Drizzle `db` instance is fully mocked so no real database is needed.
 */

// ── DB mock ────────────────────────────────────────────────────────────────────
jest.mock('../db/drizzle', () => {
  const makeInsertChain = () => {
    const chain: any = {
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([]),
      onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
      onConflictDoUpdate: jest.fn().mockReturnThis(),
    };
    return chain;
  };

  const makeUpdateChain = () => ({
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue(undefined),
  });

  return {
    db: {
      query: {
        documentOwnerApprovals: { findFirst: jest.fn() },
        prds: { findFirst: jest.fn() },
        interviews: { findFirst: jest.fn() },
        designDocs: { findFirst: jest.fn() },
      },
      insert: jest.fn().mockImplementation(makeInsertChain),
      update: jest.fn().mockImplementation(makeUpdateChain),
    },
  };
});

import {
  getOwnerApproval,
  recordOwnerApproval,
  isDocumentOwner,
  resolveDocumentOwnerId,
} from '../services/ownerApprovalService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

// ── Fixtures ───────────────────────────────────────────────────────────────────

const approvalRow = {
  id: 'approval-1',
  documentId: 'prd-1',
  documentType: 'prd',
  ownerUserId: 'user-owner',
  status: 'pending' as const,
  comment: null,
  respondedAt: null,
  createdAt: '2026-06-20T00:00:00Z',
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ownerApprovalService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getOwnerApproval', () => {
    it('returns null when no approval exists', async () => {
      mockDb.query.documentOwnerApprovals.findFirst.mockResolvedValue(null);
      const result = await getOwnerApproval('prd-1', 'prd');
      expect(result).toBeNull();
    });

    it('returns the approval row when it exists', async () => {
      mockDb.query.documentOwnerApprovals.findFirst.mockResolvedValue(approvalRow);
      const result = await getOwnerApproval('prd-1', 'prd');
      expect(result).toEqual(approvalRow);
    });
  });

  describe('recordOwnerApproval', () => {
    it('inserts/upserts and returns the approval', async () => {
      const returned = { ...approvalRow, status: 'approved', respondedAt: '2026-06-21T00:00:00Z' };
      const chain = {
        values: jest.fn().mockReturnThis(),
        onConflictDoUpdate: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([returned]),
      };
      mockDb.insert.mockReturnValue(chain);

      const result = await recordOwnerApproval('prd-1', 'prd', 'user-owner', 'approved', 'Looks good');
      expect(result.status).toBe('approved');
      expect(result.documentId).toBe('prd-1');
    });
  });

  describe('resolveDocumentOwnerId', () => {
    it('resolves PRD owner via prds → interviews', async () => {
      mockDb.query.prds.findFirst.mockResolvedValue({ interviewId: 'int-1' });
      mockDb.query.interviews.findFirst.mockResolvedValue({ prdOwnerId: 'user-prd-owner' });

      const result = await resolveDocumentOwnerId('prd-1', 'prd');
      expect(result).toBe('user-prd-owner');
    });

    it('resolves test_case owner via prds → interviews', async () => {
      mockDb.query.prds.findFirst.mockResolvedValue({ interviewId: 'int-1' });
      mockDb.query.interviews.findFirst.mockResolvedValue({ testCaseOwnerId: 'user-tc-owner' });

      const result = await resolveDocumentOwnerId('prd-1', 'test_case');
      expect(result).toBe('user-tc-owner');
    });

    it('resolves design_prototype owner via prds → interviews', async () => {
      mockDb.query.prds.findFirst.mockResolvedValue({ interviewId: 'int-1' });
      mockDb.query.interviews.findFirst.mockResolvedValue({ designPrototypeOwnerId: 'user-dp-owner' });

      const result = await resolveDocumentOwnerId('prd-1', 'design_prototype');
      expect(result).toBe('user-dp-owner');
    });

    it('resolves design_doc owner via designDocs → prds → interviews', async () => {
      mockDb.query.designDocs.findFirst.mockResolvedValue({ prdId: 'prd-1' });
      mockDb.query.prds.findFirst.mockResolvedValue({ interviewId: 'int-1' });
      mockDb.query.interviews.findFirst.mockResolvedValue({ designDocOwnerId: 'user-dd-owner' });

      const result = await resolveDocumentOwnerId('doc-1', 'design_doc');
      expect(result).toBe('user-dd-owner');
    });

    it('returns null when design doc has no prdId', async () => {
      mockDb.query.designDocs.findFirst.mockResolvedValue({ prdId: null });

      const result = await resolveDocumentOwnerId('doc-1', 'design_doc');
      expect(result).toBeNull();
    });

    it('returns null when PRD has no interviewId', async () => {
      mockDb.query.prds.findFirst.mockResolvedValue({ interviewId: null });

      const result = await resolveDocumentOwnerId('prd-1', 'prd');
      expect(result).toBeNull();
    });
  });

  describe('isDocumentOwner', () => {
    it('returns true when userId matches the resolved owner', async () => {
      mockDb.query.prds.findFirst.mockResolvedValue({ interviewId: 'int-1' });
      mockDb.query.interviews.findFirst.mockResolvedValue({ prdOwnerId: 'user-owner' });

      expect(await isDocumentOwner('prd-1', 'prd', 'user-owner')).toBe(true);
    });

    it('returns false when userId does not match', async () => {
      mockDb.query.prds.findFirst.mockResolvedValue({ interviewId: 'int-1' });
      mockDb.query.interviews.findFirst.mockResolvedValue({ prdOwnerId: 'user-owner' });

      expect(await isDocumentOwner('prd-1', 'prd', 'someone-else')).toBe(false);
    });
  });

  describe('two-stage flow', () => {
    it('records reviewer completion then owner approved in sequence', async () => {
      // Step 1: reviewers complete → status stays pending_review (handled by prdService)
      // Step 2: owner gives final approval
      const returned = { ...approvalRow, status: 'approved', respondedAt: '2026-06-21T00:00:00Z' };
      const chain = {
        values: jest.fn().mockReturnThis(),
        onConflictDoUpdate: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([returned]),
      };
      mockDb.insert.mockReturnValue(chain);

      const result = await recordOwnerApproval('prd-1', 'prd', 'user-owner', 'approved');
      expect(result.status).toBe('approved');
    });

    it('owner can request revision', async () => {
      const returned = { ...approvalRow, status: 'revision_requested', comment: 'Needs work', respondedAt: '2026-06-21T00:00:00Z' };
      const chain = {
        values: jest.fn().mockReturnThis(),
        onConflictDoUpdate: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([returned]),
      };
      mockDb.insert.mockReturnValue(chain);

      const result = await recordOwnerApproval('prd-1', 'prd', 'user-owner', 'revision_requested', 'Needs work');
      expect(result.status).toBe('revision_requested');
      expect(result.comment).toBe('Needs work');
    });

    it('records design_doc owner final approval', async () => {
      const returned = {
        ...approvalRow,
        documentId: 'doc-1',
        documentType: 'design_doc' as const,
        status: 'approved' as const,
        respondedAt: '2026-06-21T00:00:00Z',
      };
      const chain = {
        values: jest.fn().mockReturnThis(),
        onConflictDoUpdate: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([returned]),
      };
      mockDb.insert.mockReturnValue(chain);

      const result = await recordOwnerApproval('doc-1', 'design_doc', 'user-owner', 'approved');
      expect(result.documentType).toBe('design_doc');
      expect(result.status).toBe('approved');
    });
  });
});
