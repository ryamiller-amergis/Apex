/**
 * S8 — Builds router retry-deployment and deployment projection tests (PBI-026 AC-3, PBI-028 AC-3, PBI-029 AC-0, AC-3 / VT-20, VT-21, VT-24, VT-25).
 */
import express from 'express';
import request from 'supertest';

const mockGetBuildDetail = jest.fn();
const mockRetryDeployment = jest.fn();
let mockCurrentUser = {
  id: 'u-member',
  project: 'Apex',
  permissions: new Set<string>(['builds:view']),
  isSuperAdmin: false,
};

jest.mock('../middleware/rbac', () => ({
  resolveRequestProject: (req: express.Request) =>
    (req.query.project as string) || (req.headers['x-apex-project'] as string) || mockCurrentUser.project,
  requireProjectAccess: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requirePermission:
    (...perms: string[]) =>
    (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (mockCurrentUser.isSuperAdmin || perms.some((p) => mockCurrentUser.permissions.has(p))) {
        next();
        return;
      }
      res.status(403).json({ error: 'Forbidden' });
    },
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: () => mockCurrentUser.id,
}));

jest.mock('../utils/superAdmin', () => ({
  isSuperAdminRequest: () => mockCurrentUser.isSuperAdmin,
}));

jest.mock('../services/buildRunProjectionService', () => ({
  getBuildDetail: (...args: unknown[]) => mockGetBuildDetail(...args),
  listBuildRunEvents: jest.fn(),
  normalizeEventsLimit: jest.fn(() => 200),
}));

jest.mock('../services/buildDeploymentService', () => ({
  defaultBuildDeploymentService: {
    retryDeployment: (...args: unknown[]) => mockRetryDeployment(...args),
  },
}));

import buildsRouter from '../routes/builds';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/builds', buildsRouter);
  return app;
}

describe('Builds deployment routes (PBI-026 AC-3, PBI-028 AC-3, PBI-029 AC-0, AC-3 / VT-20, VT-21, VT-24, VT-25)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCurrentUser = {
      id: 'u-member',
      project: 'Apex',
      permissions: new Set(['builds:view']),
      isSuperAdmin: false,
    };
  });

  it('VT-20 PBI-028 AC-3 / PBI-029 AC-3 hides errorExcerpt/failedStage from non-contact member on GET and returns 403 on POST retry-deployment', async () => {
    mockGetBuildDetail.mockResolvedValueOnce({
      kind: 'ok',
      detail: {
        build: { id: 'b-1', project: 'Apex', repository: 'apex-repo', status: 'deployment_failed' },
        deployment: {
          status: 'failed',
          queuePosition: null,
          previewUrl: null,
          leaseExpiresAt: null,
          failedStage: null,
          errorExcerpt: null,
          pipelineUrl: null,
          supportContactNames: ['Dana (dana@example.com)'],
        },
        previews: [],
        viewer: { canRetryDeployment: false },
      },
    });

    const getRes = await request(buildApp()).get('/api/builds/b-1?project=Apex');
    expect(getRes.status).toBe(200);
    expect(getRes.body.deployment.errorExcerpt).toBeNull();
    expect(getRes.body.deployment.failedStage).toBeNull();
    expect(getRes.body.viewer.canRetryDeployment).toBe(false);

    mockRetryDeployment.mockResolvedValueOnce({ kind: 'forbidden' });
    const postRes = await request(buildApp()).post('/api/builds/b-1/retry-deployment?project=Apex');
    expect(postRes.status).toBe(403);
  });

  it('VT-21, VT-24 PBI-029 AC-0, AC-3 returns 202 for support contact/admin and 409 BUILD_NOT_RETRYABLE when run is preview_ready', async () => {
    mockCurrentUser.id = 'u-contact-1';
    mockRetryDeployment.mockResolvedValueOnce({
      kind: 'ok',
      response: { deploymentStatus: 'queued', queuePosition: 1, changed: true },
    });

    const okRes = await request(buildApp()).post('/api/builds/b-1/retry-deployment?project=Apex');
    expect(okRes.status).toBe(202);
    expect(okRes.body).toEqual({
      deploymentStatus: 'queued',
      queuePosition: 1,
      changed: true,
    });

    mockRetryDeployment.mockResolvedValueOnce({
      kind: 'not_retryable',
      message: 'This build is not in a failed deployment state.',
    });
    const conflictRes = await request(buildApp()).post('/api/builds/b-1/retry-deployment?project=Apex');
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.code).toBe('BUILD_NOT_RETRYABLE');
  });

  it('VT-25 PBI-026 AC-3 returns 403 and no previewUrl when requesting a build belonging to another project', async () => {
    mockGetBuildDetail.mockResolvedValueOnce({ kind: 'wrong-project' });

    const res = await request(buildApp()).get('/api/builds/b-other?project=Apex');
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('previewUrl');
  });
});
