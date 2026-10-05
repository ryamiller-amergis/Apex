/**
 * Unit tests for documentApprovalService.
 * The Drizzle `db` instance and projectSettingsService are fully mocked.
 */

// ── DB mock ────────────────────────────────────────────────────────────────────

jest.mock('../db/drizzle', () => {
  const makeInsertChain = () => ({
    values: jest.fn().mockReturnThis(),
    onConflictDoNothing: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
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
    getApprovalModeForProject: jest.fn().mockResolvedValue('any_one'),
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
  getAvailableApproverPool,
  propagateDesignDocApprovers,
  reassignApprovers,
  notifyApproversDocumentReady,
} from '../services/documentApprovalService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };
const {
  getApproversForDocumentByProject: mockGetApproversForDocument,
  getApproverUserIdsForProject: mockGetApproverUserIdsForProject,
  getApproverPoolForProject: mockGetApproverPoolForProject,
  getApprovalModeForProject: mockGetApprovalModeForProject,
} = jest.requireMock('../services/projectSettingsService') as {
  getApproversForDocumentByProject: jest.Mock;
  getApproverUserIdsForProject: jest.Mock;
  getApproverPoolForProject: jest.Mock;
  getApprovalModeForProject: jest.Mock;
};

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

function makeAssignmentInsertChain(insertedUserIds: string[]) {
  const returningMock = jest.fn().mockResolvedValue(
    insertedUserIds.map((approverUserId) => ({ approverUserId })),
  );
  const onConflictMock = jest.fn().mockReturnValue({ returning: returningMock });
  const valuesMock = jest.fn().mockReturnValue({ onConflictDoNothing: onConflictMock });
  return {
    chain: { values: valuesMock },
    onConflictMock,
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

    const { chain } = makeAssignmentInsertChain(['approver-1']);
    mockDb.insert.mockReturnValue(chain);

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

    const { chain } = makeAssignmentInsertChain(['approver-1', 'approver-2']);
    mockDb.insert.mockReturnValue(chain);

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

    const { chain } = makeAssignmentInsertChain(['approver-1']);
    mockDb.insert.mockReturnValue(chain);

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

    const { chain } = makeAssignmentInsertChain(['approver-1']);
    mockDb.insert.mockReturnValue(chain);
    mockCreateNotification.mockRejectedValue(new Error('notification service down'));

    const result = await assignApprovers('prd-1', 'prd', ['approver-1'], 'user-1');

    expect(result).toHaveLength(1);
  });

  it('handles onConflictDoNothing gracefully', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ project: 'proj-alpha' }]))
      .mockReturnValueOnce(makeAssignmentSelectChain([]));

    mockGetApproversForDocument.mockResolvedValue([
      { userId: 'approver-1', displayName: 'Alice' },
    ]);

    const { chain, onConflictMock } = makeAssignmentInsertChain([]);
    mockDb.insert.mockReturnValue(chain);

    await assignApprovers('prd-1', 'prd', ['approver-1'], 'user-1');
    await new Promise((r) => setTimeout(r, 10));

    expect(onConflictMock).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).not.toHaveBeenCalled();
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
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.select.mockReset();
    mockGetApprovalModeForProject.mockResolvedValue('any_one');
  });

  it('TBI-001 DoD-1 resolves the mode through the per-module accessor for the document type', async () => {
    mockGetApprovalModeForProject.mockResolvedValue('all_required');
    mockDb.select.mockReturnValueOnce(makeAssignmentSelectChain([
      makeAssignmentRow({ id: 'a1', documentType: 'design_doc', status: 'approved' }),
      makeAssignmentRow({ id: 'a2', documentType: 'design_doc', approverUserId: 'u2', status: 'pending' }),
    ]));

    const result = await isApprovalComplete('dd-1', 'design_doc', 'proj');

    expect(mockGetApprovalModeForProject).toHaveBeenCalledWith('proj', 'design_doc');
    expect(result).toEqual({ complete: false, mode: 'all_required' });
  });

  it('PBI-002 AC-0 / VT-05 a design_doc set to any_one does not relax an all_required prd', async () => {
    const modesByModule: Record<string, string> = {
      prd: 'all_required',
      design_doc: 'any_one',
    };
    mockGetApprovalModeForProject.mockImplementation(
      async (_project: string, documentType: string) => modesByModule[documentType],
    );

    mockDb.select.mockReturnValueOnce(makeAssignmentSelectChain([
      makeAssignmentRow({ id: 'a1', status: 'approved' }),
      makeAssignmentRow({ id: 'a2', approverUserId: 'u2', status: 'pending' }),
    ]));
    const prdResult = await isApprovalComplete('prd-1', 'prd', 'proj');

    mockDb.select.mockReturnValueOnce(makeAssignmentSelectChain([
      makeAssignmentRow({ id: 'b1', documentType: 'design_doc', status: 'approved' }),
      makeAssignmentRow({ id: 'b2', documentType: 'design_doc', approverUserId: 'u2', status: 'pending' }),
    ]));
    const designDocResult = await isApprovalComplete('dd-1', 'design_doc', 'proj');

    expect(prdResult).toEqual({ complete: false, mode: 'all_required' });
    expect(designDocResult).toEqual({ complete: true, mode: 'any_one' });
  });

  it('returns complete=true for any_one mode when at least one approved', async () => {
    mockGetApprovalModeForProject.mockResolvedValue('any_one');
    mockDb.select.mockReturnValueOnce(makeAssignmentSelectChain([
      makeAssignmentRow({ id: 'a1', status: 'approved' }),
      makeAssignmentRow({ id: 'a2', approverUserId: 'u2', status: 'pending' }),
    ]));

    const result = await isApprovalComplete('prd-1', 'prd', 'proj');

    expect(result).toEqual({ complete: true, mode: 'any_one' });
  });

  it('returns complete=false for any_one mode when none approved', async () => {
    mockGetApprovalModeForProject.mockResolvedValue('any_one');
    mockDb.select.mockReturnValueOnce(makeAssignmentSelectChain([
      makeAssignmentRow({ status: 'pending' }),
    ]));

    const result = await isApprovalComplete('prd-1', 'prd', 'proj');

    expect(result).toEqual({ complete: false, mode: 'any_one' });
  });

  it('returns complete=true for all_required when all approved', async () => {
    mockGetApprovalModeForProject.mockResolvedValue('all_required');
    mockDb.select.mockReturnValueOnce(makeAssignmentSelectChain([
      makeAssignmentRow({ id: 'a1', status: 'approved' }),
      makeAssignmentRow({ id: 'a2', approverUserId: 'u2', status: 'approved' }),
    ]));

    const result = await isApprovalComplete('prd-1', 'prd', 'proj');

    expect(result).toEqual({ complete: true, mode: 'all_required' });
  });

  it('returns complete=false for all_required when some pending', async () => {
    mockGetApprovalModeForProject.mockResolvedValue('all_required');
    mockDb.select.mockReturnValueOnce(makeAssignmentSelectChain([
      makeAssignmentRow({ id: 'a1', status: 'approved' }),
      makeAssignmentRow({ id: 'a2', approverUserId: 'u2', status: 'pending' }),
    ]));

    const result = await isApprovalComplete('prd-1', 'prd', 'proj');

    expect(result).toEqual({ complete: false, mode: 'all_required' });
  });

  it('returns complete=true when no assignments exist (no threshold to meet)', async () => {
    mockGetApprovalModeForProject.mockResolvedValue('any_one');
    mockDb.select.mockReturnValueOnce(makeAssignmentSelectChain([]));

    const result = await isApprovalComplete('prd-1', 'prd', 'proj');

    expect(result).toEqual({ complete: true, mode: 'any_one', reason: 'owner-only' });
  });

  it('VT-13 / PBI-006 AC-0 a design_doc with zero assignments completes the reviewer phase as owner-only with the per-module mode still reported', async () => {
    mockGetApprovalModeForProject.mockResolvedValue('all_required');
    mockDb.select.mockReturnValueOnce(makeAssignmentSelectChain([]));

    const result = await isApprovalComplete('dd-1', 'design_doc', 'proj');

    expect(mockGetApprovalModeForProject).toHaveBeenCalledWith('proj', 'design_doc');
    expect(result).toEqual({ complete: true, mode: 'all_required', reason: 'owner-only' });
  });

  it('VT-13 does not mark an any_one or all_required result with the owner-only reason when assignments exist', async () => {
    mockGetApprovalModeForProject.mockResolvedValue('any_one');
    mockDb.select.mockReturnValueOnce(makeAssignmentSelectChain([
      makeAssignmentRow({ documentType: 'design_doc', status: 'approved' }),
    ]));

    const anyOneResult = await isApprovalComplete('dd-1', 'design_doc', 'proj');

    mockGetApprovalModeForProject.mockResolvedValue('all_required');
    mockDb.select.mockReturnValueOnce(makeAssignmentSelectChain([
      makeAssignmentRow({ id: 'a1', documentType: 'design_doc', status: 'approved' }),
      makeAssignmentRow({ id: 'a2', documentType: 'design_doc', approverUserId: 'u2', status: 'approved' }),
    ]));

    const allRequiredResult = await isApprovalComplete('dd-1', 'design_doc', 'proj');

    expect(anyOneResult).toEqual({ complete: true, mode: 'any_one' });
    expect(allRequiredResult).toEqual({ complete: true, mode: 'all_required' });
  });

  it('defaults to any_one when the accessor finds no stored mode', async () => {
    mockGetApprovalModeForProject.mockResolvedValue('any_one');
    mockDb.select.mockReturnValueOnce(makeAssignmentSelectChain([
      makeAssignmentRow({ status: 'approved' }),
    ]));

    const result = await isApprovalComplete('prd-1', 'prd', 'proj');

    expect(result).toEqual({ complete: true, mode: 'any_one' });
  });

  it('TBI-001 DoD-0 resolves the adr module mode through the same accessor', async () => {
    mockGetApprovalModeForProject.mockResolvedValue('all_required');
    mockDb.select.mockReturnValueOnce(makeAssignmentSelectChain([
      makeAssignmentRow({ id: 'a1', documentId: 'adr-1', documentType: 'adr', status: 'approved' }),
      makeAssignmentRow({ id: 'a2', documentId: 'adr-1', documentType: 'adr', approverUserId: 'u2', status: 'approved' }),
    ]));

    const result = await isApprovalComplete('adr-1', 'adr', 'proj');

    expect(mockGetApprovalModeForProject).toHaveBeenCalledWith('proj', 'adr');
    expect(result).toEqual({ complete: true, mode: 'all_required' });
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

  it('VT-15 resolves ADR and non-ADR candidates through the unchanged module-specific accessor', async () => {
    mockGetApproversForDocument
      .mockResolvedValueOnce([{ userId: 'adr-u1', displayName: 'ADR Reviewer' }])
      .mockResolvedValueOnce([{ userId: 'prd-u1', displayName: 'PRD Reviewer' }]);

    await expect(getAvailableApprovers('proj', 'adr')).resolves.toEqual([
      expect.objectContaining({ userId: 'adr-u1' }),
    ]);
    await expect(getAvailableApprovers('proj', 'prd')).resolves.toEqual([
      expect.objectContaining({ userId: 'prd-u1' }),
    ]);
    expect(mockGetApproversForDocument.mock.calls).toEqual([
      ['proj', 'adr'],
      ['proj', 'prd'],
    ]);
  });

  it('TBI-002 DoD-1 returns the configured ADR pool with owner excluded from each source', async () => {
    mockGetApproverPoolForProject.mockResolvedValue({
      individuals: [
        { userId: 'owner-1', displayName: 'Owner' },
        { userId: 'u1', displayName: 'Individual' },
      ],
      groups: [{
        groupId: 'g1',
        groupName: 'Architects',
        members: [
          { userId: 'owner-1', displayName: 'Owner' },
          { userId: 'u2', displayName: 'Group Member' },
        ],
      }],
    });

    await expect(getAvailableApproverPool('proj', 'adr', 'owner-1')).resolves.toEqual({
      individuals: [expect.objectContaining({ userId: 'u1' })],
      groups: [expect.objectContaining({
        members: [expect.objectContaining({ userId: 'u2' })],
      })],
    });
    expect(mockGetApproverPoolForProject).toHaveBeenCalledWith('proj', 'adr');
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

    const { chain } = makeAssignmentInsertChain(['a1']);
    mockDb.insert.mockReturnValue(chain);

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

    const { chain } = makeAssignmentInsertChain(['a1', 'a2']);
    mockDb.insert.mockReturnValue(chain);

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

  it('does nothing when designDocApproverIds is null and there is no interview fallback', async () => {
    mockDb.select.mockReturnValue(makeLimitSelectChain([{ designDocApproverIds: null, interviewId: null }]));

    await propagateDesignDocApprovers('prd-1', 'dd-1', 'user-1');

    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('does nothing when designDocApproverIds is empty and there is no interview fallback', async () => {
    mockDb.select.mockReturnValue(makeLimitSelectChain([{ designDocApproverIds: [], interviewId: null }]));

    await propagateDesignDocApprovers('prd-1', 'dd-1', 'user-1');

    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('falls back to interview designDocApproverIds when the PRD row has none', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ designDocApproverIds: null, interviewId: 'interview-1' }]))
      .mockReturnValueOnce(makeLimitSelectChain([{ designDocApproverIds: ['a1'] }]))
      .mockReturnValueOnce(makeLimitSelectChain([{ project: 'proj-alpha' }]))
      .mockReturnValueOnce(makeLimitSelectChain([{ title: 'Test Doc' }]))
      .mockReturnValueOnce(makeAssignmentSelectChain([]));

    mockGetApproversForDocument.mockResolvedValue([{ userId: 'a1', displayName: 'Alice' }]);

    const { chain } = makeAssignmentInsertChain(['a1']);
    mockDb.insert.mockReturnValue(chain);

    await propagateDesignDocApprovers('prd-1', 'dd-1', 'user-1');

    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });

  it('does nothing when both PRD and interview designDocApproverIds are empty', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLimitSelectChain([{ designDocApproverIds: [], interviewId: 'interview-1' }]))
      .mockReturnValueOnce(makeLimitSelectChain([{ designDocApproverIds: [] }]));

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

  it('TBI-002 DoD-2 assigns and notifies a newly configured ADR pool reviewer', async () => {
    mockDb.select
      .mockReturnValueOnce(makeWhereSelectChain([]))
      .mockReturnValueOnce(makeLimitSelectChain([{ project: 'Apex' }]))
      .mockReturnValueOnce(makeWhereSelectChain([]))
      .mockReturnValueOnce(makeLimitSelectChain([{ title: 'Choose event transport' }]))
      .mockReturnValueOnce(makeAssignmentSelectChain([
        makeAssignmentRow({
          documentId: 'adr-1',
          documentType: 'adr',
          approverUserId: 'dev-1',
        }),
      ]));
    mockGetApproversForDocument.mockResolvedValue([
      { userId: 'dev-1', displayName: 'Configured Reviewer' },
    ]);
    const onConflictMock = jest.fn().mockResolvedValue(undefined);
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoNothing: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await reassignApprovers('adr-1', 'adr', ['dev-1'], 'owner-1');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockCreateNotification).toHaveBeenCalledWith('dev-1', expect.objectContaining({
      type: 'user-action',
      title: 'You have been assigned as an ADR reviewer',
      body: 'Review requested for: Choose event transport',
      link: '/adr/adr-1',
    }));
    expect(mockGetApproverUserIdsForProject).toHaveBeenCalledWith('Apex', 'adr');
  });
});

// ── notifyApproversDocumentReady ──────────────────────────────────────────────

describe('notifyApproversDocumentReady', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.select.mockReset();
  });

  it('TBI-006 DoD-2 keeps later-lifecycle ready-to-approve notifications on type user-action', async () => {
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
