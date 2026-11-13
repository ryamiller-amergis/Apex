import express from 'express';
import request from 'supertest';
import roadmapRouter from '../routes/roadmap';
import { RoadmapServiceError } from '../services/roadmapService';

jest.mock('../middleware/rbac', () => ({
  requireProjectAccess: () => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.get('x-deny-project') === 'true') {
      res.status(403).json({ error: 'Forbidden: not assigned to this project' });
      return;
    }
    next();
  },
  requirePermission: (permission: string) => (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const denied = (req.get('x-deny-permission') ?? '').split(',');
    if (denied.includes(permission)) {
      res.status(403).json({ error: 'Forbidden', missing: [permission] });
      return;
    }
    next();
  },
  resolveRequestProject: (req: express.Request) => req.params.projectId,
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: () => 'user-po-1',
  getDisplayName: () => 'Taylor PO',
}));

const mockUpdateWorkItemField = jest.fn().mockResolvedValue(undefined);
const mockCreateWorkItemForPrd = jest
  .fn()
  .mockResolvedValue({ id: 901, url: 'https://dev.azure.com/epic/901' });

jest.mock('../services/adoFactory', () => ({
  adoWriteForRequest: jest.fn(async () => ({
    updateWorkItemField: mockUpdateWorkItemField,
    createWorkItemForPrd: mockCreateWorkItemForPrd,
  })),
  isAdoUserAuthError: () => false,
}));

jest.mock('../services/roadmapService', () => {
  const actual = jest.requireActual('../services/roadmapService');
  return {
    RoadmapServiceError: actual.RoadmapServiceError,
    getRoadmapWorkspace: jest.fn(),
    updateRoadmapSettings: jest.fn(),
    upsertRoadmapOverlay: jest.fn(),
    createRoadmapIdea: jest.fn(),
    updateRoadmapIdea: jest.fn(),
    deleteRoadmapIdea: jest.fn(),
    promoteRoadmapIdea: jest.fn(),
  };
});

const roadmapService = jest.requireMock('../services/roadmapService') as {
  getRoadmapWorkspace: jest.Mock;
  updateRoadmapSettings: jest.Mock;
  upsertRoadmapOverlay: jest.Mock;
  createRoadmapIdea: jest.Mock;
  updateRoadmapIdea: jest.Mock;
  deleteRoadmapIdea: jest.Mock;
  promoteRoadmapIdea: jest.Mock;
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/projects/:projectId/roadmap', roadmapRouter);
  return app;
}

describe('roadmapRoutes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('enforces project access and planning:roadmap permission on workspace GET', async () => {
    const deniedProject = await request(buildApp())
      .get('/api/projects/MaxView/roadmap')
      .set('x-deny-project', 'true');
    expect(deniedProject.status).toBe(403);

    const deniedPerm = await request(buildApp())
      .get('/api/projects/MaxView/roadmap')
      .set('x-deny-permission', 'planning:roadmap');
    expect(deniedPerm.status).toBe(403);

    roadmapService.getRoadmapWorkspace.mockResolvedValue({
      settings: {
        project: 'MaxView',
        syncDatesToAdo: false,
        updatedBy: 'system',
        updatedAt: '1970-01-01T00:00:00.000Z',
      },
      overlays: [],
      ideas: [],
      events: [],
    });

    const okRes = await request(buildApp()).get('/api/projects/MaxView/roadmap');
    expect(okRes.status).toBe(200);
    expect(roadmapService.getRoadmapWorkspace).toHaveBeenCalledWith('MaxView');
  });

  it('requires workitems:write on PUT /settings', async () => {
    const forbidden = await request(buildApp())
      .put('/api/projects/MaxView/roadmap/settings')
      .set('x-deny-permission', 'workitems:write')
      .send({ syncDatesToAdo: true });
    expect(forbidden.status).toBe(403);
    expect(roadmapService.updateRoadmapSettings).not.toHaveBeenCalled();

    roadmapService.updateRoadmapSettings.mockResolvedValue({
      project: 'MaxView',
      syncDatesToAdo: true,
      updatedBy: 'user-po-1',
      updatedAt: '2026-11-13T10:00:00.000Z',
    });

    const allowed = await request(buildApp())
      .put('/api/projects/MaxView/roadmap/settings')
      .send({ syncDatesToAdo: true });
    expect(allowed.status).toBe(200);
    expect(allowed.body.syncDatesToAdo).toBe(true);
  });

  it('maps RoadmapServiceError validation errors on PUT /overlays/:workItemId to HTTP 400', async () => {
    roadmapService.upsertRoadmapOverlay.mockRejectedValue(
      new RoadmapServiceError('itemTitle is required', 400),
    );

    const res = await request(buildApp())
      .put('/api/projects/MaxView/roadmap/overlays/401')
      .send({ horizon: 'now' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'itemTitle is required' });
  });

  it('creates, updates, promotes, and deletes ad-hoc ideas', async () => {
    roadmapService.createRoadmapIdea.mockResolvedValue({
      idea: { id: 'idea-1', title: 'Prior Auth Auto-Triage' },
      events: [{ id: 'ev-1', eventKind: 'idea_created' }],
    });

    const createRes = await request(buildApp())
      .post('/api/projects/MaxView/roadmap/ideas')
      .send({ title: 'Prior Auth Auto-Triage', horizon: 'next' });
    expect(createRes.status).toBe(201);

    roadmapService.updateRoadmapIdea.mockResolvedValue({
      idea: { id: 'idea-1', horizon: 'now' },
      events: [{ id: 'ev-2', eventKind: 'horizon_changed' }],
    });
    const patchRes = await request(buildApp())
      .patch('/api/projects/MaxView/roadmap/ideas/idea-1')
      .send({ horizon: 'now' });
    expect(patchRes.status).toBe(200);

    // Promoting to feature-request succeeds without workitems:write
    roadmapService.promoteRoadmapIdea.mockResolvedValue({
      idea: { id: 'idea-1', promotedFeatureRequestId: 'fr-1' },
      event: { id: 'ev-3', eventKind: 'idea_promoted' },
      featureRequestId: 'fr-1',
    });
    const promoteFr = await request(buildApp())
      .post('/api/projects/MaxView/roadmap/ideas/idea-1/promote')
      .set('x-deny-permission', 'workitems:write')
      .send({ target: 'feature-request' });
    expect(promoteFr.status).toBe(201);

    // Promoting to ado-epic requires workitems:write
    const promoteAdoDenied = await request(buildApp())
      .post('/api/projects/MaxView/roadmap/ideas/idea-1/promote')
      .set('x-deny-permission', 'workitems:write')
      .send({ target: 'ado-epic' });
    expect(promoteAdoDenied.status).toBe(403);

    roadmapService.deleteRoadmapIdea.mockResolvedValue(undefined);
    const deleteRes = await request(buildApp()).delete(
      '/api/projects/MaxView/roadmap/ideas/idea-1',
    );
    expect(deleteRes.status).toBe(204);
  });
});
