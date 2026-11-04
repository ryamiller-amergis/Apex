/**
 * S6 — Build revisions route tests (PBI-030 AC-0..3, PBI-032 AC-0..3 / VT-18..VT-27).
 */
import express from 'express';
import request from 'supertest';
import { BuildRevisionError } from '../services/buildRevisionService';

const mockRequestRevision = jest.fn();
const mockGetBuildDetail = jest.fn();
let mockFlagEnabled = true;
let mockUser = {
  id: 'user-req',
  project: 'Apex',
  permissions: new Set<string>(['builds:run', 'builds:view']),
  isSuperAdmin: false,
};

jest.mock('../middleware/rbac', () => ({
  resolveRequestProject: (req: express.Request) =>
    (req.query.project as string)
    || (req.body as { project?: string } | undefined)?.project
    || (req.headers['x-apex-project'] as string)
    || mockUser.project,
  requireProjectAccess:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
  requirePermission:
    (...perms: string[]) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      (req as express.Request & { userPermissions?: Set<string> }).userPermissions =
        mockUser.permissions;
      if (mockUser.isSuperAdmin || perms.some((p) => mockUser.permissions.has(p))) {
        next();
        return;
      }
      res.status(403).json({ error: 'Forbidden' });
    },
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: () => mockUser.id,
  getUserDisplayName: () => 'Test User',
}));

jest.mock('../utils/superAdmin', () => ({
  isSuperAdminRequest: () => mockUser.isSuperAdmin,
}));

jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn(async () => mockFlagEnabled),
}));

jest.mock('../services/buildRunProjectionService', () => ({
  getBuildDetail: (...args: unknown[]) => mockGetBuildDetail(...args),
  listBuildRunEvents: jest.fn(),
  normalizeEventsLimit: jest.fn(() => 200),
}));

jest.mock('../services/buildRevisionService', () => {
  const actual = jest.requireActual('../services/buildRevisionService');
  return {
    ...actual,
    defaultBuildRevisionService: {
      requestRevision: (...args: unknown[]) => mockRequestRevision(...args),
    },
  };
});

import buildsRouter from '../routes/builds';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/builds', buildsRouter);
  return app;
}

describe('POST /api/builds/:id/revisions (PBI-030, PBI-032 / VT-18..VT-27)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFlagEnabled = true;
    mockUser = {
      id: 'user-req',
      project: 'Apex',
      permissions: new Set(['builds:run', 'builds:view']),
      isSuperAdmin: false,
    };
  });

  it('VT-18, VT-21, VT-22 PBI-030 AC-0 / PBI-032 AC-0 returns 202 BuildRevisionAccepted for requester, Project Admin, and Platform Admin', async () => {
    const acceptedPayload = {
      buildId: 'run-1',
      revisionNumber: 2,
      status: 'intake' as const,
      revisionsUsed: 1,
      revisionsLimit: 5,
      interviewId: 'iv-1',
      chatThreadId: 'thread-1',
      resumed: false,
    };
    mockRequestRevision.mockResolvedValue(acceptedPayload);

    const resRequester = await request(buildApp())
      .post('/api/builds/run-1/revisions?project=Apex')
      .send({ project: 'Apex', feedback: 'Add a filter bar' });
    expect(resRequester.status).toBe(202);
    expect(resRequester.body).toEqual(acceptedPayload);

    // Project Admin
    mockUser.id = 'user-proj-admin';
    mockUser.permissions = new Set(['builds:run', 'builds:view', 'admin:roles']);
    const resAdmin = await request(buildApp())
      .post('/api/builds/run-1/revisions?project=Apex')
      .send({ project: 'Apex', feedback: 'Admin takeover feedback' });
    expect(resAdmin.status).toBe(202);
    expect(mockRequestRevision).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ isProjectAdmin: true }),
      }),
    );

    // Platform Admin
    mockUser.id = 'user-super';
    mockUser.permissions = new Set();
    mockUser.isSuperAdmin = true;
    const resSuper = await request(buildApp())
      .post('/api/builds/run-1/revisions?project=Apex')
      .send({ project: 'Apex', feedback: 'Super admin feedback' });
    expect(resSuper.status).toBe(202);
  });

  it('VT-19, VT-20, VT-26 PBI-032 AC-1, AC-3 returns 403 for non-requester member, project mismatch, or viewer without builds:run', async () => {
    // VT-19: non-requester member
    mockRequestRevision.mockRejectedValueOnce(
      new BuildRevisionError(
        'NOT_REQUESTER_OR_ADMIN',
        'Only the requester or a project admin can request changes for this build.',
        403,
      ),
    );
    const resMember = await request(buildApp())
      .post('/api/builds/run-1/revisions?project=Apex')
      .send({ project: 'Apex', feedback: 'Try editing' });
    expect(resMember.status).toBe(403);
    expect(resMember.body.code).toBe('NOT_REQUESTER_OR_ADMIN');

    // VT-20: project mismatch
    mockRequestRevision.mockRejectedValueOnce(
      new BuildRevisionError(
        'BUILD_PROJECT_MISMATCH',
        'This build belongs to another project.',
        403,
      ),
    );
    const resMismatch = await request(buildApp())
      .post('/api/builds/run-1/revisions?project=OtherProject')
      .send({ project: 'OtherProject', feedback: 'Try editing' });
    expect(resMismatch.status).toBe(403);
    expect(resMismatch.body.code).toBe('BUILD_PROJECT_MISMATCH');

    // VT-26: demoted viewer without builds:run
    mockUser.permissions = new Set(['builds:view']);
    const resViewer = await request(buildApp())
      .post('/api/builds/run-1/revisions?project=Apex')
      .send({ project: 'Apex', feedback: 'Try editing' });
    expect(resViewer.status).toBe(403);
    expect(mockRequestRevision).toHaveBeenCalledTimes(2);
  });

  it('VT-23 PBI-030 AC-0 returns 403 BUILDS_DISABLED on POST when flag is off while GET stays 200', async () => {
    mockFlagEnabled = false;

    const postRes = await request(buildApp())
      .post('/api/builds/run-1/revisions?project=Apex')
      .send({ project: 'Apex', feedback: 'Change something' });
    expect(postRes.status).toBe(403);
    expect(postRes.body.code).toBe('BUILDS_DISABLED');
    expect(mockRequestRevision).not.toHaveBeenCalled();

    mockGetBuildDetail.mockResolvedValueOnce({
      kind: 'ok',
      detail: { build: { id: 'run-1', project: 'Apex', status: 'preview_ready' } },
    });
    const getRes = await request(buildApp()).get('/api/builds/run-1?project=Apex');
    expect(getRes.status).toBe(200);
  });

  it('VT-24, VT-25 PBI-030 AC-2, AC-3 validates blank/overlong feedback (400) and non-revisable states (409)', async () => {
    const emptyRes = await request(buildApp())
      .post('/api/builds/run-1/revisions?project=Apex')
      .send({ project: 'Apex', feedback: '   ' });
    expect(emptyRes.status).toBe(400);
    expect(emptyRes.body.code).toBe('FEEDBACK_REQUIRED');

    const longRes = await request(buildApp())
      .post('/api/builds/run-1/revisions?project=Apex')
      .send({ project: 'Apex', feedback: 'x'.repeat(4001) });
    expect(longRes.status).toBe(400);
    expect(longRes.body.code).toBe('FEEDBACK_TOO_LONG');

    mockRequestRevision.mockRejectedValueOnce(
      new BuildRevisionError(
        'BUILD_NOT_REVISABLE',
        'An accepted build cannot be revised.',
        409,
      ),
    );
    const acceptedRes = await request(buildApp())
      .post('/api/builds/run-1/revisions?project=Apex')
      .send({ project: 'Apex', feedback: 'Revise accepted build' });
    expect(acceptedRes.status).toBe(409);
    expect(acceptedRes.body.code).toBe('BUILD_NOT_REVISABLE');
  });
});
