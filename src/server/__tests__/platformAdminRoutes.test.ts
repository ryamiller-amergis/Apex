import request from 'supertest';
import express from 'express';
import platformAdminRouter from '../routes/platformAdmin';
import * as assignmentService from '../services/userProjectAssignmentService';
import * as menuSettingsService from '../services/menuSettingsService';
import * as projectCatalogService from '../services/projectCatalogService';
import * as projectAccessRequestService from '../services/projectAccessRequestService';
import * as groupService from '../services/groupService';
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

jest.mock('../middleware/rbac', () => ({
  requireSuperAdmin: jest.fn((_req: any, _res: any, next: any) => next()),
}));

const mockAssignments = assignmentService as jest.Mocked<typeof assignmentService>;
const mockMenuSettings = menuSettingsService as jest.Mocked<typeof menuSettingsService>;
const mockProjectCatalog = projectCatalogService as jest.Mocked<typeof projectCatalogService>;
const mockProjectAccessRequests = projectAccessRequestService as jest.Mocked<typeof projectAccessRequestService>;
const mockGroupService = groupService as jest.Mocked<typeof groupService>;
const mockRequireSuperAdmin = requireSuperAdmin as jest.Mock;

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
  });
});
