import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import {
  DiagramForbiddenError,
  DiagramNotFoundError,
  DiagramValidationError,
  DiagramVersionConflictError,
} from '../../shared/types/diagram';
import diagramRouter from '../routes/diagrams';
import * as service from '../services/diagramService';

let permissions = new Set<string>();
let projectAllowed = true;

jest.mock('../middleware/rbac', () => ({
  resolveRequestProject: (req: express.Request) => req.params.projectId,
  requireProjectAccess: (resolve: (req: express.Request) => string | undefined) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (!projectAllowed || !resolve(req)) {
        res.status(403).json({ error: 'Forbidden: not assigned to this project' });
        return;
      }
      next();
    },
  requirePermission: (...keys: string[]) =>
    (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      const missing = keys.filter((key) => !permissions.has(key));
      if (missing.length) {
        res.status(403).json({ error: 'Forbidden', missing });
        return;
      }
      next();
    },
}));

jest.mock('../services/diagramService');
const mockedService = service as jest.Mocked<typeof service>;

const NOW = '2026-08-06T00:00:00.000Z';
const detail = {
  id: 'diagram-1',
  projectId: 'project-a',
  ownerId: 'user-1',
  ownerName: 'User One',
  title: 'Untitled diagram',
  scene: { elements: [], appState: {}, files: {} },
  thumbnail: 'data:image/png;base64,iVBORw0KGgo=',
  version: 1,
  effectiveAccess: 'owner' as const,
  createdAt: NOW,
  updatedAt: NOW,
};

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req: express.Request, _res, next) => {
    req.user = { profile: { oid: 'user-1' } } as unknown as Express.User;
    next();
  });
  app.use('/api/projects/:projectId/diagrams', diagramRouter);
  return app;
}

const base = '/api/projects/project-a/diagrams';

beforeEach(() => {
  jest.clearAllMocks();
  permissions = new Set();
  projectAllowed = true;
});

describe('Diagram API route contracts', () => {
  it('TBI-002 DoD-1 denies list without diagram:view or current project access', async () => {
    expect((await request(buildApp()).get(`${base}?scope=owned`)).status).toBe(403);

    permissions.add('diagram:view');
    projectAllowed = false;
    expect((await request(buildApp()).get(`${base}?scope=owned`)).status).toBe(403);
    expect(mockedService.listDiagrams).not.toHaveBeenCalled();
  });

  it('PBI-004 AC-3 / VT-03 / VT-08 returns paginated summaries with ownerName and without scene', async () => {
    permissions.add('diagram:view');
    const { scene: _scene, ...summary } = detail;
    mockedService.listDiagrams.mockResolvedValue({
      items: [summary],
      nextOffset: 50,
    });

    const response = await request(buildApp()).get(`${base}?scope=owned&limit=50&offset=0`);

    expect(response.status).toBe(200);
    expect(response.body.nextOffset).toBe(50);
    expect(response.body.items[0]).not.toHaveProperty('scene');
    expect(response.body.items[0].ownerName).toBe('User One');
    expect(mockedService.listDiagrams).toHaveBeenCalledWith(
      'project-a',
      { scope: 'owned', limit: 50, offset: 0 },
      'user-1',
    );
  });

  it('PBI-006 AC-2 / VT-11: DELETE owned Diagram returns 204', async () => {
    permissions.add('diagram:delete');
    mockedService.deleteDiagram.mockResolvedValue();

    const response = await request(buildApp()).delete(`${base}/${detail.id}`);

    expect(response.status).toBe(204);
    expect(mockedService.deleteDiagram).toHaveBeenCalledWith('project-a', detail.id, 'user-1');
  });

  it('PBI-006 AC-3 / VT-12: DELETE by non-owner maps service forbidden to 403', async () => {
    permissions.add('diagram:delete');
    mockedService.deleteDiagram.mockRejectedValue(new DiagramForbiddenError());

    const response = await request(buildApp()).delete(`${base}/${detail.id}`);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('DIAGRAM_FORBIDDEN');
  });

  it('TBI-002 DoD-0 exposes create, detail, update, and delete operations', async () => {
    permissions = new Set([
      'diagram:create',
      'diagram:view',
      'diagram:edit',
      'diagram:delete',
    ]);
    mockedService.createDiagram.mockResolvedValue(detail);
    mockedService.getDiagram.mockResolvedValue(detail);
    mockedService.updateDiagram.mockResolvedValue({ ...detail, version: 2 });
    mockedService.deleteDiagram.mockResolvedValue();

    expect((await request(buildApp()).post(base).send(detail)).status).toBe(201);
    expect((await request(buildApp()).get(`${base}/${detail.id}`)).status).toBe(200);
    expect((await request(buildApp()).put(`${base}/${detail.id}`).send(detail)).status).toBe(200);
    expect((await request(buildApp()).delete(`${base}/${detail.id}`)).status).toBe(204);
  });

  it('TBI-002 DoD-0 exposes grant and share-target operations', async () => {
    permissions.add('diagram:share');
    const share = {
      id: 'share-1',
      diagramId: detail.id,
      granteeId: 'user-2',
      granteeName: 'User Two',
      access: 'view' as const,
      createdAt: NOW,
    };
    mockedService.listShareTargets.mockResolvedValue([
      {
        userId: 'user-2',
        displayName: 'User Two',
        email: 'two@example.com',
        existingAccess: null,
      },
    ]);
    mockedService.listShares.mockResolvedValue([share]);
    mockedService.createShare.mockResolvedValue(share);
    mockedService.updateShare.mockResolvedValue({ ...share, access: 'edit' });
    mockedService.revokeShare.mockResolvedValue();

    expect((await request(buildApp()).get(
      `${base}/${detail.id}/share-targets?query=Two`,
    )).status).toBe(200);
    expect(mockedService.listShareTargets).toHaveBeenCalledWith(
      'project-a',
      detail.id,
      'Two',
      'user-1',
    );
    expect((await request(buildApp()).get(`${base}/${detail.id}/shares`)).status).toBe(200);
    expect((await request(buildApp()).post(`${base}/${detail.id}/shares`).send(share)).status)
      .toBe(201);
    expect((await request(buildApp()).patch(`${base}/${detail.id}/shares/user-2`).send({
      access: 'edit',
    })).status).toBe(200);
    expect((await request(buildApp()).delete(`${base}/${detail.id}/shares/user-2`)).status)
      .toBe(204);
  });

  it('PBI-007 AC-3 / VT-02: sharee attempting grant management maps to 403 with no write', async () => {
    permissions.add('diagram:share');
    mockedService.createShare.mockRejectedValue(new DiagramForbiddenError());

    const response = await request(buildApp())
      .post(`${base}/${detail.id}/shares`)
      .send({ granteeId: 'user-3', access: 'view' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('DIAGRAM_FORBIDDEN');
  });

  it('PBI-007 AC-1 / VT-03: createShare failure returns error without success body', async () => {
    permissions.add('diagram:share');
    mockedService.createShare.mockRejectedValue(new DiagramValidationError('write failed'));

    const response = await request(buildApp())
      .post(`${base}/${detail.id}/shares`)
      .send({ granteeId: 'user-2', access: 'view' });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('DIAGRAM_VALIDATION_ERROR');
  });

  it('PBI-007 AC-0 / VT-08: DELETE share returns 204', async () => {
    permissions.add('diagram:share');
    mockedService.revokeShare.mockResolvedValue();

    const response = await request(buildApp())
      .delete(`${base}/${detail.id}/shares/user-2`);

    expect(response.status).toBe(204);
    expect(mockedService.revokeShare).toHaveBeenCalledWith(
      'project-a',
      detail.id,
      'user-2',
      'user-1',
    );
  });

  it('TBI-006 / VT-09: cross-project share list maps not-found to 404', async () => {
    permissions.add('diagram:share');
    mockedService.listShares.mockRejectedValue(new DiagramNotFoundError());

    const response = await request(buildApp()).get(`${base}/other-id/shares`);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('DIAGRAM_NOT_FOUND');
  });

  it.each([
    [new DiagramNotFoundError(), 404],
    [new DiagramForbiddenError(), 403],
    [new DiagramValidationError('invalid'), 422],
    [new DiagramVersionConflictError(), 409],
  ])('TBI-002 DoD-2/DoD-3 maps typed outcomes to HTTP', async (error, expectedStatus) => {
    permissions.add('diagram:view');
    mockedService.getDiagram.mockRejectedValue(error);

    const response = await request(buildApp()).get(`${base}/${detail.id}`);

    expect(response.status).toBe(expectedStatus);
    expect(response.body.code).toBe(error.code);
  });

  it('PBI-008 AC-1 / VT-02: revoked grant returns 403 on next GET and PUT without mutating', async () => {
    permissions = new Set(['diagram:view', 'diagram:edit']);
    mockedService.getDiagram.mockRejectedValue(new DiagramForbiddenError());
    mockedService.updateDiagram.mockRejectedValue(new DiagramForbiddenError());

    const getResponse = await request(buildApp()).get(`${base}/${detail.id}`);
    expect(getResponse.status).toBe(403);
    expect(getResponse.body.code).toBe('DIAGRAM_FORBIDDEN');

    const putResponse = await request(buildApp())
      .put(`${base}/${detail.id}`)
      .send({
        version: 1,
        scene: detail.scene,
        thumbnail: detail.thumbnail,
      });
    expect(putResponse.status).toBe(403);
    expect(putResponse.body.code).toBe('DIAGRAM_FORBIDDEN');
    expect(mockedService.updateDiagram).toHaveBeenCalled();
  });

  it('PBI-008 AC-3 route: missing project access denies detail without calling service delete', async () => {
    permissions.add('diagram:view');
    projectAllowed = false;

    const response = await request(buildApp()).get(`${base}/${detail.id}`);

    expect(response.status).toBe(403);
    expect(mockedService.getDiagram).not.toHaveBeenCalled();
  });

  it('S5 registers the router through the existing authenticated API router', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../routes/api.ts'),
      'utf8',
    );
    expect(source).toMatch(/router\.use\('\/projects\/:projectId\/diagrams', diagramsRouter\)/);
  });
});
