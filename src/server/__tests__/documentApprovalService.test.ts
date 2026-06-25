/**
 * Unit tests for documentApprovalService.
 * The Drizzle `db` instance and projectSettingsService are fully mocked.
 */

// ── DB mock ────────────────────────────────────────────────────────────────────

jest.mock('../db/drizzle', () => {
  const makeInsertChain = () => ({
    values: jest.fn().mockReturnThis(),
    onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
  });

  const makeUpdateChain = () => ({
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
  });

  const makeSelectChain = () => ({
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
    limit: jest.fn().mockResolvedValue([]),
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
    },
  };
});

jest.mock('../services/projectSettingsService', () => {
  const mockGetApproversForDocument = jest.fn().mockResolvedValue([]);
  return {
    getApproversForDocumentByProject: mockGetApproversForDocument,
    getApproverUserIdsForProject: jest.fn(async (project: string, _docType: string) => {
      const pool = await mockGetApproversForDocument(project, _docType);
      return pool.map((a: any) => a.userId);
    }),
    getApproverPoolForProject: jest.fn().mockResolvedValue({ individuals: [], groups: [] }),
  };
});

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue({}),
}));

import {
  assignApprovers,
  getAssignments,
  recordApproverResponse,
  isApprovalComplete,
  isAssignedApprover,
  getAvailableApprovers,
  propagateDesignDocApprovers,
  reassignApprovers,
  notifyApproversDocumentReady,
} from '../services/documentApprovalService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };
const { getApproversForDocumentByProject: mockGetApproversForDocument } = jest.requireMock(
  '../services/projectSettingsService',
) as { getApproversForDocumentByProject: jest.Mock };

const { createNotification: mockCreateNotification } = jest.requireMock(
  '../services/notificationService',
) as { createNotification: jest.Mock };

// ── Helpers ─────────────────────────────────────────────────────────────────────

/** Builds a mock select chain for getAssignments: select → from → innerJoin → where */
function makeAssignmentSelectChain(rows: any[]) {
  const whereMock = jest.fn().mockResolvedValue(rows);
  const innerJoinMock = jest.fn().mockReturnValue({ where: whereMock });
  const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoinMock });
  return { from: fromMock };
}

/** Builds a mock select chain ending in .limit(): select → from → where → limit */
function makeLimitSelectChain(rows: any[]) {
  const limitMock = jest.fn().mockResolvedValue(rows);
  const whereMock = jest.fn().mockReturnValue({ limit: limitMock });
  const fromMock = jest.fn().mockReturnValue({ where: whereMock });
  return { from: fromMock };
}

/** Builds a mock select chain ending in .where(): select → from → where */
function makeWhereSelectChain(rows: any[]) {
  const whereMock = jest.fn().mockResolvedValue(rows);
  const fromMock = jest.fn().mockReturnValue({ where: whereMock });
  return { from: fromMock };
}

function makeAssignmentRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'assign-1',
    documentId: 'prd-1',
    documentType: 'prd',
    approverUserId: 'approver-1',
    approverDisplayName: 'Alice Approver',
    status: 'pending',
    comment: null,
    respondedAt: null,
    assignedAt: '2026-01-01T00:00:00Z',
    assignedBy: 'user-1',
    ...overrides,
  };
}

// ── getAssignments ──────────────────────────────────────────────────────────────

describe('getAssignments', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns assignments with display names from joined app_users', async () => {
    mockDb.select.mockReturnValue(makeAssignmentSelectChain([makeAssignmentRow()]));

    const result = await getAssignments('prd-1', 'prd');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'assign-1',
      documentType: 'prd',
      approverDisplayName: 'Alice Approver',
      status: 'pending',
    });
  });

  it('returns empty array when no assignments exist', async () => {
    mockDb.select.mockReturnValue(makeAssignmentSelectChain([]));

    const result = await getAssignments('prd-1', 'prd');

    expect(result).toEqual([]);
  });
});

// ── assignApprovers ─────────────────────────────────────────────────────────────

describe('assignApprovers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns existing assignments when approverUserIds is empty', async () => {
    mockDb.select.mockReturnValue(makeAssignmentSelectChain([]));

    const result = await assignApprovers('prd-1', 'prd', [], 'user-1');

    expect(result).toEqual([]);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('inserts assignment rows and returns them', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ project: 'proj-alpha' }]))
      .mockReturnValueOnce(makeLimitSelectChain([{ title: 'Test PRD' }]))
      .mockReturnValueOnce(makeAssignmentSelectChain([makeAssignmentRow()]));

    mockGetApproversForDocument.mockResolvedValue([
      { userId: 'approver-1', displayName: 'Alice Approver' },
    ]);

    const onConflictMock = jest.fn().mockResolvedValue(undefined);
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoNothing: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    const result = await assignApprovers('prd-1', 'prd', ['approver-1'], 'user-1');

    expect(result).toHaveLength(1);
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });

  it('throws when a userId is not in the project approver pool', async () => {
    mockDb.select.mockReturnValue(makeLimitSelectChain([{ project: 'proj-alpha' }]));
    mockGetApproversForDocument.mockResolvedValue([
      { userId: 'approver-1', displayName: 'Alice' },
    ]);

    await expect(
      assignApprovers('prd-1', 'prd', ['unknown-user'], 'user-1'),
    ).rejects.toThrow(/not in the prd approver pool/);
  });

  it('sends a notification to each assigned approver', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ project: 'proj-alpha' }]))
      .mockReturnValueOnce(makeLimitSelectChain([{ title: 'My PRD' }]))
      .mockReturnValueOnce(makeAssignmentSelectChain([makeAssignmentRow()]));

    mockGetApproversForDocument.mockResolvedValue([
      { userId: 'approver-1', displayName: 'Alice' },
      { userId: 'approver-2', displayName: 'Bob' },
    ]);

    const onConflictMock = jest.fn().mockResolvedValue(undefined);
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoNothing: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await assignApprovers('prd-1', 'prd', ['approver-1', 'approver-2'], 'user-1');
    await new Promise((r) => setTimeout(r, 10));

    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    expect(mockCreateNotification).toHaveBeenCalledWith('approver-1', expect.objectContaining({
      type: 'user-action',
      title: 'You have been assigned as a PRD reviewer',
      body: 'Review requested for: My PRD',
      link: '/backlog/prd/prd-1',
    }));
    expect(mockCreateNotification).toHaveBeenCalledWith('approver-2', expect.objectContaining({
      type: 'user-action',
      title: 'You have been assigned as a PRD reviewer',
      body: 'Review requested for: My PRD',
      link: '/backlog/prd/prd-1',
    }));
  });

  it('sends design doc approver notification with correct title and link', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ project: 'proj-alpha' }]))
      .mockReturnValueOnce(makeLimitSelectChain([{ title: 'Auth Flow Design' }]))
      .mockReturnValueOnce(makeAssignmentSelectChain([
        makeAssignmentRow({ documentId: 'dd-1', documentType: 'design_doc', approverUserId: 'approver-1' }),
      ]));

    mockGetApproversForDocument.mockResolvedValue([
      { userId: 'approver-1', displayName: 'Alice' },
    ]);

    const onConflictMock = jest.fn().mockResolvedValue(undefined);
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoNothing: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await assignApprovers('dd-1', 'design_doc', ['approver-1'], 'user-1');
    await new Promise((r) => setTimeout(r, 10));

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith('approver-1', expect.objectContaining({
      type: 'user-action',
      title: 'You have been assigned as a design doc approver',
      body: 'Review requested for: Auth Flow Design',
      link: '/backlog/design-doc/dd-1',
    }));
  });

  it('does not send notifications when approverUserIds is empty', async () => {
    mockDb.select.mockReturnValue(makeAssignmentSelectChain([]));

    await assignApprovers('prd-1', 'prd', [], 'user-1');
    await new Promise((r) => setTimeout(r, 10));

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('does not block assignment if notification fails', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ project: 'proj-alpha' }]))
      .mockReturnValueOnce(makeLimitSelectChain([{ title: 'My PRD' }]))
      .mockReturnValueOnce(makeAssignmentSelectChain([makeAssignmentRow()]));

    mockGetApproversForDocument.mockResolvedValue([
      { userId: 'approver-1', displayName: 'Alice' },
    ]);

    const onConflictMock = jest.fn().mockResolvedValue(undefined);
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoNothing: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });
    mockCreateNotification.mockRejectedValue(new Error('notification service down'));

    const result = await assignApprovers('prd-1', 'prd', ['approver-1'], 'user-1');

    expect(result).toHaveLength(1);
  });

  it('handles onConflictDoNothing gracefully', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ project: 'proj-alpha' }]))
      .mockReturnValueOnce(makeLimitSelectChain([{ title: 'Test PRD' }]))
      .mockReturnValueOnce(makeAssignmentSelectChain([]));

    mockGetApproversForDocument.mockResolvedValue([
      { userId: 'approver-1', displayName: 'Alice' },
    ]);

    const onConflictMock = jest.fn().mockResolvedValue(undefined);
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoNothing: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await assignApprovers('prd-1', 'prd', ['approver-1'], 'user-1');

    expect(onConflictMock).toHaveBeenCalledTimes(1);
  });
});

// ── recordApproverResponse ──────────────────────────────────────────────────────

describe('recordApproverResponse', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates status, comment, respondedAt on the assignment row', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'assign-1' }]);
    const whereMock = jest.fn().mockReturnValue({ returning: returningMock });
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await recordApproverResponse('prd-1', 'prd', 'approver-1', 'approved', 'LGTM');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', comment: 'LGTM' }),
    );
    expect(setMock.mock.calls[0][0].respondedAt).toBeDefined();
  });

  it('throws when no matching assignment found', async () => {
    const returningMock = jest.fn().mockResolvedValue([]);
    const whereMock = jest.fn().mockReturnValue({ returning: returningMock });
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await expect(
      recordApproverResponse('prd-1', 'prd', 'unknown', 'approved'),
    ).rejects.toThrow(/No assignment found/);
  });
});

// ── isApprovalComplete ──────────────────────────────────────────────────────────

describe('isApprovalComplete', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns complete=true for any_one mode when at least one approved', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ approvalMode: 'any_one' }]))
      .mockReturnValueOnce(makeAssignmentSelectChain([
        makeAssignmentRow({ id: 'a1', status: 'approved' }),
        makeAssignmentRow({ id: 'a2', approverUserId: 'u2', status: 'pending' }),
      ]));

    const result = await isApprovalComplete('prd-1', 'prd', 'proj');

    expect(result).toEqual({ complete: true, mode: 'any_one' });
  });

  it('returns complete=false for any_one mode when none approved', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ approvalMode: 'any_one' }]))
      .mockReturnValueOnce(makeAssignmentSelectChain([
        makeAssignmentRow({ status: 'pending' }),
      ]));

    const result = await isApprovalComplete('prd-1', 'prd', 'proj');

    expect(result).toEqual({ complete: false, mode: 'any_one' });
  });

  it('returns complete=true for all_required when all approved', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ approvalMode: 'all_required' }]))
      .mockReturnValueOnce(makeAssignmentSelectChain([
        makeAssignmentRow({ id: 'a1', status: 'approved' }),
        makeAssignmentRow({ id: 'a2', approverUserId: 'u2', status: 'approved' }),
      ]));

    const result = await isApprovalComplete('prd-1', 'prd', 'proj');

    expect(result).toEqual({ complete: true, mode: 'all_required' });
  });

  it('returns complete=false for all_required when some pending', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ approvalMode: 'all_required' }]))
      .mockReturnValueOnce(makeAssignmentSelectChain([
        makeAssignmentRow({ id: 'a1', status: 'approved' }),
        makeAssignmentRow({ id: 'a2', approverUserId: 'u2', status: 'pending' }),
      ]));

    const result = await isApprovalComplete('prd-1', 'prd', 'proj');

    expect(result).toEqual({ complete: false, mode: 'all_required' });
  });

  it('returns complete=true when no assignments exist (no threshold to meet)', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ approvalMode: 'any_one' }]))
      .mockReturnValueOnce(makeAssignmentSelectChain([]));

    const result = await isApprovalComplete('prd-1', 'prd', 'proj');

    expect(result).toEqual({ complete: true, mode: 'any_one' });
  });

  it('defaults to any_one when no project settings found', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([]))
      .mockReturnValueOnce(makeAssignmentSelectChain([
        makeAssignmentRow({ status: 'approved' }),
      ]));

    const result = await isApprovalComplete('prd-1', 'prd', 'proj');

    expect(result).toEqual({ complete: true, mode: 'any_one' });
  });
});

// ── isAssignedApprover ──────────────────────────────────────────────────────────

describe('isAssignedApprover', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns true when assignment row exists', async () => {
    mockDb.select.mockReturnValue(makeLimitSelectChain([{ id: 'assign-1' }]));

    const result = await isAssignedApprover('doc-1', 'prd', 'user-1');

    expect(result).toBe(true);
  });

  it('returns false when no row exists', async () => {
    mockDb.select.mockReturnValue(makeLimitSelectChain([]));

    const result = await isAssignedApprover('doc-1', 'prd', 'user-1');

    expect(result).toBe(false);
  });
});

// ── getAvailableApprovers ───────────────────────────────────────────────────────

describe('getAvailableApprovers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns approvers from projectSettingsService', async () => {
    mockGetApproversForDocument.mockResolvedValue([
      { userId: 'u1', displayName: 'Alice' },
      { userId: 'u2', displayName: 'Bob' },
    ]);

    const result = await getAvailableApprovers('proj', 'prd');

    expect(result).toHaveLength(2);
  });

  it('excludes the specified userId', async () => {
    mockGetApproversForDocument.mockResolvedValue([
      { userId: 'u1', displayName: 'Alice' },
      { userId: 'u2', displayName: 'Bob' },
    ]);

    const result = await getAvailableApprovers('proj', 'prd', 'u1');

    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe('u2');
  });
});

// ── propagateDesignDocApprovers ─────────────────────────────────────────────────

describe('propagateDesignDocApprovers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads designDocApproverIds from PRD row and creates assignments', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ designDocApproverIds: ['a1'] }]))
      .mockReturnValueOnce(makeLimitSelectChain([{ project: 'proj-alpha' }]))
      .mockReturnValueOnce(makeLimitSelectChain([{ title: 'Test Doc' }]))
      .mockReturnValueOnce(makeAssignmentSelectChain([]));

    mockGetApproversForDocument.mockResolvedValue([{ userId: 'a1', displayName: 'Alice' }]);

    const onConflictMock = jest.fn().mockResolvedValue(undefined);
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoNothing: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await propagateDesignDocApprovers('prd-1', 'dd-1', 'user-1');

    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });

  it('sends notifications to propagated design doc approvers', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ designDocApproverIds: ['a1', 'a2'] }]))
      .mockReturnValueOnce(makeLimitSelectChain([{ project: 'proj-alpha' }]))
      .mockReturnValueOnce(makeLimitSelectChain([{ title: 'Payment Module' }]))
      .mockReturnValueOnce(makeAssignmentSelectChain([]));

    mockGetApproversForDocument.mockResolvedValue([
      { userId: 'a1', displayName: 'Alice' },
      { userId: 'a2', displayName: 'Bob' },
    ]);

    const onConflictMock = jest.fn().mockResolvedValue(undefined);
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoNothing: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await propagateDesignDocApprovers('prd-1', 'dd-1', 'user-1');
    await new Promise((r) => setTimeout(r, 10));

    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    expect(mockCreateNotification).toHaveBeenCalledWith('a1', expect.objectContaining({
      type: 'user-action',
      title: 'You have been assigned as a design doc approver',
      body: 'Review requested for: Payment Module',
      link: '/backlog/design-doc/dd-1',
    }));
    expect(mockCreateNotification).toHaveBeenCalledWith('a2', expect.objectContaining({
      type: 'user-action',
      title: 'You have been assigned as a design doc approver',
      body: 'Review requested for: Payment Module',
      link: '/backlog/design-doc/dd-1',
    }));
  });

  it('does nothing when designDocApproverIds is null', async () => {
    mockDb.select.mockReturnValue(makeLimitSelectChain([{ designDocApproverIds: null }]));

    await propagateDesignDocApprovers('prd-1', 'dd-1', 'user-1');

    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('does nothing when designDocApproverIds is empty', async () => {
    mockDb.select.mockReturnValue(makeLimitSelectChain([{ designDocApproverIds: [] }]));

    await propagateDesignDocApprovers('prd-1', 'dd-1', 'user-1');

    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});

// ── reassignApprovers ─────────────────────────────────────────────────────────

describe('reassignApprovers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.select.mockReset();
  });

  it('does not send notifications when all approvers have already responded', async () => {
    // Call order in reassignApprovers:
    // 1. previousPending  → select → from → where
    // 2. getProjectForDocument → select → from → where → limit
    // 3. existingResponded → select → from → where
    // 4. getAssignments   → select → from → innerJoin → where
    mockDb.select
      .mockReturnValueOnce(makeWhereSelectChain([
        { approverUserId: 'responded-1' },
        { approverUserId: 'responded-2' },
      ]))
      .mockReturnValueOnce(makeLimitSelectChain([{ project: 'proj-alpha' }]))
      .mockReturnValueOnce(makeWhereSelectChain([
        { approverUserId: 'responded-1' },
        { approverUserId: 'responded-2' },
      ]))
      .mockReturnValueOnce(makeAssignmentSelectChain([
        makeAssignmentRow({ approverUserId: 'responded-1', status: 'approved' }),
        makeAssignmentRow({ id: 'a2', approverUserId: 'responded-2', status: 'approved' }),
      ]));

    mockGetApproversForDocument.mockResolvedValue([
      { userId: 'responded-1', displayName: 'Alice' },
      { userId: 'responded-2', displayName: 'Bob' },
    ]);

    await reassignApprovers('prd-1', 'prd', ['responded-1', 'responded-2'], 'admin-1');
    await new Promise((r) => setTimeout(r, 10));

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('sends a notification to each newly assigned approver on reassignment', async () => {
    // Call order (notifyAssignedApprovers is fire-and-forget but enters getDocumentTitle
    // synchronously, consuming db.select BEFORE getAssignments runs):
    // 1. previousPending  → select → from → where
    // 2. getProjectForDocument → select → from → where → limit
    // 3. existingResponded → select → from → where
    // 4. notifyAssignedApprovers → getDocumentTitle → select → from → where → limit
    // 5. getAssignments   → select → from → innerJoin → where
    mockDb.select
      .mockReturnValueOnce(makeWhereSelectChain([{ approverUserId: 'responded-1' }]))
      .mockReturnValueOnce(makeLimitSelectChain([{ project: 'proj-alpha' }]))
      .mockReturnValueOnce(makeWhereSelectChain([{ approverUserId: 'responded-1' }]))
      .mockReturnValueOnce(makeLimitSelectChain([{ title: 'My Design Doc' }]))
      .mockReturnValueOnce(makeAssignmentSelectChain([
        makeAssignmentRow({ approverUserId: 'new-1', documentType: 'design_doc' }),
      ]));

    mockGetApproversForDocument.mockResolvedValue([
      { userId: 'responded-1', displayName: 'Alice' },
      { userId: 'new-1', displayName: 'Bob' },
    ]);

    const onConflictMock = jest.fn().mockResolvedValue(undefined);
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoNothing: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await reassignApprovers('dd-1', 'design_doc', ['responded-1', 'new-1'], 'user-1');
    await new Promise((r) => setTimeout(r, 10));

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith('new-1', expect.objectContaining({
      type: 'user-action',
      title: 'You have been assigned as a design doc approver',
      body: 'Review requested for: My Design Doc',
      link: '/backlog/design-doc/dd-1',
    }));
  });
});

// ── notifyApproversDocumentReady ──────────────────────────────────────────────

describe('notifyApproversDocumentReady', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.select.mockReset();
  });

  it('sends a notification to each pending approver when document is ready', async () => {
    mockDb.select
      .mockReturnValueOnce(makeAssignmentSelectChain([
        makeAssignmentRow({ approverUserId: 'approver-1', status: 'pending' }),
        makeAssignmentRow({ id: 'a2', approverUserId: 'approver-2', status: 'pending' }),
      ]))
      .mockReturnValueOnce(makeLimitSelectChain([{ title: 'Auth Design Doc' }]));

    await notifyApproversDocumentReady('dd-1', 'design_doc');
    await new Promise((r) => setTimeout(r, 10));

    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    expect(mockCreateNotification).toHaveBeenCalledWith('approver-1', expect.objectContaining({
      type: 'user-action',
      title: 'A design doc is ready for your review',
      body: '"Auth Design Doc" is now pending review',
      link: '/backlog/design-doc/dd-1',
    }));
    expect(mockCreateNotification).toHaveBeenCalledWith('approver-2', expect.objectContaining({
      type: 'user-action',
      title: 'A design doc is ready for your review',
      body: '"Auth Design Doc" is now pending review',
      link: '/backlog/design-doc/dd-1',
    }));
  });

  it('sends correct notification for PRD document type', async () => {
    mockDb.select
      .mockReturnValueOnce(makeAssignmentSelectChain([
        makeAssignmentRow({ approverUserId: 'approver-1', status: 'pending', documentType: 'prd' }),
      ]))
      .mockReturnValueOnce(makeLimitSelectChain([{ title: 'Payment PRD' }]));

    await notifyApproversDocumentReady('prd-1', 'prd');
    await new Promise((r) => setTimeout(r, 10));

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith('approver-1', expect.objectContaining({
      type: 'user-action',
      title: 'A PRD is ready for your review',
      body: '"Payment PRD" is now pending review',
      link: '/backlog/prd/prd-1',
    }));
  });

  it('does not send notifications to approvers who already responded', async () => {
    mockDb.select
      .mockReturnValueOnce(makeAssignmentSelectChain([
        makeAssignmentRow({ approverUserId: 'approver-1', status: 'approved' }),
        makeAssignmentRow({ id: 'a2', approverUserId: 'approver-2', status: 'pending' }),
      ]))
      .mockReturnValueOnce(makeLimitSelectChain([{ title: 'Some Doc' }]));

    await notifyApproversDocumentReady('dd-1', 'design_doc');
    await new Promise((r) => setTimeout(r, 10));

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith('approver-2', expect.anything());
  });

  it('does nothing when there are no assignments', async () => {
    mockDb.select
      .mockReturnValueOnce(makeAssignmentSelectChain([]));

    await notifyApproversDocumentReady('dd-1', 'design_doc');
    await new Promise((r) => setTimeout(r, 10));

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});
