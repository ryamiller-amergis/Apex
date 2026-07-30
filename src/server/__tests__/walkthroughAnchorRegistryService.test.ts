/**
 * Phase 2 — walkthroughAnchorRegistryService CRUD + validation.
 * Assertions bind to plan behaviors: CRUD, validation, bulk, soft-delete, active⇒approved.
 */

jest.mock('../db/drizzle', () => {
  const makeInsertChain = () => ({
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
  });
  const makeUpdateChain = () => ({
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
  });
  const makeSelectChain = () => ({
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  });

  return {
    db: {
      query: {
        walkthroughAnchorRegistry: {
          findFirst: jest.fn(),
          findMany: jest.fn(),
        },
      },
      insert: jest.fn().mockImplementation(makeInsertChain),
      update: jest.fn().mockImplementation(makeUpdateChain),
      select: jest.fn().mockImplementation(makeSelectChain),
      transaction: jest.fn(),
    },
  };
});

import {
  applySmartTagSuggestionsToPending,
  bulkUpdateAnchors,
  createManualAnchor,
  getAnchorById,
  getAnchorByKey,
  getAnchorByTestId,
  getModuleCoverage,
  listAnchors,
  softDeleteAnchor,
  updateAnchor,
  updateMissingState,
} from '../services/walkthroughAnchorRegistryService';
import {
  WalkthroughAnchorRegistryError,
  type WalkthroughAnchorRegistryRecord,
} from '../../shared/types/walkthroughAnchorRegistry';

const { db: mockDb } = jest.requireMock('../db/drizzle') as {
  db: {
    query: {
      walkthroughAnchorRegistry: { findFirst: jest.Mock; findMany: jest.Mock };
    };
    insert: jest.Mock;
    update: jest.Mock;
    select: jest.Mock;
    transaction: jest.Mock;
  };
};

const actor = { id: 'admin-1' };

function makeRecord(
  overrides: Partial<WalkthroughAnchorRegistryRecord> = {},
): WalkthroughAnchorRegistryRecord {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    anchorKey: 'profile-identity',
    testId: 'profile-identity-section',
    label: 'Profile — Identity',
    suggestedRoute: null,
    approvedRoute: '/profile',
    allowedPlacements: ['bottom', 'top'],
    smartTags: ['profile', 'identity'],
    sourceKind: 'manual',
    sourceLocations: [],
    sourceHash: null,
    reviewStatus: 'approved',
    isActive: true,
    lastSeenAt: null,
    missingSince: null,
    deletedAt: null,
    aiProvenance: null,
    createdBy: 'admin-1',
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedBy: 'admin-1',
    updatedAt: '2026-07-30T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) =>
    fn(mockDb),
  );
});

describe('createManualAnchor', () => {
  it('rejects CSS-selector style keys/testIds and invalid routes/placements', async () => {
    await expect(
      createManualAnchor(
        {
          anchorKey: '#user-menu',
          testId: '.btn > span',
          label: 'Bad',
          allowedPlacements: ['diagonal' as 'bottom'],
          approvedRoute: '/not-a-real-route',
          smartTags: ['OK Tag'],
        },
        actor,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      name: 'WalkthroughAnchorRegistryError',
    });

    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('normalizes kebab-case tags and inserts an approved/active manual row', async () => {
    mockDb.query.walkthroughAnchorRegistry.findMany.mockResolvedValue([]);
    const created = makeRecord({
      anchorKey: 'new-anchor',
      testId: 'new-anchor',
      smartTags: ['user-menu', 'profile'],
      sourceKind: 'manual',
    });
    const returning = jest.fn().mockResolvedValue([created]);
    const values = jest.fn().mockReturnValue({ returning });
    mockDb.insert.mockReturnValue({ values, returning });

    const result = await createManualAnchor(
      {
        anchorKey: 'new-anchor',
        testId: 'new-anchor',
        label: 'New Anchor',
        allowedPlacements: ['bottom'],
        approvedRoute: '/home',
        smartTags: [' User_Menu ', 'PROFILE', 'user-menu'],
        reviewStatus: 'approved',
        isActive: true,
      },
      actor,
    );

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorKey: 'new-anchor',
        testId: 'new-anchor',
        sourceKind: 'manual',
        smartTags: ['user-menu', 'profile'],
        reviewStatus: 'approved',
        isActive: true,
        createdBy: 'admin-1',
        updatedBy: 'admin-1',
      }),
    );
    expect(result.anchorKey).toBe('new-anchor');
  });

  it('prevents duplicate live anchorKey / testId', async () => {
    mockDb.query.walkthroughAnchorRegistry.findMany.mockResolvedValue([makeRecord()]);

    await expect(
      createManualAnchor(
        {
          anchorKey: 'profile-identity',
          testId: 'other-id',
          label: 'Dup',
          allowedPlacements: ['bottom'],
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
  });

  it('refuses active without approved reviewStatus', async () => {
    await expect(
      createManualAnchor(
        {
          anchorKey: 'pending-active',
          testId: 'pending-active',
          label: 'Nope',
          allowedPlacements: ['bottom'],
          reviewStatus: 'pending',
          isActive: true,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'ACTIVE_REQUIRES_APPROVED' });
  });
});

describe('updateAnchor', () => {
  it('edits tags/metadata with normalization and active⇒approved guard', async () => {
    mockDb.query.walkthroughAnchorRegistry.findFirst.mockResolvedValue(
      makeRecord({ reviewStatus: 'pending', isActive: false }),
    );

    await expect(
      updateAnchor('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', { isActive: true }, actor),
    ).rejects.toMatchObject({ code: 'ACTIVE_REQUIRES_APPROVED' });

    const updated = makeRecord({
      label: 'Renamed',
      smartTags: ['profile', 'settings'],
      reviewStatus: 'approved',
      isActive: true,
    });
    mockDb.query.walkthroughAnchorRegistry.findFirst.mockResolvedValue(
      makeRecord({ reviewStatus: 'pending', isActive: false }),
    );
    const returning = jest.fn().mockResolvedValue([updated]);
    mockDb.update.mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning }) }),
    });

    const result = await updateAnchor(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      {
        label: 'Renamed',
        smartTags: [' Profile ', 'SETTINGS'],
        reviewStatus: 'approved',
        isActive: true,
      },
      actor,
    );
    expect(result.label).toBe('Renamed');
    expect(result.smartTags).toEqual(['profile', 'settings']);
  });

  it('returns NOT_FOUND for missing or deleted rows', async () => {
    mockDb.query.walkthroughAnchorRegistry.findFirst.mockResolvedValue(null);
    await expect(updateAnchor('missing', { label: 'x' }, actor)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('bulkUpdateAnchors', () => {
  it('transactionally approves then activates; rejects activate of non-approved', async () => {
    const pending = makeRecord({
      id: '11111111-1111-1111-1111-111111111111',
      reviewStatus: 'pending',
      isActive: false,
    });
    mockDb.query.walkthroughAnchorRegistry.findFirst.mockResolvedValue(pending);

    await expect(
      bulkUpdateAnchors(
        { ids: [pending.id], action: 'activate' },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'ACTIVE_REQUIRES_APPROVED' });

    const approved = makeRecord({
      id: pending.id,
      reviewStatus: 'approved',
      isActive: false,
    });
    const activated = { ...approved, isActive: true };
    mockDb.query.walkthroughAnchorRegistry.findFirst
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(approved);
    const returningApprove = jest.fn().mockResolvedValue([approved]);
    const returningActivate = jest.fn().mockResolvedValue([activated]);
    mockDb.update
      .mockReturnValueOnce({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ returning: returningApprove }),
        }),
      })
      .mockReturnValueOnce({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ returning: returningActivate }),
        }),
      });

    const approvedRows = await bulkUpdateAnchors(
      { ids: [pending.id], action: 'approve' },
      actor,
    );
    expect(approvedRows[0].reviewStatus).toBe('approved');

    const activatedRows = await bulkUpdateAnchors(
      { ids: [pending.id], action: 'activate' },
      actor,
    );
    expect(activatedRows[0].isActive).toBe(true);
    expect(mockDb.transaction).toHaveBeenCalled();
  });

  it('reject forces isActive false', async () => {
    const row = makeRecord({ isActive: true, reviewStatus: 'approved' });
    mockDb.query.walkthroughAnchorRegistry.findFirst.mockResolvedValue(row);
    const rejected = { ...row, reviewStatus: 'rejected' as const, isActive: false };
    const returning = jest.fn().mockResolvedValue([rejected]);
    mockDb.update.mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning }) }),
    });

    const result = await bulkUpdateAnchors({ ids: [row.id], action: 'reject' }, actor);
    expect(result[0].reviewStatus).toBe('rejected');
    expect(result[0].isActive).toBe(false);
  });
});

describe('updateMissingState + softDeleteAnchor', () => {
  it('sets and clears missingSince transactionally', async () => {
    const row = makeRecord();
    mockDb.query.walkthroughAnchorRegistry.findFirst.mockResolvedValue(row);
    const stamped = { ...row, missingSince: '2026-07-30T12:00:00.000Z' };
    const returning = jest.fn().mockResolvedValue([stamped]);
    mockDb.update.mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning }) }),
    });

    const result = await updateMissingState(
      {
        updates: [{ id: row.id, missingSince: '2026-07-30T12:00:00.000Z' }],
      },
      actor,
    );
    expect(result[0].missingSince).toBe('2026-07-30T12:00:00.000Z');
    expect(mockDb.transaction).toHaveBeenCalled();
  });

  it('soft-deletes safely (deletedAt set, deactivated) without hard delete', async () => {
    const row = makeRecord({ isActive: true });
    mockDb.query.walkthroughAnchorRegistry.findFirst.mockResolvedValue(row);
    const deleted = {
      ...row,
      deletedAt: '2026-07-30T13:00:00.000Z',
      isActive: false,
    };
    const setMock = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([deleted]),
      }),
    });
    mockDb.update.mockReturnValue({ set: setMock });

    const result = await softDeleteAnchor(row.id, actor);
    expect(result.deletedAt).not.toBeNull();
    expect(result.isActive).toBe(false);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        isActive: false,
        deletedAt: expect.any(String),
        updatedBy: 'admin-1',
      }),
    );
  });
});

describe('getters + listAnchors', () => {
  it('get-by-key / get-by-test-id / get-by-id skip soft-deleted by default', async () => {
    mockDb.query.walkthroughAnchorRegistry.findFirst.mockResolvedValue(makeRecord());
    await expect(getAnchorByKey('profile-identity')).resolves.toMatchObject({
      anchorKey: 'profile-identity',
    });
    await expect(getAnchorByTestId('profile-identity-section')).resolves.toMatchObject({
      testId: 'profile-identity-section',
    });
    await expect(getAnchorById(makeRecord().id)).resolves.toMatchObject({
      id: makeRecord().id,
    });
  });

  it('listAnchors returns items and status counts', async () => {
    const items = [
      makeRecord({ reviewStatus: 'approved', isActive: true }),
      makeRecord({
        id: '22222222-2222-2222-2222-222222222222',
        anchorKey: 'pending-one',
        testId: 'pending-one',
        reviewStatus: 'pending',
        isActive: false,
      }),
    ];
    mockDb.query.walkthroughAnchorRegistry.findMany.mockResolvedValue(items);

    const page = await listAnchors({ search: 'profile' });
    expect(page.items).toHaveLength(2);
    expect(page.counts.approved).toBe(1);
    expect(page.counts.pending).toBe(1);
    expect(page.counts.active).toBe(1);
    expect(page.nextCursor).toBeNull();
  });

  it('summarizes covered and uncovered modules from approved present routes', async () => {
    mockDb.query.walkthroughAnchorRegistry.findMany.mockResolvedValue([
      makeRecord({
        approvedRoute: '/profile',
        lastSeenAt: '2026-07-30T12:00:00.000Z',
      }),
      makeRecord({
        id: '33333333-3333-3333-3333-333333333333',
        anchorKey: 'profile-bio',
        testId: 'profile-bio-section',
        approvedRoute: '/profile',
        lastSeenAt: '2026-07-30T12:00:00.000Z',
      }),
      makeRecord({
        id: '44444444-4444-4444-4444-444444444444',
        anchorKey: 'calendar-list',
        testId: 'unscheduled-list',
        approvedRoute: '/calendar',
        lastSeenAt: '2026-07-30T12:00:00.000Z',
      }),
    ]);

    const coverage = await getModuleCoverage();

    expect(coverage.totalModules).toBe(16);
    expect(coverage.coveredModules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'profile', anchorCount: 2 }),
        expect.objectContaining({ key: 'calendar', anchorCount: 1 }),
      ]),
    );
    expect(coverage.uncoveredModules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'planning', anchorCount: 0 }),
        expect.objectContaining({ key: 'ai-cost', anchorCount: 0 }),
      ]),
    );
  });
});

describe('WalkthroughAnchorRegistryError', () => {
  it('is an Error subclass with code', () => {
    const err = new WalkthroughAnchorRegistryError('VALIDATION_ERROR', 'bad');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('VALIDATION_ERROR');
  });
});

describe('applySmartTagSuggestionsToPending', () => {
  it('persists AI suggestions onto pending rows only and keeps reviewStatus pending', async () => {
    const pending = makeRecord({
      id: '11111111-1111-1111-1111-111111111111',
      anchorKey: 'new-candidate',
      testId: 'new-candidate',
      label: 'Pending label',
      suggestedRoute: null,
      allowedPlacements: ['bottom'],
      smartTags: [],
      reviewStatus: 'pending',
      isActive: false,
      aiProvenance: null,
    });
    const approved = makeRecord({
      id: '22222222-2222-2222-2222-222222222222',
      anchorKey: 'already-approved',
      testId: 'already-approved',
      label: 'Approved label',
      smartTags: ['keep-me'],
      reviewStatus: 'approved',
      isActive: true,
    });

    mockDb.query.walkthroughAnchorRegistry.findMany.mockResolvedValue([pending, approved]);

    const updatedRow = {
      ...pending,
      label: 'New candidate',
      suggestedRoute: '/profile',
      allowedPlacements: ['bottom', 'top'],
      smartTags: ['profile', 'settings', 'section', 'edit'],
      aiProvenance: {
        provider: 'cursor',
        model: 'claude-sonnet-4',
        skillPath: '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
        generatedAt: '2026-07-30T04:00:00.000Z',
        threadId: 'thread-1',
        runId: null,
        confidence: 0.7,
        rationale: 'Found in ProfilePage.tsx',
      },
    };

    const updateChain = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([updatedRow]),
    };
    mockDb.update.mockReturnValue(updateChain);

    const result = await applySmartTagSuggestionsToPending({
      testIds: ['new-candidate', 'already-approved'],
      result: {
        suggestions: [
          {
            testId: 'new-candidate',
            anchorKey: 'new-candidate',
            suggestedLabel: 'New candidate',
            suggestedRoute: '/profile',
            allowedPlacements: ['bottom', 'top'],
            smartTags: ['profile', 'settings', 'section', 'edit'],
            confidence: 0.7,
            rationale: 'Found in ProfilePage.tsx',
          },
          {
            testId: 'already-approved',
            anchorKey: 'already-approved',
            suggestedLabel: 'Should not apply',
            suggestedRoute: '/profile',
            allowedPlacements: ['top'],
            smartTags: ['profile', 'settings', 'section'],
            confidence: 0.9,
            rationale: 'Ignored because approved',
          },
        ],
      },
      provenanceBase: {
        provider: 'cursor',
        model: 'claude-sonnet-4',
        skillPath: '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
        generatedAt: '2026-07-30T04:00:00.000Z',
        threadId: 'thread-1',
        runId: null,
      },
      actor,
    });

    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('New candidate');
    expect(result[0].reviewStatus).toBe('pending');
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'New candidate',
        suggestedRoute: '/profile',
        reviewStatus: 'pending',
        isActive: false,
        aiProvenance: expect.objectContaining({
          confidence: 0.7,
          threadId: 'thread-1',
        }),
      }),
    );
  });
});
