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
jest.mock('../middleware/rbac', () => ({
  requireSuperAdmin: jest.fn((_req: any, _res: any, next: any) => next()),
}));

const mockWt = walkthroughService as jest.Mocked<typeof walkthroughService>;
const mockRequireSuperAdmin = requireSuperAdmin as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { profile: { oid: 'super-admin', displayName: 'Admin' } };
    next();
  });
  app.use('/api/platform-admin', platformAdminRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireSuperAdmin.mockImplementation((_req: any, _res: any, next: any) => next());
});

describe('platformAdmin walkthrough routes (TBI-002 DoD-0 / VT-09)', () => {
  it('VT-09 — requireSuperAdmin is applied to the platform-admin router', async () => {
    mockWt.listCatalog.mockResolvedValue({ items: [], nextCursor: null });
    await request(buildApp()).get('/api/platform-admin/walkthroughs');
    expect(mockRequireSuperAdmin).toHaveBeenCalled();
  });

  it('VT-09 — when Super Admin middleware denies, create is not reached', async () => {
    mockRequireSuperAdmin.mockImplementation((_req: any, res: any) => {
      res.status(403).json({ error: 'Forbidden' });
    });
    const res = await request(buildApp()).post('/api/platform-admin/walkthroughs').send({});
    expect(res.status).toBe(403);
    expect(mockWt.createWalkthrough).not.toHaveBeenCalled();
  });

  it('POST create delegates to service', async () => {
    mockWt.createWalkthrough.mockResolvedValue({ id: 'wt-1' } as any);
    const res = await request(buildApp())
      .post('/api/platform-admin/walkthroughs')
      .send({
        internalName: 'n',
        userTitle: 't',
        whyItMatters: 'w',
        targeting: { project: 'Apex' },
        steps: [],
      });
    expect(res.status).toBe(201);
    expect(mockWt.createWalkthrough).toHaveBeenCalled();
  });

  it('POST publish / archive / report endpoints exist', async () => {
    mockWt.publishWalkthrough.mockResolvedValue({ id: 'wt-1' } as any);
    mockWt.archiveWalkthrough.mockResolvedValue({ id: 'wt-1' } as any);
    mockWt.getAcknowledgementReport.mockResolvedValue({
      walkthroughId: 'wt-1',
      revision: 1,
      acknowledgedCount: 0,
      audienceCount: 0,
      completed: [],
      dismissed: [],
    });

    expect(
      (await request(buildApp()).post('/api/platform-admin/walkthroughs/wt-1/publish').send({
        mode: 'fresh',
        targeting: { project: 'Apex' },
      })).status,
    ).toBe(200);
    expect(
      (await request(buildApp()).post('/api/platform-admin/walkthroughs/wt-1/archive').send()).status,
    ).toBe(200);
    expect(
      (await request(buildApp()).get('/api/platform-admin/walkthroughs/wt-1/reports/acknowledgement'))
        .status,
    ).toBe(200);
  });

  it('POST ai-drafts/validate is a validation boundary only', async () => {
    mockWt.validateAiDraft.mockReturnValue({
      valid: true,
      draft: {
        internalName: 'n',
        userTitle: 't',
        whyItMatters: 'w',
        steps: [],
        targeting: { project: 'Apex' },
      },
    });
    const res = await request(buildApp())
      .post('/api/platform-admin/walkthroughs/ai-drafts/validate')
      .send({
        internalName: 'n',
        userTitle: 't',
        whyItMatters: 'w',
        targeting: { project: 'Apex' },
        steps: [],
      });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });
});
