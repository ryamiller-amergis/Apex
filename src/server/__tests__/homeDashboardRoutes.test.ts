/**
 * Route tests for GET /api/home-dashboard (TBI-001).
 *
 * - homeDashboardService is mocked; the per-tile null matrix is covered by
 *   homeDashboardService.test.ts, so these tests use one representative payload.
 * - The real RBAC middleware runs; its data sources are mocked so permission and
 *   project-assignment gating is exercised end to end.
 */
import request from 'supertest';
import express from 'express';
import homeDashboardRouter from '../routes/homeDashboard';
import type { HomeDashboardPayload } from '../../shared/types/homeDashboard';

jest.mock('../services/homeDashboardService', () => ({
  getHomeDashboard: jest.fn(),
}));

jest.mock('../services/rbacService', () => ({
  getUserPermissions: jest.fn(),
}));

jest.mock('../services/userProjectAssignmentService', () => ({
  getAssignmentsForUser: jest.fn(),
}));

jest.mock('../services/groupService', () => ({
  getUserGroupNames: jest.fn().mockResolvedValue([]),
}));

jest.mock('../utils/superAdmin', () => ({
  isSuperAdminRequest: jest.fn().mockReturnValue(false),
}));

const { getHomeDashboard: mockGetHomeDashboard } = jest.requireMock(
  '../services/homeDashboardService',
) as { getHomeDashboard: jest.Mock };

const { getUserPermissions: mockGetUserPermissions } = jest.requireMock(
  '../services/rbacService',
) as { getUserPermissions: jest.Mock };

const { getAssignmentsForUser: mockGetAssignmentsForUser } = jest.requireMock(
  '../services/userProjectAssignmentService',
) as { getAssignmentsForUser: jest.Mock };

const { isSuperAdminRequest: mockIsSuperAdminRequest } = jest.requireMock(
  '../utils/superAdmin',
) as { isSuperAdminRequest: jest.Mock };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { profile: { oid: 'user-1', upn: 'dev@example.com' } };
    next();
  });
  app.use('/api/home-dashboard', homeDashboardRouter);
  return app;
}

/** Representative payload: two tiles authorized, three gated off inside the service. */
const payload: HomeDashboardPayload = {
  incompletePipeline: {
    status: 'ok',
    data: { groups: [], updatedAt: '2026-08-31T00:00:00Z' },
  },
  artifactCycleTime: null,
  myWork: null,
  openBugsOnPbis: null,
  devToProduction: {
    status: 'empty',
    data: { medianDays: null, sampleSize: 0, windowDays: 90 },
  },
};

describe('GET /api/home-dashboard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSuperAdminRequest.mockReturnValue(false);
    mockGetUserPermissions.mockResolvedValue(new Set(['home:view']));
    mockGetAssignmentsForUser.mockResolvedValue(['proj-alpha']);
    mockGetHomeDashboard.mockResolvedValue(payload);
  });

  it('TBI-001 DoD-1 / VT-04 forwards the authenticated user, project, and super-admin state', async () => {
    const res = await request(buildApp()).get('/api/home-dashboard?project=proj-alpha');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(mockGetHomeDashboard).toHaveBeenCalledWith({
      userId: 'user-1',
      project: 'proj-alpha',
      isSuperAdmin: false,
    });
  });

  it('PBI-001 AC-3 returns the service tile matrix unchanged, including null tiles', async () => {
    const res = await request(buildApp()).get('/api/home-dashboard?project=proj-alpha');

    expect(res.status).toBe(200);
    expect(res.body.artifactCycleTime).toBeNull();
    expect(res.body.myWork).toBeNull();
    expect(res.body.openBugsOnPbis).toBeNull();
    expect(res.body.incompletePipeline).toEqual(payload.incompletePipeline);
  });

  it('TBI-001 DoD-1 forwards super-admin state when the caller is a platform admin', async () => {
    mockIsSuperAdminRequest.mockReturnValue(true);

    const res = await request(buildApp()).get('/api/home-dashboard?project=proj-alpha');

    expect(res.status).toBe(200);
    expect(mockGetHomeDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ isSuperAdmin: true }),
    );
  });

  it('VT-12 returns 403 without home:view and never calls the service', async () => {
    mockGetUserPermissions.mockResolvedValue(new Set(['calendar:view']));

    const res = await request(buildApp()).get('/api/home-dashboard?project=proj-alpha');

    expect(res.status).toBe(403);
    expect(mockGetHomeDashboard).not.toHaveBeenCalled();
  });

  it('VT-16 returns 403 when the caller is not assigned to the project', async () => {
    mockGetAssignmentsForUser.mockResolvedValue(['proj-beta']);

    const res = await request(buildApp()).get('/api/home-dashboard?project=proj-alpha');

    expect(res.status).toBe(403);
    expect(mockGetHomeDashboard).not.toHaveBeenCalled();
  });

  it('TBI-001 DoD-1 rejects a request with no project before calling the service', async () => {
    const res = await request(buildApp()).get('/api/home-dashboard');

    expect(res.status).toBe(403);
    expect(mockGetHomeDashboard).not.toHaveBeenCalled();
  });

  it('TBI-001 DoD-1 returns 400 when a super admin omits the project', async () => {
    mockIsSuperAdminRequest.mockReturnValue(true);

    const res = await request(buildApp()).get('/api/home-dashboard');

    expect(res.status).toBe(400);
    expect(mockGetHomeDashboard).not.toHaveBeenCalled();
  });

  it('VT-20 returns 500 when the dashboard service fails', async () => {
    mockGetHomeDashboard.mockRejectedValue(new Error('dashboard unavailable'));

    const res = await request(buildApp()).get('/api/home-dashboard?project=proj-alpha');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch home dashboard' });
  });
});
