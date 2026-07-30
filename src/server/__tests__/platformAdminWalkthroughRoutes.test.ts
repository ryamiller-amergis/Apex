/**
 * Platform Admin Walkthrough routes — FEAT-001 TBI-002 VT-09 / DoD-0 / DoD-2.
 */

import request from 'supertest';
import express from 'express';
import platformAdminRouter from '../routes/platformAdmin';
import * as walkthroughService from '../services/walkthroughService';
import { requireSuperAdmin } from '../middleware/rbac';

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
  notifyPublishedAudience: jest.fn().mockResolvedValue({
    targeted: 0,
    created: 0,
    skippedDuplicate: 0,
    failed: 0,
  }),
  reconcileForUser: jest.fn().mockResolvedValue({
    created: 0,
    skippedDuplicate: 0,
    failed: 0,
  }),
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
jest.mock('../services/walkthroughAnchorRegistryService', () => ({
  listAuthoringAnchorEntries: jest.fn().mockResolvedValue([
    {
      key: 'user-menu-trigger',
      testId: 'user-menu-trigger',
      label: 'User menu',
      targetRoute: '/home',
      allowedPlacements: ['bottom', 'left', 'right', 'top'],
    },
  ]),
  listAnchors: jest.fn(),
  getAnchorById: jest.fn(),
  getAnchorByKey: jest.fn(),
  getAnchorByTestId: jest.fn(),
  createManualAnchor: jest.fn(),
  updateAnchor: jest.fn(),
  bulkUpdateAnchors: jest.fn(),
  updateMissingState: jest.fn(),
  softDeleteAnchor: jest.fn(),
  syncExtractAndPersistAnchors: jest.fn(),
  parseBulkAction: jest.fn(),
  parseReviewStatusFilter: jest.fn(),
  parseSourceKindFilter: jest.fn(),
}));
jest.mock('../middleware/rbac', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Jest Express middleware mock signatures
  requireSuperAdmin: jest.fn((_req: any, _res: any, next: any) => next()),
}));

const mockWt = walkthroughService as jest.Mocked<typeof walkthroughService>;
const _mockAi = jest.requireMock('../services/walkthroughAiDraftService') as {
  redoProposalUnit: jest.Mock;
  validateProposalUnit: jest.Mock;
  listWalkthroughAiPolicyPresets: typeof import('../services/walkthroughAiDraftService').listWalkthroughAiPolicyPresets;
};
const mockGeneration = jest.requireMock('../services/walkthroughGenerationService') as {
  startGeneration: jest.Mock;
  getGenerationResult: jest.Mock;
  cancelGeneration: jest.Mock;
};
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

beforeEach(() => {
  jest.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Jest Express middleware mock signatures
  mockRequireSuperAdmin.mockImplementation((_req: any, _res: any, next: any) => next());
});

describe('platformAdmin walkthrough routes (TBI-002 DoD-0 / VT-09)', () => {
  it('VT-09 — requireSuperAdmin is applied to the platform-admin router', async () => {
    mockWt.listCatalog.mockResolvedValue({ items: [], nextCursor: null });
    await request(buildApp()).get('/api/platform-admin/walkthroughs');
    expect(mockRequireSuperAdmin).toHaveBeenCalled();
  });

  it('VT-09 — when Super Admin middleware denies, create is not reached', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Jest Express middleware mock signatures
    mockRequireSuperAdmin.mockImplementation((_req: any, res: any) => {
      res.status(403).json({ error: 'Forbidden' });
    });
    const res = await request(buildApp()).post('/api/platform-admin/walkthroughs').send({});
    expect(res.status).toBe(403);
    expect(mockWt.createWalkthrough).not.toHaveBeenCalled();
  });

  it('POST create delegates to service', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial WalkthroughDefinition stub
    mockWt.createWalkthrough.mockResolvedValue({ id: 'wt-1' } as any);
    const res = await request(buildApp())
      .post('/api/platform-admin/walkthroughs')
      .send({
        internalName: 'n',
        userTitle: 't',
        whyItMatters: 'w',
        targeting: { projects: ['Apex'] },
        steps: [],
      });
    expect(res.status).toBe(201);
    expect(mockWt.createWalkthrough).toHaveBeenCalled();
  });

  it('GET anchors returns approved catalog authoring entries', async () => {
    const res = await request(buildApp()).get('/api/platform-admin/walkthroughs/anchors');
    expect(res.status).toBe(200);
    expect(res.body.anchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'user-menu-trigger', targetRoute: '/home' }),
      ]),
    );
  });

  it('GET :id delegates to getWalkthroughAdmin', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial WalkthroughDefinition stub
    mockWt.getWalkthroughAdmin.mockResolvedValue({ id: 'wt-1', internalName: 'Intro' } as any);
    const res = await request(buildApp()).get('/api/platform-admin/walkthroughs/wt-1');
    expect(res.status).toBe(200);
    expect(mockWt.getWalkthroughAdmin).toHaveBeenCalledWith('wt-1');
    expect(res.body.internalName).toBe('Intro');
  });

  it('GET :id returns 404 when not found', async () => {
    const { WalkthroughDomainError } = await import('../../shared/types/walkthrough');
    mockWt.getWalkthroughAdmin.mockRejectedValue(
      new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found'),
    );
    const res = await request(buildApp()).get('/api/platform-admin/walkthroughs/missing');
    expect(res.status).toBe(404);
  });

  it('POST publish / archive / report endpoints exist', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial WalkthroughDefinition stub
    mockWt.publishWalkthrough.mockResolvedValue({ id: 'wt-1' } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial WalkthroughDefinition stub
    mockWt.archiveWalkthrough.mockResolvedValue({ id: 'wt-1' } as any);
    mockWt.getAcknowledgementReport.mockResolvedValue({
      walkthroughId: 'wt-1',
      revision: 1,
      generatedAt: '2026-07-29T00:00:00.000Z',
      acknowledgedCount: 0,
      audienceCount: 0,
      completedCount: 0,
      dismissedCount: 0,
      details: [],
      completed: [],
      dismissed: [],
    });
    mockWt.listAnchorMisses.mockResolvedValue({ items: [], nextCursor: null });

    expect(
      (await request(buildApp()).post('/api/platform-admin/walkthroughs/wt-1/publish').send({
        mode: 'fresh',
        targeting: { projects: ['Apex'] },
      })).status,
    ).toBe(200);
    expect(
      (await request(buildApp()).post('/api/platform-admin/walkthroughs/wt-1/archive').send()).status,
    ).toBe(200);
    expect(
      (await request(buildApp()).get('/api/platform-admin/walkthroughs/wt-1/reports/acknowledgement'))
        .status,
    ).toBe(200);
    expect(
      (await request(buildApp()).get('/api/platform-admin/walkthroughs/wt-1/reports/anchor-misses'))
        .status,
    ).toBe(200);
  });

  it('FEAT-008 PBI-010 AC-3 — acknowledgement report returns 403 without Super Admin', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Jest Express middleware mock signatures
    mockRequireSuperAdmin.mockImplementation((_req: any, res: any) => {
      res.status(403).json({ error: 'Forbidden' });
    });
    const res = await request(buildApp()).get(
      '/api/platform-admin/walkthroughs/wt-1/reports/acknowledgement',
    );
    expect(res.status).toBe(403);
    expect(res.body.acknowledgedCount).toBeUndefined();
    expect(res.body.details).toBeUndefined();
    expect(mockWt.getAcknowledgementReport).not.toHaveBeenCalled();
  });

  it('FEAT-008 PBI-011 AC-3 — anchor-miss report returns 403 without Super Admin', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Jest Express middleware mock signatures
    mockRequireSuperAdmin.mockImplementation((_req: any, res: any) => {
      res.status(403).json({ error: 'Forbidden' });
    });
    const res = await request(buildApp()).get(
      '/api/platform-admin/walkthroughs/wt-1/reports/anchor-misses',
    );
    expect(res.status).toBe(403);
    expect(res.body.items).toBeUndefined();
    expect(mockWt.listAnchorMisses).not.toHaveBeenCalled();
  });

  it('FEAT-008 PBI-010 AC-1 — acknowledgement 500 has no partial count payload', async () => {
    mockWt.getAcknowledgementReport.mockRejectedValue(new Error('boom'));
    const res = await request(buildApp()).get(
      '/api/platform-admin/walkthroughs/wt-1/reports/acknowledgement',
    );
    expect(res.status).toBe(500);
    expect(res.body.acknowledgedCount).toBeUndefined();
    expect(res.body.audienceCount).toBeUndefined();
  });

  it('POST ai-drafts/validate is a validation boundary only', async () => {
    mockWt.validateAiDraft.mockReturnValue({
      valid: true,
      draft: {
        internalName: 'n',
        userTitle: 't',
        whyItMatters: 'w',
        steps: [],
        targeting: { projects: ['Apex'] },
      },
    });
    const res = await request(buildApp())
      .post('/api/platform-admin/walkthroughs/ai-drafts/validate')
      .send({
        internalName: 'n',
        userTitle: 't',
        whyItMatters: 'w',
        targeting: { projects: ['Apex'] },
        steps: [],
      });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it('PBI-003 AC-3 — POST ai-drafts/generate/start returns 403 when Super Admin middleware denies', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Jest Express middleware mock signatures
    mockRequireSuperAdmin.mockImplementation((_req: any, res: any) => {
      res.status(403).json({ error: 'Forbidden' });
    });
    const res = await request(buildApp())
      .post('/api/platform-admin/walkthroughs/ai-drafts/generate/start')
      .send({ projectId: 'Apex', intent: 'Introduce feature' });
    expect(res.status).toBe(403);
    expect(mockGeneration.startGeneration).not.toHaveBeenCalled();
  });

  it('POST ai-drafts/generate/start delegates to Cursor generation and ignores client allow-lists', async () => {
    mockGeneration.startGeneration.mockResolvedValue({
      threadId: 'thread-1',
      provenance: {
        provider: 'cursor',
        model: 'composer-2.5',
        skillPath: '.cursor/skills/walkthrough-generation/SKILL.md',
        generatedAt: new Date().toISOString(),
        threadId: 'thread-1',
      },
    });
    const res = await request(buildApp())
      .post('/api/platform-admin/walkthroughs/ai-drafts/generate/start')
      .send({
        projectId: 'Apex',
        intent: 'Introduce feature',
        policyPreset: 'A',
        assetAllowList: ['https://evil.example/x.png'],
        anchors: [{ key: 'fake' }],
      });
    expect(res.status).toBe(200);
    expect(mockGeneration.startGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'Apex',
        intent: 'Introduce feature',
        policyPreset: 'A',
      }),
      'super-admin',
    );
    expect(mockGeneration.startGeneration.mock.calls[0][0].assetAllowList).toBeUndefined();
  });

  it('GET ai-drafts/policy-presets returns A/B/C with default A', async () => {
    const res = await request(buildApp()).get(
      '/api/platform-admin/walkthroughs/ai-drafts/policy-presets',
    );
    expect(res.status).toBe(200);
    expect(res.body.defaultPreset).toBe('A');
    expect(res.body.presets.map((p: { id: string }) => p.id)).toEqual(['A', 'B', 'C']);
  });
});
