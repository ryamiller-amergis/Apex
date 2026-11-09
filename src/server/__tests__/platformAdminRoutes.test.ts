import request from 'supertest';
import express from 'express';
import platformAdminRouter from '../routes/platformAdmin';
import * as assignmentService from '../services/userProjectAssignmentService';
import * as menuSettingsService from '../services/menuSettingsService';
import * as projectCatalogService from '../services/projectCatalogService';
import * as projectAccessRequestService from '../services/projectAccessRequestService';
import * as groupService from '../services/groupService';
import { requireSuperAdmin } from '../middleware/rbac';
import {
  addDevEnvAllowlistEntry,
  DevEnvAllowlistError,
  getDevEnvAllowlistView,
  removeDevEnvAllowlistEntry,
} from '../services/devEnvAllowlistService';
import * as buildAccessService from '../services/buildAccessService';
import { BuildAccessError } from '../services/buildAccessService';

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

jest.mock('../services/devEnvAllowlistService', () => {
  class DevEnvAllowlistError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'DevEnvAllowlistError';
    }
  }
  return {
    DevEnvAllowlistError,
    getDevEnvAllowlistView: jest.fn(),
    addDevEnvAllowlistEntry: jest.fn(),
    removeDevEnvAllowlistEntry: jest.fn(),
  };
});

jest.mock('../services/buildAccessService', () => {
  class BuildAccessError extends Error {
    constructor(public readonly kind: string, message: string) {
      super(message);
      this.name = 'BuildAccessError';
    }
  }
  return {
    BuildAccessError,
    listBuildAllowlist: jest.fn(),
    listCandidateRepositories: jest.fn(),
    addBuildAllowlistEntry: jest.fn(),
    removeBuildAllowlistEntry: jest.fn(),
  };
});

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

jest.mock('../middleware/rbac', () => ({
  requireSuperAdmin: jest.fn((_req: any, _res: any, next: any) => next()),
}));

const mockAssignments = assignmentService as jest.Mocked<typeof assignmentService>;
const mockMenuSettings = menuSettingsService as jest.Mocked<typeof menuSettingsService>;
const mockProjectCatalog = projectCatalogService as jest.Mocked<typeof projectCatalogService>;
const mockProjectAccessRequests = projectAccessRequestService as jest.Mocked<typeof projectAccessRequestService>;
const mockGroupService = groupService as jest.Mocked<typeof groupService>;
const mockRequireSuperAdmin = requireSuperAdmin as jest.Mock;
const mockGetDevEnvAllowlistView = getDevEnvAllowlistView as jest.MockedFunction<typeof getDevEnvAllowlistView>;
const mockAddDevEnvAllowlistEntry = addDevEnvAllowlistEntry as jest.MockedFunction<typeof addDevEnvAllowlistEntry>;
const mockRemoveDevEnvAllowlistEntry = removeDevEnvAllowlistEntry as jest.MockedFunction<typeof removeDevEnvAllowlistEntry>;
const mockBuildAccess = buildAccessService as jest.Mocked<typeof buildAccessService>;

function buildApp(userProfile: Record<string, unknown> = { oid: 'super-admin', displayName: 'Platform Admin' }) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = { profile: userProfile };
    next();
  });
  app.use('/api/platform-admin', platformAdminRouter);
  return app;
}

const assignmentRows = [
  {
    id: 'assignment-1',
    userId: 'user-1',
    displayName: 'Alice',
    email: 'alice@example.com',
    project: 'MaxView',
    assignedBy: 'super-admin',
    assignedAt: '2026-06-12T12:00:00Z',
  },
  {
    id: 'assignment-2',
    userId: 'user-2',
    displayName: 'Bob',
    email: 'bob@example.com',
    project: 'MatterWorx',
    assignedBy: 'super-admin',
    assignedAt: '2026-06-12T12:00:00Z',
  },
];

describe('platformAdminRouter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssignments.groupAssignmentsByProject.mockImplementation((assignments) => {
      const grouped = new Map<string, { project: string; users: { userId: string; displayName: string; email: string }[] }>();
      for (const assignment of assignments) {
        const group = grouped.get(assignment.project) ?? { project: assignment.project, users: [] };
        group.users.push({
          userId: assignment.userId,
          displayName: assignment.displayName,
          email: assignment.email,
        });
        grouped.set(assignment.project, group);
      }
      return [...grouped.values()];
    });
  });

  it('runs the super-admin guard for platform admin routes', async () => {
    mockRequireSuperAdmin.mockImplementationOnce((_req, res, _next) => {
      res.status(403).json({ error: 'Forbidden' });
    });

    const res = await request(buildApp()).get('/api/platform-admin/assignments');

    expect(res.status).toBe(403);
    expect(mockRequireSuperAdmin).toHaveBeenCalledTimes(1);
    expect(mockAssignments.getAllAssignments).not.toHaveBeenCalled();
  });

  describe('GET /api/platform-admin/projects', () => {
    it('returns the full project catalog for platform admins', async () => {
      mockProjectCatalog.listProjectCatalog.mockResolvedValue([
        { id: 'apex-virtual', name: 'Apex', description: 'Virtual project' },
        { id: 'ado-1', name: 'MaxView', description: 'ADO project' },
        { id: 'project-support-ops', name: 'Support Ops', description: '' },
      ]);

      const res = await request(buildApp()).get('/api/platform-admin/projects');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        projects: [
          { id: 'apex-virtual', name: 'Apex', description: 'Virtual project' },
          { id: 'ado-1', name: 'MaxView', description: 'ADO project' },
          { id: 'project-support-ops', name: 'Support Ops', description: '' },
        ],
      });
      expect(mockProjectCatalog.listProjectCatalog).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /api/platform-admin/assignments', () => {
    it('returns grouped assignments', async () => {
      mockAssignments.getAllAssignments.mockResolvedValue(assignmentRows);

      const res = await request(buildApp()).get('/api/platform-admin/assignments');

      expect(res.status).toBe(200);
      expect(res.body.assignments).toEqual([
        { project: 'MaxView', users: [{ userId: 'user-1', displayName: 'Alice', email: 'alice@example.com' }] },
        { project: 'MatterWorx', users: [{ userId: 'user-2', displayName: 'Bob', email: 'bob@example.com' }] },
      ]);
    });
  });

  describe('GET /api/platform-admin/users', () => {
    it('returns known application users', async () => {
      mockAssignments.listKnownApplicationUsers.mockResolvedValue([
        { userId: 'user-1', displayName: 'Alice', email: 'alice@example.com' },
        { userId: 'user-2', displayName: 'Bob', email: 'bob@example.com' },
      ]);

      const res = await request(buildApp()).get('/api/platform-admin/users');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        users: [
          { userId: 'user-1', displayName: 'Alice', email: 'alice@example.com' },
          { userId: 'user-2', displayName: 'Bob', email: 'bob@example.com' },
        ],
      });
    });
  });

  describe('GET /api/platform-admin/groups', () => {
    it('returns platform groups for targeting pickers', async () => {
      mockGroupService.listGroups.mockResolvedValue([
        {
          id: 'group-1',
          name: 'Developer',
          description: null,
          project: 'MaxView',
          isDefault: true,
          createdBy: null,
          createdAt: '2026-06-30T00:00:00Z',
        },
        {
          id: 'group-2',
          name: 'Developer',
          description: null,
          project: 'Apex',
          isDefault: true,
          createdBy: null,
          createdAt: '2026-06-30T00:00:00Z',
        },
        {
          id: 'group-3',
          name: 'QA',
          description: null,
          project: 'MaxView',
          isDefault: true,
          createdBy: null,
          createdAt: '2026-06-30T00:00:00Z',
        },
      ]);

      const res = await request(buildApp()).get('/api/platform-admin/groups');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        groups: [
          { id: 'group-1', name: 'Developer', project: 'MaxView' },
          { id: 'group-2', name: 'Developer', project: 'Apex' },
          { id: 'group-3', name: 'QA', project: 'MaxView' },
        ],
      });
      expect(mockGroupService.listGroups).toHaveBeenCalledTimes(1);
    });

    it('returns 500 when listGroups throws', async () => {
      mockGroupService.listGroups.mockRejectedValue(new Error('DB error'));

      const res = await request(buildApp()).get('/api/platform-admin/groups');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('access request review routes', () => {
    const accessRequest = {
      id: 'request-1',
      userId: 'user-1',
      displayName: 'Alice',
      email: 'alice@example.com',
      project: 'MaxView',
      status: 'pending' as const,
      requestedAt: '2026-06-12T12:00:00Z',
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
    };

    it('returns pending access requests by default', async () => {
      mockProjectAccessRequests.listPlatformAdminAccessRequests.mockResolvedValue([accessRequest]);

      const res = await request(buildApp()).get('/api/platform-admin/access-requests');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ requests: [accessRequest] });
      expect(mockProjectAccessRequests.listPlatformAdminAccessRequests).toHaveBeenCalledWith('pending');
    });

    it('approves an access request with the acting admin id', async () => {
      mockProjectAccessRequests.approveProjectAccessRequest.mockResolvedValue({
        ...accessRequest,
        status: 'approved',
        reviewedBy: 'admin-oid',
        reviewedAt: '2026-06-12T13:00:00Z',
      });

      const res = await request(buildApp({ oid: 'admin-oid' }))
        .post('/api/platform-admin/access-requests/request-1/approve')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('approved');
      expect(mockProjectAccessRequests.approveProjectAccessRequest).toHaveBeenCalledWith('request-1', 'admin-oid', null);
    });

    it('rejects an access request without assigning the user', async () => {
      mockProjectAccessRequests.rejectProjectAccessRequest.mockResolvedValue({
        ...accessRequest,
        status: 'rejected',
        reviewedBy: 'admin-oid',
        reviewedAt: '2026-06-12T13:00:00Z',
      });

      const res = await request(buildApp({ oid: 'admin-oid' }))
        .post('/api/platform-admin/access-requests/request-1/reject')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('rejected');
      expect(mockProjectAccessRequests.rejectProjectAccessRequest).toHaveBeenCalledWith('request-1', 'admin-oid', null);
    });
  });

  describe('GET /api/platform-admin/assignments/:project', () => {
    it('returns users assigned to one project', async () => {
      mockAssignments.getAssignmentsForProject.mockResolvedValue([assignmentRows[0]]);

      const res = await request(buildApp()).get('/api/platform-admin/assignments/MaxView');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        project: 'MaxView',
        users: [{ userId: 'user-1', displayName: 'Alice', email: 'alice@example.com' }],
      });
    });

    it('returns an empty group when the project has no assignments', async () => {
      mockAssignments.getAssignmentsForProject.mockResolvedValue([]);

      const res = await request(buildApp()).get('/api/platform-admin/assignments/MaxView');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ project: 'MaxView', users: [] });
    });
  });

  describe('PUT /api/platform-admin/assignments/:project', () => {
    it('replaces project assignments and returns 204', async () => {
      mockAssignments.bulkSetProjectAssignments.mockResolvedValue(undefined);

      const res = await request(buildApp({ oid: 'admin-oid' }))
        .put('/api/platform-admin/assignments/MaxView')
        .send({ userIds: ['user-1', 'user-2'] });

      expect(res.status).toBe(204);
      expect(mockAssignments.bulkSetProjectAssignments).toHaveBeenCalledWith('MaxView', ['user-1', 'user-2'], 'admin-oid');
    });

    it('returns 400 when userIds is not an array of non-empty strings', async () => {
      const res = await request(buildApp())
        .put('/api/platform-admin/assignments/MaxView')
        .send({ userIds: ['user-1', ''] });

      expect(res.status).toBe(400);
      expect(mockAssignments.bulkSetProjectAssignments).not.toHaveBeenCalled();
    });

    it('allows an empty userIds array to clear project assignments', async () => {
      mockAssignments.bulkSetProjectAssignments.mockResolvedValue(undefined);

      const res = await request(buildApp({ oid: 'admin-oid' }))
        .put('/api/platform-admin/assignments/MaxView')
        .send({ userIds: [] });

      expect(res.status).toBe(204);
      expect(mockAssignments.bulkSetProjectAssignments).toHaveBeenCalledWith('MaxView', [], 'admin-oid');
    });
  });

  describe('GET /api/platform-admin/menu-settings', () => {
    it('returns all menu configs', async () => {
      mockMenuSettings.listMenuConfigs.mockResolvedValue([
        { project: 'MaxView', enabledViews: ['calendar'], updatedBy: 'Admin' },
      ]);

      const res = await request(buildApp()).get('/api/platform-admin/menu-settings');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ configs: [{ project: 'MaxView', enabledViews: ['calendar'], updatedBy: 'Admin' }] });
    });
  });

  describe('GET /api/platform-admin/menu-settings/:project', () => {
    it('returns one menu config', async () => {
      mockMenuSettings.getMenuConfig.mockResolvedValue({ project: 'MaxView', enabledViews: ['planning'], updatedBy: null });

      const res = await request(buildApp()).get('/api/platform-admin/menu-settings/MaxView');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ project: 'MaxView', enabledViews: ['planning'], updatedBy: null });
    });

    it('returns 404 when the project has no menu config', async () => {
      mockMenuSettings.getMenuConfig.mockResolvedValue(null);

      const res = await request(buildApp()).get('/api/platform-admin/menu-settings/Unknown');

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/platform-admin/menu-settings/:project', () => {
    it('upserts enabled menu views with the acting user label', async () => {
      mockMenuSettings.upsertMenuConfig.mockResolvedValue({
        project: 'MaxView',
        enabledViews: ['calendar', 'backlog'],
        updatedBy: 'Platform Admin',
      });

      const res = await request(buildApp({ oid: 'admin-oid', displayName: 'Platform Admin' }))
        .put('/api/platform-admin/menu-settings/MaxView')
        .send({ enabledViews: ['calendar', 'backlog'] });

      expect(res.status).toBe(200);
      expect(mockMenuSettings.upsertMenuConfig).toHaveBeenCalledWith(
        'MaxView',
        ['calendar', 'backlog'],
        'Platform Admin',
      );
      expect(res.body.enabledViews).toEqual(['calendar', 'backlog']);
    });

    it('returns 400 when enabledViews contains invalid keys', async () => {
      const res = await request(buildApp())
        .put('/api/platform-admin/menu-settings/MaxView')
        .send({ enabledViews: ['calendar', 'not-real'] });

      expect(res.status).toBe(400);
      expect(mockMenuSettings.upsertMenuConfig).not.toHaveBeenCalled();
    });

    it('accepts ui-lab as a valid menu item key', async () => {
      mockMenuSettings.upsertMenuConfig.mockResolvedValue({
        project: 'MaxView',
        enabledViews: ['calendar', 'ui-lab'],
        updatedBy: 'Platform Admin',
      });

      const res = await request(buildApp({ oid: 'admin-oid', displayName: 'Platform Admin' }))
        .put('/api/platform-admin/menu-settings/MaxView')
        .send({ enabledViews: ['calendar', 'ui-lab'] });

      expect(res.status).toBe(200);
      expect(mockMenuSettings.upsertMenuConfig).toHaveBeenCalledWith(
        'MaxView',
        ['calendar', 'ui-lab'],
        'Platform Admin',
      );
    });

    it('PBI-001 AC-0 / VT-06: accepts diagrams as a valid menu item key', async () => {
      mockMenuSettings.upsertMenuConfig.mockResolvedValue({
        project: 'MaxView',
        enabledViews: ['calendar', 'diagrams'],
        updatedBy: 'Platform Admin',
      });

      const res = await request(buildApp({ oid: 'admin-oid', displayName: 'Platform Admin' }))
        .put('/api/platform-admin/menu-settings/MaxView')
        .send({ enabledViews: ['calendar', 'diagrams'] });

      expect(res.status).toBe(200);
      expect(mockMenuSettings.upsertMenuConfig).toHaveBeenCalledWith(
        'MaxView',
        ['calendar', 'diagrams'],
        'Platform Admin',
      );
      expect(res.body.enabledViews).toContain('diagrams');
    });

    it('FEAT-002 VT-14: accepts builds as a valid menu item key', async () => {
      mockMenuSettings.upsertMenuConfig.mockResolvedValue({
        project: 'Apex',
        enabledViews: ['builds'],
        updatedBy: 'Platform Admin',
      });

      const ok = await request(buildApp({ oid: 'admin-oid', displayName: 'Platform Admin' }))
        .put('/api/platform-admin/menu-settings/Apex')
        .send({ enabledViews: ['builds'] });
      expect(ok.status).toBe(200);
      expect(mockMenuSettings.upsertMenuConfig).toHaveBeenCalledWith('Apex', ['builds'], 'Platform Admin');

      const bad = await request(buildApp())
        .put('/api/platform-admin/menu-settings/Apex')
        .send({ enabledViews: ['not-a-key'] });
      expect(bad.status).toBe(400);
    });

    it('PBI-001 AC-1 / VT-07: persistence failure leaves prior enabledViews unchanged', async () => {
      mockMenuSettings.upsertMenuConfig.mockRejectedValue(new Error('db down'));

      const res = await request(buildApp({ oid: 'admin-oid', displayName: 'Platform Admin' }))
        .put('/api/platform-admin/menu-settings/MaxView')
        .send({ enabledViews: ['calendar', 'diagrams'] });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(mockMenuSettings.getMenuConfig).not.toHaveBeenCalled();
    });
  });

  describe('dev access list', () => {
    it('returns the list for platform admins', async () => {
      mockGetDevEnvAllowlistView.mockResolvedValue({
        environment: 'dev',
        managesDevAccess: true,
        entries: [{
          id: '11111111-1111-1111-1111-111111111111',
          email: 'person@example.com',
          createdBy: 'Ada',
          createdAt: '2026-09-28T12:00:00.000Z',
        }],
      });

      const res = await request(buildApp()).get('/api/platform-admin/dev-access');

      expect(res.status).toBe(200);
      expect(res.body.managesDevAccess).toBe(true);
      expect(res.body.entries).toHaveLength(1);
    });

    it('adds an email and records who added it', async () => {
      mockAddDevEnvAllowlistEntry.mockResolvedValue({
        id: '11111111-1111-1111-1111-111111111111',
        email: 'person@example.com',
        createdBy: 'Platform Admin',
        createdAt: '2026-09-28T12:00:00.000Z',
      });

      const res = await request(buildApp())
        .post('/api/platform-admin/dev-access')
        .send({ email: 'person@example.com' });

      expect(res.status).toBe(201);
      expect(mockAddDevEnvAllowlistEntry).toHaveBeenCalledWith('person@example.com', 'Platform Admin');
    });

    it('returns the service error when an email cannot be added', async () => {
      mockAddDevEnvAllowlistEntry.mockRejectedValue(
        new DevEnvAllowlistError('That email is already on the dev access list'),
      );

      const res = await request(buildApp())
        .post('/api/platform-admin/dev-access')
        .send({ email: 'person@example.com' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/already on the dev access list/);
    });

    it('removes an email', async () => {
      mockRemoveDevEnvAllowlistEntry.mockResolvedValue(undefined);

      const res = await request(buildApp())
        .delete('/api/platform-admin/dev-access/11111111-1111-1111-1111-111111111111');

      expect(res.status).toBe(204);
      expect(mockRemoveDevEnvAllowlistEntry).toHaveBeenCalledWith(
        '11111111-1111-1111-1111-111111111111',
      );
    });
  });

  describe('build allow-list (FEAT-002 PBI-002)', () => {
    const entryId = '22222222-2222-2222-2222-222222222222';
    const entry = {
      id: entryId,
      project: 'Apex',
      repository: 'Apex',
      createdBy: 'Platform Admin',
      createdAt: '2026-10-23T12:00:00.000Z',
    };

    it('VT-02 adds a pair with the acting user and then lists it', async () => {
      mockBuildAccess.addBuildAllowlistEntry.mockResolvedValue(entry);
      mockBuildAccess.listBuildAllowlist.mockResolvedValue([entry]);

      const post = await request(buildApp({ oid: 'admin-oid', displayName: 'Platform Admin' }))
        .post('/api/platform-admin/build-allowlist')
        .send({ project: 'Apex', repository: 'apex' });
      expect(post.status).toBe(201);
      expect(post.body).toEqual(entry);
      expect(mockBuildAccess.addBuildAllowlistEntry).toHaveBeenCalledWith({
        project: 'Apex',
        repository: 'apex',
        actor: { id: 'admin-oid', label: 'Platform Admin' },
      });

      const get = await request(buildApp()).get('/api/platform-admin/build-allowlist');
      expect(get.status).toBe(200);
      expect(get.body).toEqual({ entries: [entry] });
    });

    it('VT-03 maps INVALID to 400 and DUPLICATE to 409 with the plain message', async () => {
      mockBuildAccess.addBuildAllowlistEntry.mockRejectedValueOnce(
        new BuildAccessError('INVALID', 'That repository is not configured for this project.'),
      );
      const invalid = await request(buildApp())
        .post('/api/platform-admin/build-allowlist')
        .send({ project: 'Apex', repository: 'Other' });
      expect(invalid.status).toBe(400);
      expect(invalid.body).toEqual({ error: 'That repository is not configured for this project.' });

      mockBuildAccess.addBuildAllowlistEntry.mockRejectedValueOnce(
        new BuildAccessError('DUPLICATE', 'That repository is already approved for builds in this project.'),
      );
      const dup = await request(buildApp())
        .post('/api/platform-admin/build-allowlist')
        .send({ project: 'Apex', repository: 'Apex' });
      expect(dup.status).toBe(409);
    });

    it('passes non-string input through as blank so the service refuses it', async () => {
      mockBuildAccess.addBuildAllowlistEntry.mockRejectedValueOnce(
        new BuildAccessError('INVALID', 'Choose a project and a repository.'),
      );
      const res = await request(buildApp())
        .post('/api/platform-admin/build-allowlist')
        .send({ project: 7, repository: null });
      expect(res.status).toBe(400);
      expect(mockBuildAccess.addBuildAllowlistEntry).toHaveBeenCalledWith(
        expect.objectContaining({ project: '', repository: '' }),
      );
    });

    it('returns 500 for unexpected service errors', async () => {
      mockBuildAccess.addBuildAllowlistEntry.mockRejectedValueOnce(new Error('db down'));
      const res = await request(buildApp())
        .post('/api/platform-admin/build-allowlist')
        .send({ project: 'Apex', repository: 'Apex' });
      expect(res.status).toBe(500);
    });

    it('removes a pair with the acting user; maps NOT_FOUND to 404 and INVALID to 400', async () => {
      mockBuildAccess.removeBuildAllowlistEntry.mockResolvedValueOnce(undefined);
      const ok = await request(buildApp({ oid: 'admin-oid', displayName: 'Platform Admin' }))
        .delete(`/api/platform-admin/build-allowlist/${entryId}`);
      expect(ok.status).toBe(204);
      expect(mockBuildAccess.removeBuildAllowlistEntry).toHaveBeenCalledWith(entryId, {
        id: 'admin-oid',
        label: 'Platform Admin',
      });

      mockBuildAccess.removeBuildAllowlistEntry.mockRejectedValueOnce(
        new BuildAccessError('NOT_FOUND', 'That approved repository no longer exists.'),
      );
      const missing = await request(buildApp()).delete(`/api/platform-admin/build-allowlist/${entryId}`);
      expect(missing.status).toBe(404);

      mockBuildAccess.removeBuildAllowlistEntry.mockRejectedValueOnce(
        new BuildAccessError('INVALID', 'That approved repository id is not valid.'),
      );
      const bad = await request(buildApp()).delete('/api/platform-admin/build-allowlist/nope');
      expect(bad.status).toBe(400);
    });

    it('lists candidate repositories for a project and requires the project', async () => {
      mockBuildAccess.listCandidateRepositories.mockResolvedValue(['Apex', 'org/web']);
      const ok = await request(buildApp()).get('/api/platform-admin/build-allowlist/repositories?project=Apex');
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ repositories: ['Apex', 'org/web'] });
      expect(mockBuildAccess.listCandidateRepositories).toHaveBeenCalledWith('Apex');

      const blank = await request(buildApp()).get('/api/platform-admin/build-allowlist/repositories?project=%20');
      expect(blank.status).toBe(400);
    });

    it('VT-05 a Project Admin who is not a super admin gets 403 and nothing changes', async () => {
      const refuse = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
        res.status(403).json({ error: 'Forbidden' });
      };
      const app = buildApp({ oid: 'project-admin', displayName: 'Project Admin' });

      mockRequireSuperAdmin.mockImplementationOnce(refuse);
      const get = await request(app).get('/api/platform-admin/build-allowlist');
      mockRequireSuperAdmin.mockImplementationOnce(refuse);
      const post = await request(app).post('/api/platform-admin/build-allowlist').send({ project: 'Apex', repository: 'Apex' });
      mockRequireSuperAdmin.mockImplementationOnce(refuse);
      const del = await request(app).delete(`/api/platform-admin/build-allowlist/${entryId}`);

      expect([get.status, post.status, del.status]).toEqual([403, 403, 403]);
      expect(mockBuildAccess.listBuildAllowlist).not.toHaveBeenCalled();
      expect(mockBuildAccess.addBuildAllowlistEntry).not.toHaveBeenCalled();
      expect(mockBuildAccess.removeBuildAllowlistEntry).not.toHaveBeenCalled();
    });
  });
});
