/**
 * Wave 2 Track A — scanner persistence (extract → persist, before AI tagging).
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
      transaction: jest.fn(),
    },
  };
});

jest.mock('../services/walkthroughAnchorSyncExtraction', () => {
  const actual = jest.requireActual(
    '../services/walkthroughAnchorSyncExtraction'
  );
  return {
    ...actual,
    syncExtractWalkthroughAnchors: jest.fn(),
  };
});

jest.mock('../services/walkthroughAnchorSyncRepoService', () => ({
  resolveWalkthroughAnchorSyncProvider: jest.fn(
    async (explicit?: 'local' | 'github' | 'ado' | null) => explicit ?? 'local'
  ),
  materializeApexWalkthroughAnchorSyncCheckout: jest.fn(),
}));

jest.mock('../services/walkthroughPageModuleScope', () => ({
  listApplicableWalkthroughPageModules: jest.fn().mockResolvedValue([
    {
      key: 'home',
      label: 'Home',
      availability: 'fixed',
      pageEntries: [
        {
          component: 'src/client/components/AgentHome.tsx',
          routePattern: '/home',
          suggestedRoute: '/home',
        },
      ],
    },
  ]),
  listWalkthroughPageEntryComponents: jest.fn(() => [
    'src/client/components/AgentHome.tsx',
  ]),
}));

import {
  createFromCandidate,
  listCatalogSnapshotForSync,
  persistSyncExtractionResult,
  refreshFromSyncDiscovery,
  syncExtractAndPersistAnchors,
} from '../services/walkthroughAnchorRegistryService';
import { syncExtractWalkthroughAnchors } from '../services/walkthroughAnchorSyncExtraction';
import {
  materializeApexWalkthroughAnchorSyncCheckout,
  resolveWalkthroughAnchorSyncProvider,
} from '../services/walkthroughAnchorSyncRepoService';
import type {
  WalkthroughAnchorDiscovery,
  WalkthroughAnchorSyncExtractionResult,
} from '../services/walkthroughAnchorSyncExtraction';
import type { WalkthroughAnchorRegistryRecord } from '../../shared/types/walkthroughAnchorRegistry';

const { db: mockDb } = jest.requireMock('../db/drizzle') as {
  db: {
    query: {
      walkthroughAnchorRegistry: { findFirst: jest.Mock; findMany: jest.Mock };
    };
    insert: jest.Mock;
    update: jest.Mock;
    transaction: jest.Mock;
  };
};

const mockSyncExtract = syncExtractWalkthroughAnchors as jest.MockedFunction<
  typeof syncExtractWalkthroughAnchors
>;
const mockResolveProvider =
  resolveWalkthroughAnchorSyncProvider as jest.MockedFunction<
    typeof resolveWalkthroughAnchorSyncProvider
  >;
const mockMaterialize =
  materializeApexWalkthroughAnchorSyncCheckout as jest.MockedFunction<
    typeof materializeApexWalkthroughAnchorSyncCheckout
  >;

const actor = { id: 'admin-sync' };

function makeRecord(
  overrides: Partial<WalkthroughAnchorRegistryRecord> = {}
): WalkthroughAnchorRegistryRecord {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    anchorKey: 'profile-identity',
    testId: 'profile-identity-section',
    label: 'Profile — Identity',
    suggestedRoute: null,
    approvedRoute: '/profile',
    allowedPlacements: ['bottom', 'top'],
    smartTags: ['profile'],
    openerAnchorKeys: [],
    sourceKind: 'explicit',
    sourceLocations: [
      { filePath: 'src/client/components/ProfilePage.tsx', line: 10 },
    ],
    sourceHash: 'old-hash',
    reviewStatus: 'approved',
    isActive: true,
    lastSeenAt: '2026-07-28T00:00:00.000Z',
    missingSince: null,
    deletedAt: null,
    aiProvenance: null,
    createdBy: 'system',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedBy: 'system',
    updatedAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

function makeDiscovery(
  overrides: Partial<WalkthroughAnchorDiscovery> = {}
): WalkthroughAnchorDiscovery {
  return {
    testId: 'save-draft-button',
    suggestedAnchorKey: null,
    sourceKind: 'data_testid',
    sourceLocations: [
      {
        filePath: 'src/client/components/StaticIds.tsx',
        line: 12,
        discoveryKind: 'data_testid',
      },
    ],
    sourceHash: 'abc123hash',
    proposedReviewStatus: 'pending',
    proposedIsActive: false,
    ...overrides,
  };
}

function emptyExtraction(
  overrides: Partial<WalkthroughAnchorSyncExtractionResult> = {}
): WalkthroughAnchorSyncExtractionResult {
  return {
    discoveries: [],
    newCandidates: [],
    existingMatches: [],
    missingWarnings: [],
    duplicates: [],
    unsupportedDynamicPatterns: [],
    diagnostics: {
      provider: 'local',
      rootPath: '/repo',
      filesScanned: 0,
      filesSkipped: 0,
      bytesRead: 0,
      durationMs: 1,
      truncatedFiles: [],
      errors: [],
      branch: null,
      committedTruth: false,
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.transaction.mockImplementation(
    async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb)
  );
});

describe('createFromCandidate', () => {
  it('inserts pending/inactive rows with sourceLocations/sourceHash/sourceKind', async () => {
    mockDb.query.walkthroughAnchorRegistry.findMany.mockResolvedValue([]);
    const created = makeRecord({
      id: '11111111-1111-1111-1111-111111111111',
      anchorKey: 'save-draft-button',
      testId: 'save-draft-button',
      label: 'Save Draft Button',
      sourceKind: 'data_testid',
      sourceHash: 'abc123hash',
      reviewStatus: 'pending',
      isActive: false,
      lastSeenAt: '2026-07-30T12:00:00.000Z',
    });
    const returning = jest.fn().mockResolvedValue([created]);
    const values = jest.fn().mockReturnValue({ returning });
    mockDb.insert.mockReturnValue({ values, returning });

    const discovery = makeDiscovery();
    const result = await createFromCandidate(
      {
        testId: discovery.testId,
        suggestedAnchorKey: discovery.suggestedAnchorKey,
        sourceKind: discovery.sourceKind,
        sourceLocations: discovery.sourceLocations,
        sourceHash: discovery.sourceHash,
      },
      actor
    );

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorKey: 'save-draft-button',
        testId: 'save-draft-button',
        sourceKind: 'data_testid',
        sourceHash: 'abc123hash',
        sourceLocations: discovery.sourceLocations,
        reviewStatus: 'pending',
        isActive: false,
        createdBy: 'admin-sync',
        updatedBy: 'admin-sync',
      })
    );
    const inserted = values.mock.calls[0][0];
    expect(inserted.smartTags).toEqual([]);
    expect(inserted.aiProvenance).toBeNull();
    expect(inserted.label).toBeTruthy();
    expect(inserted.allowedPlacements).toEqual([
      'top',
      'right',
      'bottom',
      'left',
    ]);
    expect(result.reviewStatus).toBe('pending');
    expect(result.isActive).toBe(false);
  });

  it('uses suggestedAnchorKey when provided', async () => {
    mockDb.query.walkthroughAnchorRegistry.findMany.mockResolvedValue([]);
    const created = makeRecord({
      anchorKey: 'user-menu-trigger',
      testId: 'user-menu-trigger',
      sourceKind: 'explicit',
      reviewStatus: 'pending',
      isActive: false,
    });
    const returning = jest.fn().mockResolvedValue([created]);
    const values = jest.fn().mockReturnValue({ returning });
    mockDb.insert.mockReturnValue({ values, returning });

    await createFromCandidate(
      {
        testId: 'user-menu-trigger',
        suggestedAnchorKey: 'user-menu-trigger',
        sourceKind: 'explicit',
        sourceLocations: [
          { filePath: 'src/client/components/UserMenu.tsx', line: 1 },
        ],
        sourceHash: 'hash',
      },
      actor
    );

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorKey: 'user-menu-trigger',
        sourceKind: 'explicit',
        reviewStatus: 'pending',
        isActive: false,
      })
    );
  });
});

describe('refreshFromSyncDiscovery', () => {
  it('updates lastSeenAt + source fields and clears missingSince when recovered', async () => {
    const existing = makeRecord({
      missingSince: '2026-07-29T00:00:00.000Z',
      sourceHash: 'stale',
    });
    mockDb.query.walkthroughAnchorRegistry.findFirst.mockResolvedValue(
      existing
    );

    const discovery = makeDiscovery({
      testId: existing.testId,
      sourceKind: 'explicit',
      sourceHash: 'fresh-hash',
      sourceLocations: [
        {
          filePath: 'src/client/components/ProfilePage.tsx',
          line: 44,
          discoveryKind: 'explicit',
        },
      ],
    });
    const refreshed = {
      ...existing,
      lastSeenAt: '2026-07-30T12:00:00.000Z',
      missingSince: null,
      sourceHash: 'fresh-hash',
      sourceLocations: discovery.sourceLocations,
    };
    const setMock = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([refreshed]),
      }),
    });
    mockDb.update.mockReturnValue({ set: setMock });

    const result = await refreshFromSyncDiscovery(
      existing.id,
      discovery,
      actor
    );

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        lastSeenAt: expect.any(String),
        missingSince: null,
        sourceHash: 'fresh-hash',
        sourceLocations: discovery.sourceLocations,
        updatedBy: 'admin-sync',
      })
    );
    expect(result.missingSince).toBeNull();
    expect(result.sourceHash).toBe('fresh-hash');
  });
});

describe('persistSyncExtractionResult', () => {
  it('creates new candidates, refreshes existing, stamps missing for approved/rejected only', async () => {
    const approved = makeRecord({
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      testId: 'profile-identity-section',
      reviewStatus: 'approved',
      missingSince: '2026-07-29T00:00:00.000Z',
    });
    const rejected = makeRecord({
      id: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
      anchorKey: 'old-reject',
      testId: 'old-reject',
      reviewStatus: 'rejected',
      isActive: false,
      missingSince: null,
    });
    const pending = makeRecord({
      id: 'cccccccc-cccc-cccc-dddd-eeeeeeeeeeee',
      anchorKey: 'ghost-pending',
      testId: 'ghost-pending',
      reviewStatus: 'pending',
      isActive: false,
      missingSince: null,
    });

    // Snapshot load for catalog lookup during persist
    mockDb.query.walkthroughAnchorRegistry.findMany.mockResolvedValue([
      approved,
      rejected,
      pending,
    ]);

    const newDiscovery = makeDiscovery({ testId: 'brand-new-menu-button' });
    const recoveredDiscovery = makeDiscovery({
      testId: approved.testId,
      sourceHash: 'recovered-hash',
      sourceLocations: [
        {
          filePath: 'src/client/components/ProfilePage.tsx',
          line: 20,
          discoveryKind: 'explicit',
        },
      ],
    });

    const createdRow = makeRecord({
      id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      anchorKey: 'brand-new-menu-button',
      testId: 'brand-new-menu-button',
      reviewStatus: 'pending',
      isActive: false,
      sourceHash: newDiscovery.sourceHash,
      sourceKind: 'data_testid',
      smartTags: [],
      aiProvenance: null,
      sourceLocations: newDiscovery.sourceLocations,
    });
    const refreshedRow = {
      ...approved,
      missingSince: null,
      sourceHash: 'recovered-hash',
      lastSeenAt: '2026-07-30T12:00:00.000Z',
    };
    const markedRejected = {
      ...rejected,
      missingSince: '2026-07-30T12:00:00.000Z',
    };

    // createFromCandidate duplicate check
    mockDb.query.walkthroughAnchorRegistry.findMany
      .mockResolvedValueOnce([approved, rejected, pending]) // live catalog for persist indexing
      .mockResolvedValueOnce([]); // createFromCandidate duplicate check

    // refresh requireLiveRow + missing stamps
    mockDb.query.walkthroughAnchorRegistry.findFirst
      .mockResolvedValueOnce(approved) // refresh
      .mockResolvedValueOnce(rejected); // mark missing

    const insertReturning = jest.fn().mockResolvedValue([createdRow]);
    mockDb.insert.mockReturnValue({
      values: jest.fn().mockReturnValue({ returning: insertReturning }),
    });

    const updateSetMocks: jest.Mock[] = [];
    mockDb.update.mockImplementation(() => {
      const setMock = jest.fn().mockImplementation((patch) => {
        const row =
          patch.missingSince != null
            ? markedRejected
            : patch.sourceHash === 'recovered-hash'
              ? refreshedRow
              : refreshedRow;
        return {
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([row]),
          }),
        };
      });
      updateSetMocks.push(setMock);
      return { set: setMock };
    });

    const extraction = emptyExtraction({
      newCandidates: [newDiscovery],
      existingMatches: [recoveredDiscovery],
      missingWarnings: [
        {
          testId: rejected.testId,
          catalogEntry: {
            testId: rejected.testId,
            reviewStatus: 'rejected',
            deletedAt: null,
          },
        },
        {
          testId: pending.testId,
          catalogEntry: {
            testId: pending.testId,
            reviewStatus: 'pending',
            deletedAt: null,
          },
        },
      ],
    });

    const summary = await persistSyncExtractionResult(extraction, actor);

    expect(summary.created).toHaveLength(1);
    expect(summary.created[0].testId).toBe('brand-new-menu-button');
    expect(summary.created[0].reviewStatus).toBe('pending');
    expect(summary.refreshed).toHaveLength(1);
    expect(summary.refreshed[0].missingSince).toBeNull();
    expect(summary.markedMissing).toHaveLength(1);
    expect(summary.markedMissing[0].testId).toBe('old-reject');
    expect(summary.newCandidateIdsForSmartTagging).toEqual([createdRow.id]);
    expect(summary.reviewCandidates).toEqual([
      expect.objectContaining({
        id: createdRow.id,
        testId: 'brand-new-menu-button',
      }),
    ]);

    // Pending disappearance must not be stamped missing
    const missingPatches = updateSetMocks
      .map((m) => m.mock.calls[0]?.[0])
      .filter((p) => p && p.missingSince != null);
    expect(missingPatches).toHaveLength(1);
  });

  it('keeps soft-deleted rows out of missing logic', async () => {
    mockDb.query.walkthroughAnchorRegistry.findMany.mockResolvedValue([]);

    const extraction = emptyExtraction({
      missingWarnings: [
        {
          testId: 'deleted-anchor',
          catalogEntry: {
            testId: 'deleted-anchor',
            reviewStatus: 'approved',
            deletedAt: '2026-07-29T00:00:00.000Z',
          },
        },
      ],
    });

    const summary = await persistSyncExtractionResult(extraction, actor);
    expect(summary.markedMissing).toHaveLength(0);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('resurfaces already-tagged pending existingMatches in reviewCandidates on re-sync', async () => {
    const pendingTagged = makeRecord({
      id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      anchorKey: 'ado-create-error',
      testId: 'ado-create-error',
      reviewStatus: 'pending',
      isActive: false,
      smartTags: ['ado', 'create', 'modal', 'troubleshoot'],
      aiProvenance: {
        provider: 'cursor',
        model: 'sync-heuristic',
        skillPath: 'walkthrough-anchor-sync-heuristic',
        generatedAt: '2026-07-30T01:00:00.000Z',
        confidence: 0.42,
        rationale: 'Deterministic sync heuristic',
        runId: null,
        threadId: null,
      },
    });
    const approved = makeRecord({
      id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      testId: 'profile-identity-section',
      reviewStatus: 'approved',
    });

    mockDb.query.walkthroughAnchorRegistry.findMany.mockResolvedValue([
      pendingTagged,
      approved,
    ]);
    mockDb.query.walkthroughAnchorRegistry.findFirst
      .mockResolvedValueOnce(pendingTagged)
      .mockResolvedValueOnce(approved);

    const pendingRefreshed = {
      ...pendingTagged,
      lastSeenAt: '2026-07-30T12:00:00.000Z',
      sourceHash: 'pending-hash',
      smartTags: [],
      aiProvenance: null,
      allowedPlacements: ['top', 'right', 'bottom', 'left'],
    };
    const approvedRefreshed = {
      ...approved,
      lastSeenAt: '2026-07-30T12:00:00.000Z',
      sourceHash: 'approved-hash',
    };

    mockDb.update.mockImplementation(() => ({
      set: jest.fn().mockImplementation((patch) => ({
        where: jest.fn().mockReturnValue({
          returning: jest
            .fn()
            .mockResolvedValue([
              patch.sourceHash === 'pending-hash'
                ? pendingRefreshed
                : approvedRefreshed,
            ]),
        }),
      })),
    }));

    const extraction = emptyExtraction({
      existingMatches: [
        makeDiscovery({
          testId: pendingTagged.testId,
          sourceHash: 'pending-hash',
          sourceLocations: [
            {
              filePath: 'src/client/components/CreateAdoItemsModal.tsx',
              line: 415,
              discoveryKind: 'data_testid',
            },
          ],
        }),
        makeDiscovery({
          testId: approved.testId,
          sourceHash: 'approved-hash',
          sourceKind: 'explicit',
        }),
      ],
    });

    const summary = await persistSyncExtractionResult(extraction, actor);

    expect(summary.created).toHaveLength(0);
    expect(summary.refreshed).toHaveLength(2);
    // Pending (even with tags) returns to Sync review; approved does not.
    expect(summary.reviewCandidates).toEqual([
      expect.objectContaining({
        id: pendingTagged.id,
        testId: 'ado-create-error',
        reviewStatus: 'pending',
        smartTags: [],
        aiProvenance: null,
      }),
    ]);
    // Cleared heuristic pending is reviewable and re-queued for AI.
    expect(summary.newCandidateIdsForSmartTagging).toEqual([pendingTagged.id]);
  });
});

describe('listCatalogSnapshotForSync', () => {
  it('returns live rows only (deletedAt null)', async () => {
    mockDb.query.walkthroughAnchorRegistry.findMany.mockResolvedValue([
      makeRecord({ testId: 'live-one', deletedAt: null }),
    ]);

    const snapshot = await listCatalogSnapshotForSync();
    expect(snapshot).toEqual([
      expect.objectContaining({
        testId: 'live-one',
        deletedAt: null,
      }),
    ]);
    expect(mockDb.query.walkthroughAnchorRegistry.findMany).toHaveBeenCalled();
  });
});

describe('syncExtractAndPersistAnchors', () => {
  it('loads catalog, extracts, persists, and leaves AI hook for new IDs only', async () => {
    const live = makeRecord();
    mockDb.query.walkthroughAnchorRegistry.findMany
      .mockResolvedValueOnce([live]) // catalog snapshot for extract
      .mockResolvedValueOnce([live]) // persist live index
      .mockResolvedValueOnce([]); // create duplicate check

    const newDiscovery = makeDiscovery({ testId: 'fresh-menu-button' });
    const extraction = emptyExtraction({
      discoveries: [newDiscovery],
      newCandidates: [newDiscovery],
    });
    mockSyncExtract.mockResolvedValue(extraction);

    const createdRow = makeRecord({
      id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      anchorKey: 'fresh-menu-button',
      testId: 'fresh-menu-button',
      reviewStatus: 'pending',
      isActive: false,
      smartTags: [],
      aiProvenance: null,
      sourceLocations: [
        { filePath: 'src/client/components/UserMenu.tsx', line: 12 },
      ],
    });
    mockDb.insert.mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([createdRow]),
      }),
    });

    const result = await syncExtractAndPersistAnchors(
      { provider: 'local' },
      actor
    );

    expect(mockSyncExtract).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'local',
        catalogSnapshot: [
          expect.objectContaining({ testId: live.testId, deletedAt: null }),
        ],
      })
    );
    expect(result.newCandidates).toHaveLength(1);
    expect(result.persistence.created).toHaveLength(1);
    expect(result.persistence.newCandidateIdsForSmartTagging).toEqual([
      createdRow.id,
    ]);
    // AI smart-tagging is Track B — sync must not invoke it; only expose IDs.
    expect(result.persistence).toHaveProperty('newCandidateIdsForSmartTagging');
  });

  it('materializes Apex skill repo for github sync before extract', async () => {
    mockResolveProvider.mockResolvedValueOnce('github');
    mockMaterialize.mockResolvedValueOnce({
      repositoryRoot: '/data/dev-workspaces/walkthrough-anchor-sync',
      branch: 'main',
      repo: 'AI-Pilot',
      provider: 'github',
      project: 'Apex',
    });
    mockDb.query.walkthroughAnchorRegistry.findMany.mockResolvedValue([]);
    mockSyncExtract.mockResolvedValue(
      emptyExtraction({
        diagnostics: {
          provider: 'github',
          rootPath: '/data/dev-workspaces/walkthrough-anchor-sync',
          filesScanned: 0,
          filesSkipped: 0,
          bytesRead: 0,
          durationMs: 1,
          truncatedFiles: [],
          errors: [],
          branch: 'main',
          committedTruth: true,
        },
      })
    );

    await syncExtractAndPersistAnchors({ provider: 'github' }, actor);

    expect(mockMaterialize).toHaveBeenCalledWith('github');
    expect(mockSyncExtract).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'github',
        repositoryRoot: '/data/dev-workspaces/walkthrough-anchor-sync',
        branch: 'main',
        committedTruth: true,
      })
    );
  });
});
