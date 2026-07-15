/**
 * Tests for GET /api/me/permissions — project-aware permission resolution.
 *
 * All heavy service dependencies of api.ts are mocked so the module loads
 * without a real database or Azure DevOps connection.
 */
import request from 'supertest';
import express from 'express';
import apiRouter from '../routes/api';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock('../services/azureDevOps', () => ({
  AzureDevOpsService: jest.fn().mockImplementation(() => ({
    getProjects: jest.fn().mockResolvedValue([]),
    getProjectTeams: jest.fn().mockResolvedValue([]),
    getWorkItems: jest.fn().mockResolvedValue([]),
    searchWorkItems: jest.fn().mockResolvedValue([]),
    getWorkItemById: jest.fn().mockResolvedValue(null),
  })),
}));

jest.mock('../../shared/utils/backlogId', () => ({
  generateBacklogId: jest.fn().mockReturnValue('BACK-001'),
}));

jest.mock('../utils/agentTokens', () => ({
  signAgentToken: jest.fn().mockResolvedValue('signed-token'),
}));

jest.mock('../services/featureAutoComplete', () => ({
  getFeatureAutoCompleteService: jest.fn().mockReturnValue({}),
}));

jest.mock('../services/deploymentTracking', () => ({
  DeploymentTrackingService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../services/agentEvalsPrResolutionService', () => ({
  getPrResolutionMetricsStats: jest.fn().mockResolvedValue([]),
}));

jest.mock('drizzle-orm', () => ({
  sql: jest.fn(),
  eq: jest.fn(),
  and: jest.fn(),
  or: jest.fn(),
  desc: jest.fn(),
  asc: jest.fn(),
  ne: jest.fn(),
  gte: jest.fn(),
  lte: jest.fn(),
  inArray: jest.fn(),
  isNull: jest.fn(),
  isNotNull: jest.fn(),
  relations: jest.fn().mockReturnValue({}),
  count: jest.fn(),
}));

jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: jest.fn().mockResolvedValue(null),
  getSkillConfigById: jest.fn().mockResolvedValue(null),
  resolveSkillConfig: jest.fn().mockResolvedValue(null),
  getSkillSettingsName: jest.fn().mockResolvedValue(null),
  listSkillConfigsForProject: jest.fn().mockResolvedValue([]),
  upsertSkillConfig: jest.fn(),
  deleteSkillConfig: jest.fn(),
  listSkillConfigs: jest.fn().mockResolvedValue([]),
  getAllSkillConfigs: jest.fn().mockResolvedValue([]),
}));

jest.mock('../middleware/rbac', () => ({
  requirePermission: (..._keys: string[]) =>
    (_req: any, _res: any, next: any) => next(),
  requireAnyPermission: (..._keys: string[]) =>
    (_req: any, _res: any, next: any) => next(),
  requireGroupMembership: (..._groups: string[]) =>
    (_req: any, _res: any, next: any) => next(),
  attachPermissions: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../services/rbacService', () => ({
  getUserPermissions: jest.fn().mockResolvedValue(new Set()),
  getUserRoleNames: jest.fn().mockResolvedValue([]),
  getChangelogPrefs: jest.fn().mockResolvedValue({
    lastSeenVersion: null,
    showOnLogin: true,
    dismissedBetaProdAnnouncement: false,
  }),
  listRoles: jest.fn().mockResolvedValue([]),
  createRole: jest.fn(),
  updateRole: jest.fn(),
  deleteRole: jest.fn(),
  assignRole: jest.fn(),
  removeRole: jest.fn(),
  updateRolePermissions: jest.fn(),
}));

jest.mock('../services/groupService', () => ({
  getUserGroupNames: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/changelogService', () => ({
  getChangelogPayload: jest.fn().mockResolvedValue({ entries: [] }),
  getCurrentChangelogVersion: jest.fn().mockResolvedValue('1.0.0'),
}));

jest.mock('../utils/superAdmin', () => ({
  isSuperAdminRequest: jest.fn().mockReturnValue(false),
}));

// ── App factory ────────────────────────────────────────────────────────────────

function buildApp(userOid?: string) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = userOid ? { profile: { oid: userOid } } : undefined;
    next();
  });
  app.use('/api', apiRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = err.status ?? 500;
    res.status(status).json({ error: err.message ?? 'Internal server error' });
  });
  return app;
}

// ── Mock references ────────────────────────────────────────────────────────────

const { getUserPermissions: mockGetUserPermissions } = jest.requireMock(
  '../services/rbacService',
) as { getUserPermissions: jest.Mock };

const { getUserGroupNames: mockGetUserGroupNames } = jest.requireMock(
  '../services/groupService',
) as { getUserGroupNames: jest.Mock };

// ── GET /api/me/permissions ────────────────────────────────────────────────────

describe('GET /api/me/permissions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls getUserPermissions without project when no query param is provided', async () => {
    mockGetUserPermissions.mockResolvedValue(new Set(['chat:create']));

    const res = await request(buildApp('user-1')).get('/api/me/permissions');

    expect(res.status).toBe(200);
    expect(mockGetUserPermissions).toHaveBeenCalledWith('user-1', undefined);
    expect(res.body.permissions).toContain('chat:create');
  });

  it('passes the project query param to getUserPermissions', async () => {
    mockGetUserPermissions.mockResolvedValue(new Set(['admin:roles']));

    const res = await request(buildApp('user-1')).get(
      '/api/me/permissions?project=MyProject',
    );

    expect(res.status).toBe(200);
    expect(mockGetUserPermissions).toHaveBeenCalledWith('user-1', 'MyProject');
    expect(res.body.permissions).toContain('admin:roles');
  });

  it('returns 401 when no user is authenticated', async () => {
    const res = await request(buildApp()).get('/api/me/permissions');

    expect(res.status).toBe(401);
    expect(mockGetUserPermissions).not.toHaveBeenCalled();
  });
});
