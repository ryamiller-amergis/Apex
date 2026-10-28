import request from 'supertest';
import express from 'express';
import { ProjectQuickLinkError } from '../../shared/types/projectQuickLinks';

let grantedPermissions = new Set<string>(['quick-links:manage']);
let assignedProjects = new Set<string>(['MaxView']);

jest.mock('../middleware/rbac', () => ({
  requirePermission: (...keys: string[]) =>
    (_req: any, res: any, next: any) => {
      const missing = keys.filter((k) => !grantedPermissions.has(k));
      if (missing.length > 0) return res.status(403).json({ error: 'Forbidden', missing });
      next();
    },
  requireProjectAccess: (resolve: (req: any) => string | undefined) =>
    (req: any, res: any, next: any) => {
      const project = resolve(req);
      if (!project || !assignedProjects.has(project)) {
        return res.status(403).json({ error: 'Forbidden: not assigned to this project' });
      }
      next();
    },
  resolveRequestProject: (req: any) => req.params?.projectId,
}));

const listLinks = jest.fn();
const createLink = jest.fn();
const updateLink = jest.fn();
const deleteLink = jest.fn();
const reorderLinks = jest.fn();

jest.mock('../services/projectQuickLinksService', () => ({
  listLinks: (...args: unknown[]) => listLinks(...args),
  createLink: (...args: unknown[]) => createLink(...args),
  updateLink: (...args: unknown[]) => updateLink(...args),
  deleteLink: (...args: unknown[]) => deleteLink(...args),
  reorderLinks: (...args: unknown[]) => reorderLinks(...args),
}));

import quickLinksRouter from '../routes/projectQuickLinks';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { profile: { oid: 'user-1' } };
    next();
  });
  app.use('/api/projects/:projectId/quick-links', quickLinksRouter);
  return app;
}

const link = {
  id: 'link-1',
  project: 'MaxView',
  label: 'MaxView Prod',
  url: 'https://maxview.example.com/',
  category: 'Environments',
  sortOrder: 0,
  createdBy: 'user-1',
  updatedBy: 'user-1',
  createdAt: '2026-10-28T19:00:00.000Z',
  updatedAt: '2026-10-28T19:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  grantedPermissions = new Set(['quick-links:manage']);
  assignedProjects = new Set(['MaxView']);
});

describe('GET /quick-links', () => {
  it('lists links for a project the user is assigned to, without needing quick-links:manage', async () => {
    grantedPermissions = new Set();
    listLinks.mockResolvedValue([link]);

    const res = await request(buildApp()).get('/api/projects/MaxView/quick-links');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [link] });
    expect(listLinks).toHaveBeenCalledWith('MaxView');
  });

  it('returns 403 for a project the user is not assigned to', async () => {
    const res = await request(buildApp()).get('/api/projects/Amego/quick-links');

    expect(res.status).toBe(403);
    expect(listLinks).not.toHaveBeenCalled();
  });
});

describe('write routes require quick-links:manage', () => {
  beforeEach(() => {
    grantedPermissions = new Set();
  });

  it.each([
    ['post', '/api/projects/MaxView/quick-links', { label: 'x', url: 'https://x.com' }],
    ['patch', '/api/projects/MaxView/quick-links/link-1', { label: 'y' }],
    ['delete', '/api/projects/MaxView/quick-links/link-1', undefined],
    ['put', '/api/projects/MaxView/quick-links/order', { ids: ['link-1'] }],
  ] as const)('%s %s returns 403', async (method, url, body) => {
    const res = await request(buildApp())[method](url).send(body);

    expect(res.status).toBe(403);
    expect(res.body.missing).toEqual(['quick-links:manage']);
    expect(createLink).not.toHaveBeenCalled();
    expect(updateLink).not.toHaveBeenCalled();
    expect(deleteLink).not.toHaveBeenCalled();
    expect(reorderLinks).not.toHaveBeenCalled();
  });

  it('checks project access before the permission', async () => {
    grantedPermissions = new Set(['quick-links:manage']);
    const res = await request(buildApp())
      .post('/api/projects/Amego/quick-links')
      .send({ label: 'x', url: 'https://x.com' });

    expect(res.status).toBe(403);
    expect(createLink).not.toHaveBeenCalled();
  });
});

describe('write routes with quick-links:manage', () => {
  it('POST creates a link as the current user', async () => {
    createLink.mockResolvedValue(link);
    const body = { label: 'MaxView Prod', url: 'https://maxview.example.com' };

    const res = await request(buildApp()).post('/api/projects/MaxView/quick-links').send(body);

    expect(res.status).toBe(201);
    expect(res.body).toEqual(link);
    expect(createLink).toHaveBeenCalledWith('MaxView', body, 'user-1');
  });

  it('POST maps validation errors to 422', async () => {
    createLink.mockRejectedValue(new ProjectQuickLinkError('URL must start with http:// or https://'));

    const res = await request(buildApp())
      .post('/api/projects/MaxView/quick-links')
      .send({ label: 'Bad', url: 'javascript:alert(1)' });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'URL must start with http:// or https://', code: 'VALIDATION' });
  });

  it('PATCH maps not found to 404', async () => {
    updateLink.mockRejectedValue(new ProjectQuickLinkError('Quick link not found', 'NOT_FOUND'));

    const res = await request(buildApp())
      .patch('/api/projects/MaxView/quick-links/missing')
      .send({ label: 'y' });

    expect(res.status).toBe(404);
    expect(updateLink).toHaveBeenCalledWith('MaxView', 'missing', { label: 'y' }, 'user-1');
  });

  it('DELETE returns 204', async () => {
    deleteLink.mockResolvedValue(undefined);

    const res = await request(buildApp()).delete('/api/projects/MaxView/quick-links/link-1');

    expect(res.status).toBe(204);
    expect(deleteLink).toHaveBeenCalledWith('MaxView', 'link-1');
  });

  it('PUT /order reorders and returns the list', async () => {
    reorderLinks.mockResolvedValue([link]);

    const res = await request(buildApp())
      .put('/api/projects/MaxView/quick-links/order')
      .send({ ids: ['link-1'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [link] });
    expect(reorderLinks).toHaveBeenCalledWith('MaxView', ['link-1'], 'user-1');
  });
});
