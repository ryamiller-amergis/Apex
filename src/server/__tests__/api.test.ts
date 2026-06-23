import request from 'supertest';
import express from 'express';
import apiRouter from '../routes/api';
import { AzureDevOpsService } from '../services/azureDevOps';
import * as userProjectAssignmentService from '../services/userProjectAssignmentService';
import * as projectCatalogService from '../services/projectCatalogService';
import * as projectAccessRequestService from '../services/projectAccessRequestService';

// Mock the AzureDevOpsService
jest.mock('../services/azureDevOps');

jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: jest.fn(),
}));

jest.mock('../services/userProjectAssignmentService', () => ({
  ensureUserProjectAssignment: jest.fn(),
  getAssignmentsForUser: jest.fn(),
}));

jest.mock('../services/projectCatalogService', () => ({
  filterProjectCatalogByNames: jest.fn((catalog, projectNames) => {
    const requested = new Set(projectNames.map((project: string) => project.toLowerCase()));
    return catalog.filter((project: { name: string }) => requested.has(project.name.toLowerCase()));
  }),
  listProjectCatalog: jest.fn(),
}));

jest.mock('../services/projectAccessRequestService', () => ({
  createProjectAccessRequests: jest.fn(),
  listCurrentUserAccessRequests: jest.fn(),
  listRequestableProjectsForUser: jest.fn(),
}));

const mockAssignmentService = userProjectAssignmentService as jest.Mocked<typeof userProjectAssignmentService>;
const mockProjectCatalogService = projectCatalogService as jest.Mocked<typeof projectCatalogService>;
const mockProjectAccessRequestService = projectAccessRequestService as jest.Mocked<typeof projectAccessRequestService>;

describe('API Routes', () => {
  let app: express.Application;
  let mockAdoService: jest.Mocked<AzureDevOpsService>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Create Express app with the API router
    app = express();
    app.use(express.json());
    app.use('/api', apiRouter);

    // Create mock service instance
    mockAdoService = {
      getProjects: jest.fn(),
      getWorkItems: jest.fn(),
      updateDueDate: jest.fn(),
      updateWorkItemField: jest.fn(),
      calculateCycleTimeForItems: jest.fn(),
      healthCheck: jest.fn(),
    } as any;

    // Mock the constructor to return our mock instance
    (AzureDevOpsService as jest.MockedClass<typeof AzureDevOpsService>).mockImplementation(() => mockAdoService);
  });

  function buildAppWithUser(profile: Record<string, unknown>) {
    const userApp = express();
    userApp.use(express.json());
    userApp.use((req: any, _res: any, next: any) => {
      req.user = { profile };
      next();
    });
    userApp.use('/api', apiRouter);
    return userApp;
  }

  describe('GET /api/projects', () => {
    const fullCatalog = [
      { id: 'apex-virtual', name: 'Apex', description: 'Virtual project' },
      { id: '2', name: 'MatterWorx', description: 'MatterWorx project' },
      { id: '1', name: 'MaxView', description: 'MaxView project' },
      { id: '3', name: 'Other', description: 'ADO project beyond legacy allowlist' },
      { id: 'project-support-ops', name: 'Support Ops', description: '' },
    ];

    beforeEach(() => {
      mockProjectCatalogService.listProjectCatalog.mockResolvedValue(fullCatalog);
      mockAssignmentService.getAssignmentsForUser.mockResolvedValue([]);
    });

    it('returns the full project catalog for super admins', async () => {
      const response = await request(buildAppWithUser({ oid: 'admin-oid', upn: 'ryamiller@amergis.com' }))
        .get('/api/projects')
        .expect(200);

      expect(response.body).toEqual(fullCatalog);
      expect(mockProjectCatalogService.listProjectCatalog).toHaveBeenCalledTimes(1);
      expect(mockAssignmentService.getAssignmentsForUser).not.toHaveBeenCalled();
    });

    it('filters non-super-admin projects by DB assignments', async () => {
      mockAssignmentService.getAssignmentsForUser.mockResolvedValue(['MatterWorx']);

      const response = await request(buildAppWithUser({ oid: 'user-1', upn: 'user@example.com' }))
        .get('/api/projects')
        .expect(200);

      expect(response.body.map((project: any) => project.name)).toEqual(['MatterWorx']);
      expect(mockAssignmentService.getAssignmentsForUser).toHaveBeenCalledWith('user-1');
      expect(mockProjectCatalogService.listProjectCatalog).toHaveBeenCalledTimes(1);
    });

    it('includes assigned non-ADO projects for regular users', async () => {
      mockAssignmentService.getAssignmentsForUser.mockResolvedValue(['Support Ops', 'Apex']);

      const response = await request(buildAppWithUser({ oid: 'user-1', upn: 'user@example.com' }))
        .get('/api/projects')
        .expect(200);

      expect(response.body.map((project: any) => project.name)).toEqual(['Apex', 'Support Ops']);
      expect(mockProjectCatalogService.listProjectCatalog).toHaveBeenCalledTimes(1);
    });

    it('returns no projects for unassigned users', async () => {
      mockAssignmentService.getAssignmentsForUser.mockResolvedValue([]);

      const response = await request(buildAppWithUser({ oid: 'user-1', upn: 'user@example.com' }))
        .get('/api/projects')
        .expect(200);

      expect(response.body).toEqual([]);
      expect(mockProjectCatalogService.listProjectCatalog).not.toHaveBeenCalled();
    });
  });

  describe('project access request routes', () => {
    const profile = { oid: 'user-1', upn: 'user@example.com' };

    it('returns requestable projects for the current user', async () => {
      mockProjectAccessRequestService.listRequestableProjectsForUser.mockResolvedValue([
        { id: 'project-apex', name: 'Apex', description: 'Non-ADO project' },
      ]);

      const response = await request(buildAppWithUser(profile))
        .get('/api/project-access-requests/catalog')
        .expect(200);

      expect(response.body).toEqual({
        projects: [{ id: 'project-apex', name: 'Apex', description: 'Non-ADO project' }],
      });
      expect(mockProjectAccessRequestService.listRequestableProjectsForUser).toHaveBeenCalledWith('user-1');
    });

    it('creates project access requests for multiple projects', async () => {
      mockProjectAccessRequestService.createProjectAccessRequests.mockResolvedValue([
        {
          id: 'request-1',
          userId: 'user-1',
          project: 'MaxView',
          status: 'pending',
          requestedAt: '2026-06-12T12:00:00Z',
          reviewedBy: null,
          reviewedAt: null,
          reviewNote: null,
        },
      ]);

      const response = await request(buildAppWithUser(profile))
        .post('/api/project-access-requests')
        .send({ projects: ['MaxView', 'Apex'] })
        .expect(201);

      expect(response.body.requests).toHaveLength(1);
      expect(mockProjectAccessRequestService.createProjectAccessRequests).toHaveBeenCalledWith('user-1', ['MaxView', 'Apex']);
    });

    it('returns 401 when access request routes are called without authentication', async () => {
      const response = await request(app)
        .get('/api/project-access-requests/me')
        .expect(401);

      expect(response.body).toEqual({ error: 'Unauthorized' });
      expect(mockProjectAccessRequestService.listCurrentUserAccessRequests).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/projects/:project/select', () => {
    const profile = { oid: 'user-1', upn: 'user@example.com' };

    it('records the project selection and returns 204', async () => {
      mockAssignmentService.ensureUserProjectAssignment.mockResolvedValue(undefined);

      await request(buildAppWithUser(profile))
        .post('/api/projects/MaxView/select')
        .expect(204);

      expect(mockAssignmentService.ensureUserProjectAssignment).toHaveBeenCalledWith(
        'user-1',
        'MaxView',
        'auto-select',
      );
    });

    it('handles URL-encoded project names', async () => {
      mockAssignmentService.ensureUserProjectAssignment.mockResolvedValue(undefined);

      await request(buildAppWithUser(profile))
        .post('/api/projects/Support%20Ops/select')
        .expect(204);

      expect(mockAssignmentService.ensureUserProjectAssignment).toHaveBeenCalledWith(
        'user-1',
        'Support Ops',
        'auto-select',
      );
    });

    it('returns 401 when unauthenticated', async () => {
      await request(app)
        .post('/api/projects/MaxView/select')
        .expect(401);

      expect(mockAssignmentService.ensureUserProjectAssignment).not.toHaveBeenCalled();
    });

    it('returns 500 when the service throws', async () => {
      mockAssignmentService.ensureUserProjectAssignment.mockRejectedValue(new Error('DB error'));

      await request(buildAppWithUser(profile))
        .post('/api/projects/MaxView/select')
        .expect(500);
    });
  });

  describe('GET /api/workitems', () => {
    it('should fetch work items without filters', async () => {
      const mockWorkItems = [
        {
          id: 1,
          title: 'Test Item 1',
          state: 'New',
          workItemType: 'Product Backlog Item',
          changedDate: '2024-01-01T00:00:00Z',
          createdDate: '2024-01-01T00:00:00Z',
          areaPath: 'TestProject\\TestArea',
          iterationPath: 'TestProject\\Sprint 1',
        },
        {
          id: 2,
          title: 'Test Item 2',
          state: 'In Progress',
          workItemType: 'Product Backlog Item',
          changedDate: '2024-01-02T00:00:00Z',
          createdDate: '2024-01-02T00:00:00Z',
          areaPath: 'TestProject\\TestArea',
          iterationPath: 'TestProject\\Sprint 1',
        },
      ];

      mockAdoService.getWorkItems.mockResolvedValue(mockWorkItems as any);

      const response = await request(app)
        .get('/api/workitems')
        .expect(200);

      expect(response.body).toEqual(mockWorkItems);
      expect(mockAdoService.getWorkItems).toHaveBeenCalledWith(undefined, undefined);
    });

    it('should fetch work items with date range', async () => {
      const mockWorkItems = [{ id: 1, title: 'Test Item' }];
      mockAdoService.getWorkItems.mockResolvedValue(mockWorkItems as any);

      const response = await request(app)
        .get('/api/workitems')
        .query({ from: '2024-01-01', to: '2024-01-31' })
        .expect(200);

      expect(response.body).toEqual(mockWorkItems);
      expect(mockAdoService.getWorkItems).toHaveBeenCalledWith('2024-01-01', '2024-01-31');
    });

    it('should fetch work items with project and area path', async () => {
      const mockWorkItems = [{ id: 1, title: 'Test Item' }];
      mockAdoService.getWorkItems.mockResolvedValue(mockWorkItems as any);

      await request(app)
        .get('/api/workitems')
        .query({ project: 'CustomProject', areaPath: 'CustomArea' })
        .expect(200);

      expect(AzureDevOpsService).toHaveBeenCalledWith('CustomProject', 'CustomArea');
    });

    it('should handle errors gracefully', async () => {
      mockAdoService.getWorkItems.mockRejectedValue(new Error('API Error'));

      const response = await request(app)
        .get('/api/workitems')
        .expect(500);

      expect(response.body).toEqual({ error: 'Failed to fetch work items' });
    });
  });

  describe('PATCH /api/workitems/:id/due-date', () => {
    it('should update due date successfully', async () => {
      mockAdoService.updateDueDate.mockResolvedValue();

      const response = await request(app)
        .patch('/api/workitems/123/due-date')
        .send({ dueDate: '2024-03-15', reason: 'Client request' })
        .expect(200);

      expect(response.body).toEqual({ success: true });
      expect(mockAdoService.updateDueDate).toHaveBeenCalledWith(123, '2024-03-15', 'Client request');
    });

    it('should clear due date when null is provided', async () => {
      mockAdoService.updateDueDate.mockResolvedValue();

      await request(app)
        .patch('/api/workitems/123/due-date')
        .send({ dueDate: null })
        .expect(200);

      expect(mockAdoService.updateDueDate).toHaveBeenCalledWith(123, null, undefined);
    });

    it('should reject invalid work item ID', async () => {
      const response = await request(app)
        .patch('/api/workitems/invalid/due-date')
        .send({ dueDate: '2024-03-15' })
        .expect(400);

      expect(response.body).toEqual({ error: 'Invalid work item ID' });
    });

    it('should reject invalid date format', async () => {
      const response = await request(app)
        .patch('/api/workitems/123/due-date')
        .send({ dueDate: '15-03-2024' })
        .expect(400);

      expect(response.body).toEqual({ error: 'Invalid date format. Use YYYY-MM-DD' });
    });

    it('should use custom project and area path', async () => {
      mockAdoService.updateDueDate.mockResolvedValue();

      await request(app)
        .patch('/api/workitems/123/due-date')
        .send({ 
          dueDate: '2024-03-15',
          project: 'CustomProject',
          areaPath: 'CustomArea'
        })
        .expect(200);

      expect(AzureDevOpsService).toHaveBeenCalledWith('CustomProject', 'CustomArea');
    });

    it('should handle errors gracefully', async () => {
      mockAdoService.updateDueDate.mockRejectedValue(new Error('Update failed'));

      const response = await request(app)
        .patch('/api/workitems/123/due-date')
        .send({ dueDate: '2024-03-15' })
        .expect(500);

      expect(response.body).toEqual({ error: 'Failed to update due date' });
    });
  });

  describe('PATCH /api/workitems/:id/field', () => {
    it('should update work item field successfully', async () => {
      mockAdoService.updateWorkItemField.mockResolvedValue();

      const response = await request(app)
        .patch('/api/workitems/123/field')
        .send({ field: 'state', value: 'In Progress' })
        .expect(200);

      expect(response.body).toEqual({ success: true });
      expect(mockAdoService.updateWorkItemField).toHaveBeenCalledWith(123, 'state', 'In Progress');
    });

    it('should reject invalid work item ID', async () => {
      const response = await request(app)
        .patch('/api/workitems/invalid/field')
        .send({ field: 'state', value: 'In Progress' })
        .expect(400);

      expect(response.body).toEqual({ error: 'Invalid work item ID' });
    });

    it('should reject missing field name', async () => {
      const response = await request(app)
        .patch('/api/workitems/123/field')
        .send({ value: 'In Progress' })
        .expect(400);

      expect(response.body).toEqual({ error: 'Field name is required' });
    });

    it('should handle errors gracefully', async () => {
      mockAdoService.updateWorkItemField.mockRejectedValue(new Error('Update failed'));

      const response = await request(app)
        .patch('/api/workitems/123/field')
        .send({ field: 'state', value: 'In Progress' })
        .expect(500);

      expect(response.body).toEqual({ error: 'Failed to update work item field' });
    });
  });

  describe('POST /api/cycle-time', () => {
    it('should calculate cycle time for work items', async () => {
      const mockCycleTimeData = {
        1: { inProgressDate: '2024-01-01', qaReadyDate: '2024-01-05', cycleTimeDays: 4 },
        2: { inProgressDate: '2024-01-02', qaReadyDate: '2024-01-08', cycleTimeDays: 6 },
      };

      mockAdoService.calculateCycleTimeForItems.mockResolvedValue(mockCycleTimeData);

      const response = await request(app)
        .post('/api/cycle-time')
        .send({ workItemIds: [1, 2] })
        .expect(200);

      expect(response.body).toEqual(mockCycleTimeData);
      expect(mockAdoService.calculateCycleTimeForItems).toHaveBeenCalledWith([1, 2]);
    });

    it('should reject missing workItemIds', async () => {
      const response = await request(app)
        .post('/api/cycle-time')
        .send({})
        .expect(400);

      expect(response.body).toEqual({ error: 'workItemIds array is required' });
    });

    it('should reject empty workItemIds array', async () => {
      const response = await request(app)
        .post('/api/cycle-time')
        .send({ workItemIds: [] })
        .expect(400);

      expect(response.body).toEqual({ error: 'workItemIds array is required' });
    });

    it('should handle errors gracefully', async () => {
      mockAdoService.calculateCycleTimeForItems.mockRejectedValue(new Error('Calculation failed'));

      const response = await request(app)
        .post('/api/cycle-time')
        .send({ workItemIds: [1, 2] })
        .expect(500);

      expect(response.body).toEqual({ error: 'Failed to calculate cycle time' });
    });
  });

  describe('GET /api/health', () => {
    it('should return healthy status', async () => {
      mockAdoService.healthCheck.mockResolvedValue(true);

      const response = await request(app)
        .get('/api/health')
        .expect(200);

      expect(response.body).toMatchObject({
        healthy: true,
        timestamp: expect.any(String),
      });
    });

    it('should return unhealthy status', async () => {
      mockAdoService.healthCheck.mockRejectedValue(new Error('Service unavailable'));

      const response = await request(app)
        .get('/api/health')
        .expect(503);

      expect(response.body).toMatchObject({
        healthy: false,
        error: 'Service unavailable',
      });
    });
  });

  describe('PATCH /api/workitems/:id/field - QA Complete Date', () => {
    it('should update qaCompleteDate field', async () => {
      mockAdoService.updateWorkItemField.mockResolvedValue();

      const response = await request(app)
        .patch('/api/workitems/123/field')
        .send({
          field: 'qaCompleteDate',
          value: '2024-01-25',
          project: 'TestProject',
          areaPath: 'TestArea',
        })
        .expect(200);

      expect(response.body).toEqual({ success: true });
      expect(mockAdoService.updateWorkItemField).toHaveBeenCalledWith(123, 'qaCompleteDate', '2024-01-25');
    });

    it('should remove qaCompleteDate when value is undefined', async () => {
      mockAdoService.updateWorkItemField.mockResolvedValue();

      const response = await request(app)
        .patch('/api/workitems/123/field')
        .send({
          field: 'qaCompleteDate',
          value: undefined,
          project: 'TestProject',
          areaPath: 'TestArea',
        })
        .expect(200);

      expect(response.body).toEqual({ success: true });
      expect(mockAdoService.updateWorkItemField).toHaveBeenCalledWith(123, 'qaCompleteDate', undefined);
    });

    it('should handle state field update', async () => {
      mockAdoService.updateWorkItemField.mockResolvedValue();

      const response = await request(app)
        .patch('/api/workitems/123/field')
        .send({
          field: 'state',
          value: 'Ready For Test',
          project: 'TestProject',
          areaPath: 'TestArea',
        })
        .expect(200);

      expect(response.body).toEqual({ success: true });
      expect(mockAdoService.updateWorkItemField).toHaveBeenCalledWith(123, 'state', 'Ready For Test');
    });

    it('should reject invalid work item ID', async () => {
      const response = await request(app)
        .patch('/api/workitems/invalid/field')
        .send({
          field: 'qaCompleteDate',
          value: '2024-01-25',
        })
        .expect(400);

      expect(response.body).toEqual({ error: 'Invalid work item ID' });
    });

    it('should reject missing field name', async () => {
      const response = await request(app)
        .patch('/api/workitems/123/field')
        .send({
          value: '2024-01-25',
        })
        .expect(400);

      expect(response.body).toEqual({ error: 'Field name is required' });
    });

    it('should handle errors gracefully', async () => {
      mockAdoService.updateWorkItemField.mockRejectedValue(new Error('Update failed'));

      const response = await request(app)
        .patch('/api/workitems/123/field')
        .send({
          field: 'qaCompleteDate',
          value: '2024-01-25',
        })
        .expect(500);

      expect(response.body).toEqual({ error: 'Failed to update work item field' });
    });
  });
});

// ── GET /api/skill-config ─────────────────────────────────────────────────────

const { getSkillConfig: mockGetSkillConfig } = jest.requireMock('../services/projectSettingsService') as {
  getSkillConfig: jest.Mock;
};

describe('GET /api/skill-config', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
  });

  it('returns 200 with all skill config fields including per-skill model fields', async () => {
    mockGetSkillConfig.mockResolvedValue({
      project: 'proj-alpha',
      skillRepo: 'org/skills',
      skillBranch: 'main',
      interviewSkillPath: '.cursor/skills/interview/SKILL.md',
      prdSkillPath: '.cursor/skills/prd/SKILL.md',
      designDocSkillPath: '.cursor/skills/design/SKILL.md',
      interviewModel: 'claude-3.5-sonnet',
      prdModel: 'gpt-4o',
      designDocModel: 'claude-3-opus',
    });

    const res = await request(app).get('/api/skill-config?project=proj-alpha');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      project: 'proj-alpha',
      skillRepo: 'org/skills',
      skillBranch: 'main',
      interviewSkillPath: '.cursor/skills/interview/SKILL.md',
      prdSkillPath: '.cursor/skills/prd/SKILL.md',
      designDocSkillPath: '.cursor/skills/design/SKILL.md',
      interviewModel: 'claude-3.5-sonnet',
      prdModel: 'gpt-4o',
      designDocModel: 'claude-3-opus',
    });
  });

  it('returns interviewModel, prdModel, designDocModel as null when not set', async () => {
    mockGetSkillConfig.mockResolvedValue({
      project: 'proj-beta',
      skillRepo: 'org/skills',
      skillBranch: 'main',
      interviewSkillPath: null,
      prdSkillPath: null,
      designDocSkillPath: null,
      interviewModel: null,
      prdModel: null,
      designDocModel: null,
    });

    const res = await request(app).get('/api/skill-config?project=proj-beta');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      interviewModel: null,
      prdModel: null,
      designDocModel: null,
    });
  });

  it('returns 400 when project query param is missing', async () => {
    const res = await request(app).get('/api/skill-config');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'project query parameter is required' });
    expect(mockGetSkillConfig).not.toHaveBeenCalled();
  });

  it('returns 404 when no config exists for the project', async () => {
    mockGetSkillConfig.mockResolvedValue(null);

    const res = await request(app).get('/api/skill-config?project=unknown-project');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'No skill config found for this project' });
  });
});
