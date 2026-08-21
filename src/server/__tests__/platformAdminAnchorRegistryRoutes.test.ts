/**
 * Platform Admin anchor-registry routes — Phase 2 Smart Anchor Management.
 */

import request from 'supertest';
import express from 'express';
import platformAdminRouter from '../routes/platformAdmin';
import * as walkthroughService from '../services/walkthroughService';
import * as walkthroughAnchorRegistryService from '../services/walkthroughAnchorRegistryService';
import { requireSuperAdmin } from '../middleware/rbac';
import { WalkthroughAnchorRegistryError } from '../../shared/types/walkthroughAnchorRegistry';
import type { WalkthroughAnchorRegistryRecord } from '../../shared/types/walkthroughAnchorRegistry';
import { WalkthroughAnchorSmartTaggingOrchestrationError } from '../services/walkthroughAnchorSmartTaggingService';
import * as walkthroughAnchorSmartTaggingService from '../services/walkthroughAnchorSmartTaggingService';

jest.mock('../services/userProjectAssignmentService', () => ({
  bulkSetProjectAssignments: jest.fn(),
  getAllAssignments: jest.fn(),
  getAssignmentsForProject: jest.fn(),
  groupAssignmentsByProject: jest.fn(),
  listKnownApplicationUsers: jest.fn(),
}));
jest.mock('../services/menuSettingsService', () => ({
  listMenuConfigs: jest.fn(),
  getMenuConfig: jest.fn(),
  upsertMenuConfig: jest.fn(),
}));
jest.mock('../services/projectCatalogService', () => ({
  listProjectCatalog: jest.fn(),
}));
jest.mock('../services/projectAccessRequestService', () => ({
  approveProjectAccessRequest: jest.fn(),
  listPlatformAdminAccessRequests: jest.fn(),
  rejectProjectAccessRequest: jest.fn(),
}));
jest.mock('../services/rfpSubmitAccessRequestService', () => ({
  approveRfpSubmitAccessRequest: jest.fn(),
  listPlatformAdminRfpSubmitAccessRequests: jest.fn(),
  rejectRfpSubmitAccessRequest: jest.fn(),
}));
jest.mock('../services/groupService', () => ({
  listGroups: jest.fn(),
}));
jest.mock('../services/featureFlagService', () => ({
  listFlags: jest.fn(),
  getFlag: jest.fn(),
  createFlag: jest.fn(),
  updateFlag: jest.fn(),
  addRule: jest.fn(),
  removeRule: jest.fn(),
  deleteFlag: jest.fn(),
  getFlagAudit: jest.fn(),
}));
jest.mock('../services/pendingAssignmentService', () => ({
  addPendingAssignments: jest.fn(),
  listPendingForProject: jest.fn(),
  removePendingAssignment: jest.fn(),
}));
jest.mock('../services/walkthroughService');
jest.mock('../services/walkthroughNotificationService', () => ({
  notifyPublishedAudience: jest.fn(),
  reconcileForUser: jest.fn(),
}));
jest.mock('../services/walkthroughAiDraftService', () => {
  const actual = jest.requireActual('../services/walkthroughAiDraftService');
  return {
    ...actual,
    redoProposalUnit: jest.fn(),
    validateProposalUnit: jest.fn(),
  };
});
jest.mock('../services/walkthroughGenerationService', () => ({
  startGeneration: jest.fn(),
  getGenerationResult: jest.fn(),
  cancelGeneration: jest.fn(),
}));
jest.mock('../services/walkthroughAnchorSmartTaggingService', () => {
  const actual = jest.requireActual('../services/walkthroughAnchorSmartTaggingService');
  return {
    ...actual,
    startSmartTagging: jest.fn(),
    getSmartTaggingResult: jest.fn(),
    cancelSmartTagging: jest.fn(),
  };
});
jest.mock('../services/walkthroughAnchorRegistryService');
jest.mock('../middleware/rbac', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Jest Express middleware mock signatures
  requireSuperAdmin: jest.fn((_req: any, _res: any, next: any) => next()),
}));

const mockRegistry = walkthroughAnchorRegistryService as jest.Mocked<
  typeof walkthroughAnchorRegistryService
>;
const mockSmartTagging = walkthroughAnchorSmartTaggingService as jest.Mocked<
  typeof walkthroughAnchorSmartTaggingService
>;
const mockRequireSuperAdmin = requireSuperAdmin as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test harness attaches auth profile
  app.use((req: any, _res, next) => {
    req.user = { profile: { oid: 'super-admin', displayName: 'Admin' } };
    next();
  });
  app.use('/api/platform-admin', platformAdminRouter);
  return app;
}

const sample: WalkthroughAnchorRegistryRecord = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  anchorKey: 'profile-identity',
  testId: 'profile-identity-section',
  label: 'Profile — Identity',
  suggestedRoute: null,
  approvedRoute: '/profile',
    allowedPlacements: ['bottom', 'top'],
    smartTags: ['profile'],
    openerAnchorKeys: [],
    sourceKind: 'manual',
  sourceLocations: [],
  sourceHash: null,
  reviewStatus: 'approved',
  isActive: true,
  lastSeenAt: null,
  missingSince: null,
  deletedAt: null,
  aiProvenance: null,
  createdBy: 'super-admin',
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedBy: 'super-admin',
  updatedAt: '2026-07-30T00:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Jest Express middleware mock signatures
  mockRequireSuperAdmin.mockImplementation((_req: any, _res: any, next: any) => next());
  mockRegistry.parseReviewStatusFilter.mockImplementation((v) =>
    typeof v === 'string' && v ? (v as never) : undefined,
  );
  mockRegistry.parseSourceKindFilter.mockImplementation((v) =>
    typeof v === 'string' && v ? (v as never) : undefined,
  );
});

describe('platformAdmin anchor-registry routes (Phase 2)', () => {
  it('lists catalog under Super Admin gate', async () => {
    mockRegistry.listAnchors.mockResolvedValue({
      items: [sample],
      nextCursor: null,
      counts: { total: 1, pending: 0, approved: 1, rejected: 0, active: 1, missing: 0 },
    });

    const res = await request(buildApp()).get(
      '/api/platform-admin/walkthroughs/anchor-registry?search=profile&reviewStatus=approved',
    );

    expect(mockRequireSuperAdmin).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(mockRegistry.listAnchors).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'profile', reviewStatus: 'approved' }),
    );
  });

  it('returns high-level module coverage without colliding with the detail route', async () => {
    mockRegistry.getModuleCoverage.mockResolvedValue({
      totalModules: 2,
      coveredCount: 1,
      uncoveredCount: 1,
      coveredModules: [
        { key: 'profile', label: 'Profile', anchorCount: 4, routes: ['/profile'] },
      ],
      uncoveredModules: [
        { key: 'planning', label: 'Planning', anchorCount: 0, routes: ['/planning'] },
      ],
    });

    const res = await request(buildApp()).get(
      '/api/platform-admin/walkthroughs/anchor-registry/module-coverage',
    );

    expect(res.status).toBe(200);
    expect(res.body.coveredModules[0]).toMatchObject({
      key: 'profile',
      anchorCount: 4,
    });
    expect(mockRegistry.getModuleCoverage).toHaveBeenCalled();
    expect(mockRegistry.getAnchorById).not.toHaveBeenCalled();
  });

  it('creates manual anchors and maps validation errors', async () => {
    mockRegistry.createManualAnchor.mockResolvedValue(sample);
    const ok = await request(buildApp())
      .post('/api/platform-admin/walkthroughs/anchor-registry')
      .send({
        anchorKey: 'profile-identity',
        testId: 'profile-identity-section',
        label: 'Profile — Identity',
        allowedPlacements: ['bottom'],
      });
    expect(ok.status).toBe(201);
    expect(ok.body.anchorKey).toBe('profile-identity');

    mockRegistry.createManualAnchor.mockRejectedValue(
      new WalkthroughAnchorRegistryError('VALIDATION_ERROR', 'anchorKey must be an exact registry key'),
    );
    const bad = await request(buildApp())
      .post('/api/platform-admin/walkthroughs/anchor-registry')
      .send({ anchorKey: '#x', testId: 'x', label: 'x', allowedPlacements: ['bottom'] });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
  });

  it('supports get-by-key, bulk, missing, soft-delete', async () => {
    mockRegistry.getAnchorByKey.mockResolvedValue(sample);
    expect(
      (
        await request(buildApp()).get(
          '/api/platform-admin/walkthroughs/anchor-registry/by-key/profile-identity',
        )
      ).status,
    ).toBe(200);

    mockRegistry.bulkUpdateAnchors.mockResolvedValue([{ ...sample, reviewStatus: 'approved' }]);
    const bulk = await request(buildApp())
      .post('/api/platform-admin/walkthroughs/anchor-registry/bulk')
      .send({ ids: [sample.id], action: 'approve' });
    expect(bulk.status).toBe(200);
    expect(bulk.body.items[0].reviewStatus).toBe('approved');

    mockRegistry.updateMissingState.mockResolvedValue([
      { ...sample, missingSince: '2026-07-30T12:00:00.000Z' },
    ]);
    const missing = await request(buildApp())
      .post('/api/platform-admin/walkthroughs/anchor-registry/missing')
      .send({ updates: [{ id: sample.id, missingSince: '2026-07-30T12:00:00.000Z' }] });
    expect(missing.status).toBe(200);

    mockRegistry.softDeleteAnchor.mockResolvedValue({
      ...sample,
      deletedAt: '2026-07-30T13:00:00.000Z',
      isActive: false,
    });
    const del = await request(buildApp()).delete(
      `/api/platform-admin/walkthroughs/anchor-registry/${sample.id}`,
    );
    expect(del.status).toBe(200);
    expect(del.body.deletedAt).toBeTruthy();
    expect(del.body.isActive).toBe(false);
  });

  it('maps ACTIVE_REQUIRES_APPROVED and DUPLICATE', async () => {
    mockRegistry.bulkUpdateAnchors.mockRejectedValue(
      new WalkthroughAnchorRegistryError(
        'ACTIVE_REQUIRES_APPROVED',
        'Only approved anchors may be active',
      ),
    );
    expect(
      (
        await request(buildApp())
          .post('/api/platform-admin/walkthroughs/anchor-registry/bulk')
          .send({ ids: [sample.id], action: 'activate' })
      ).status,
    ).toBe(400);

    mockRegistry.createManualAnchor.mockRejectedValue(
      new WalkthroughAnchorRegistryError('DUPLICATE', 'anchorKey already exists'),
    );
    expect(
      (
        await request(buildApp())
          .post('/api/platform-admin/walkthroughs/anchor-registry')
          .send({
            anchorKey: 'profile-identity',
            testId: 'x',
            label: 'x',
            allowedPlacements: ['bottom'],
          })
      ).status,
    ).toBe(409);
  });

  it('runs Super Admin sync extract+persist and returns the full sync result', async () => {
    const syncResult = {
      discoveries: [],
      newCandidates: [
        {
          testId: 'save-draft-button',
          suggestedAnchorKey: null,
          sourceKind: 'data_testid' as const,
          sourceLocations: [{ filePath: 'src/client/components/StaticIds.tsx', line: 1 }],
          sourceHash: 'hash1',
          proposedReviewStatus: 'pending' as const,
          proposedIsActive: false as const,
        },
      ],
      existingMatches: [],
      missingWarnings: [],
      duplicates: [],
      unsupportedDynamicPatterns: [],
      diagnostics: {
        provider: 'local' as const,
        rootPath: '/repo',
        filesScanned: 1,
        filesSkipped: 0,
        bytesRead: 10,
        durationMs: 2,
        truncatedFiles: [],
        errors: [],
        branch: null,
        committedTruth: false,
      },
      persistence: {
        created: [
          {
            ...sample,
            id: 'new-1',
            testId: 'save-draft-button',
            reviewStatus: 'pending' as const,
            isActive: false,
          },
        ],
        refreshed: [],
        markedMissing: [],
        reviewCandidates: [
          {
            ...sample,
            id: 'new-1',
            testId: 'save-draft-button',
            reviewStatus: 'pending' as const,
            isActive: false,
          },
        ],
        newCandidateIdsForSmartTagging: ['new-1'],
      },
    };
    mockRegistry.syncExtractAndPersistAnchors.mockResolvedValue(syncResult as never);

    const res = await request(buildApp())
      .post('/api/platform-admin/walkthroughs/anchor-registry/sync')
      .send({ provider: 'local' });

    expect(mockRequireSuperAdmin).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.body.persistence.newCandidateIdsForSmartTagging).toEqual(['new-1']);
    expect(res.body.newCandidates[0].testId).toBe('save-draft-button');
    expect(mockRegistry.syncExtractAndPersistAnchors).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'local' }),
      expect.objectContaining({ id: 'super-admin' }),
    );
  });

  it('accepts remote sync without files (server materializes Apex skill repo)', async () => {
    mockRegistry.syncExtractAndPersistAnchors.mockResolvedValue({
      discoveries: [],
      newCandidates: [],
      existingMatches: [],
      missingWarnings: [],
      duplicates: [],
      unsupportedDynamicPatterns: [],
      diagnostics: {
        provider: 'github' as const,
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
      persistence: {
        created: [],
        refreshed: [],
        markedMissing: [],
        reviewCandidates: [],
        newCandidateIdsForSmartTagging: [],
      },
    } as never);

    const res = await request(buildApp())
      .post('/api/platform-admin/walkthroughs/anchor-registry/sync')
      .send({ provider: 'github' });

    expect(res.status).toBe(200);
    expect(mockRegistry.syncExtractAndPersistAnchors).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'github' }),
      expect.objectContaining({ id: 'super-admin' }),
    );
    expect(res.body.diagnostics.committedTruth).toBe(true);
  });

  it('rejects invalid sync provider', async () => {
    const res = await request(buildApp())
      .post('/api/platform-admin/walkthroughs/anchor-registry/sync')
      .send({ provider: 'bitbucket' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(mockRegistry.syncExtractAndPersistAnchors).not.toHaveBeenCalled();
  });

  it('does not collide with static /walkthroughs/anchors curated list', async () => {
    mockRegistry.listAuthoringAnchorEntries.mockResolvedValue([
      {
        key: sample.anchorKey,
        testId: sample.testId,
        label: sample.label,
        targetRoute: sample.approvedRoute ?? '',
        allowedPlacements: sample.allowedPlacements,
      },
    ]);
    const res = await request(buildApp()).get('/api/platform-admin/walkthroughs/anchors');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.anchors)).toBe(true);
    expect(res.body.anchors[0].key).toBe(sample.anchorKey);
    expect(mockRegistry.listAuthoringAnchorEntries).toHaveBeenCalled();
    expect(walkthroughService.listCatalog).not.toHaveBeenCalled();
  });

  it('smart-tagging start/status/cancel are Super Admin gated', async () => {
    mockSmartTagging.startSmartTagging.mockResolvedValue({
      threadId: 'thread-1',
      candidateTestIds: ['new-candidate'],
      provenance: {
        provider: 'cursor',
        model: 'claude-sonnet-4',
        skillPath: '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
        generatedAt: '2026-07-30T04:00:00.000Z',
        threadId: 'thread-1',
        runId: null,
      },
    });
    mockSmartTagging.getSmartTaggingResult.mockResolvedValue({
      status: 'pending',
    });
    mockSmartTagging.cancelSmartTagging.mockResolvedValue(undefined);

    const start = await request(buildApp())
      .post('/api/platform-admin/walkthroughs/anchor-registry/smart-tagging/start')
      .send({ candidates: [{ testId: 'new-candidate' }] });
    expect(start.status).toBe(200);
    expect(start.body.threadId).toBe('thread-1');
    expect(mockRequireSuperAdmin).toHaveBeenCalled();
    expect(mockSmartTagging.startSmartTagging).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [{ testId: 'new-candidate' }],
      }),
      'super-admin',
    );

    const status = await request(buildApp()).get(
      '/api/platform-admin/walkthroughs/anchor-registry/smart-tagging/status/thread-1',
    );
    expect(status.status).toBe(200);
    expect(status.body.status).toBe('pending');
    expect(mockSmartTagging.getSmartTaggingResult).toHaveBeenCalledWith('thread-1', 'super-admin');

    const cancel = await request(buildApp())
      .post('/api/platform-admin/walkthroughs/anchor-registry/smart-tagging/cancel')
      .send({ threadId: 'thread-1' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('cancelled');
    expect(mockSmartTagging.cancelSmartTagging).toHaveBeenCalledWith('thread-1', 'super-admin');
  });

  it('maps smart-tagging INVALID_REQUEST and requires threadId on cancel', async () => {
    mockSmartTagging.startSmartTagging.mockRejectedValue(
      new WalkthroughAnchorSmartTaggingOrchestrationError(
        'INVALID_REQUEST',
        'candidates must be a non-empty array of newly discovered test IDs',
      ),
    );
    const bad = await request(buildApp())
      .post('/api/platform-admin/walkthroughs/anchor-registry/smart-tagging/start')
      .send({ candidates: [] });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_REQUEST');

    const missingThread = await request(buildApp())
      .post('/api/platform-admin/walkthroughs/anchor-registry/smart-tagging/cancel')
      .send({});
    expect(missingThread.status).toBe(400);
    expect(missingThread.body.error).toMatch(/threadId/i);
  });
});
