import request from 'supertest';
import express, { type NextFunction, type Request, type Response } from 'express';

jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    transaction: jest.fn(),
  },
}));

jest.mock('../services/azureDevOps', () => ({
  AzureDevOpsService: jest.fn(),
}));

let assignedProjects = new Set<string>(['MaxView']);

jest.mock('../middleware/rbac', () => ({
  requireGroupMembership:
    () => (req: Request & { user?: unknown }, _res: Response, next: NextFunction) => {
      req.user = { profile: { oid: 'member-oid' } };
      next();
    },
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireAnyPermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireProjectAccess: (resolve: (req: Request) => string | undefined) =>
    (req: Request, res: Response, next: NextFunction) => {
      const project = resolve(req);
      if (!project || !assignedProjects.has(project)) {
        return res.status(403).json({ error: 'Forbidden: not assigned to this project' });
      }
      next();
    },
  resolveRequestProject: (req: Request) => {
    const queryProject = req.query?.project;
    if (typeof queryProject === 'string' && queryProject) return queryProject;
    const bodyProject = (req.body as { project?: unknown } | undefined)?.project;
    return typeof bodyProject === 'string' ? bodyProject : undefined;
  },
  attachPermissions: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import apiRouter from '../routes/api';
import { AzureDevOpsService } from '../services/azureDevOps';

const getFeaturesByEpicIds = jest.fn();

describe('POST /api/roadmap/epic-features', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    assignedProjects = new Set(['MaxView']);
    (AzureDevOpsService as unknown as jest.Mock).mockImplementation(() => ({
      getFeaturesByEpicIds,
    }));
    app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
  });

  it('returns 403 when the caller is not assigned to the named project', async () => {
    assignedProjects = new Set(['OtherProject']);

    await request(app)
      .post('/api/roadmap/epic-features')
      .send({ project: 'MaxView', epicIds: [10] })
      .expect(403);

    expect(getFeaturesByEpicIds).not.toHaveBeenCalled();
  });

  it('groups feature children under the epic that owns them', async () => {
    getFeaturesByEpicIds.mockResolvedValue({
      10: [{ id: 100, title: 'Checkout', state: 'Active', workItemType: 'Feature' }],
      20: [],
    });

    const res = await request(app)
      .post('/api/roadmap/epic-features')
      .send({ project: 'MaxView', areaPath: 'MaxView', epicIds: [10, 20] })
      .expect(200);

    expect(getFeaturesByEpicIds).toHaveBeenCalledWith([10, 20]);
    expect(res.body['10']).toEqual([
      expect.objectContaining({ id: 100, workItemType: 'Feature' }),
    ]);
    expect(res.body['20']).toEqual([]);
  });
});
