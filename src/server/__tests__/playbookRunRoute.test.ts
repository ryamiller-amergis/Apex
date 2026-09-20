/**
 * PBI-001 — `POST /api/playbooks/runs`.
 *
 * Covers VT-08 (a caller without `playbooks:run` is refused and no run row is written) and the
 * error mapping the endpoint owes its callers.
 *
 * Unlike most route tests in this repo, `requirePermission` is *not* mocked. The property VT-08
 * asserts is project-scoped denial, and the scoping happens inside the real middleware —
 * `resolveRequestProject` reading `req.body.project` and passing it to `getUserPermissions`. A
 * mocked guard that consults a flat set of permission strings would pass this test while the route
 * was wired to the wrong project entirely. So the permission *source* is mocked and the middleware
 * itself is real.
 */
jest.mock('../db/drizzle', () => ({ db: {} }));
// The real run service is required below for its error classes, and reaches chatAgentService
// through the cursor-agent adapter. Stubbed so that pulls in no pool.
jest.mock('../db', () => ({ __esModule: true, default: { end: jest.fn(), on: jest.fn() } }));

const getUserPermissions = jest.fn();
jest.mock('../services/rbacService', () => ({
  getUserPermissions: (...a: unknown[]) => getUserPermissions(...a),
}));

// The real middleware waves super admins through before consulting permissions at all, which would
// make every denial test pass for the wrong reason.
jest.mock('../utils/superAdmin', () => ({ isSuperAdminRequest: () => false }));

const startRun = jest.fn();
jest.mock('../services/playbookRunService', () => ({
  ...jest.requireActual('../services/playbookRunService'),
  startRun: (...a: unknown[]) => startRun(...a),
}));

import express from 'express';
import request from 'supertest';
import playbooksRouter from '../routes/playbooks';
import {
  PlaybookDefinitionNotFoundError,
  PlaybookNoPublishedVersionError,
} from '../services/playbookRunService';

const USER_OID = 'caller-oid';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { profile: { oid: USER_OID } };
    next();
  });
  app.use('/api/playbooks', playbooksRouter);
  return app;
}

/** Grants the named permissions, but only in the named project. */
function grantIn(project: string, ...permissions: string[]) {
  getUserPermissions.mockImplementation(async (_userId: string, requestedProject?: string) =>
    requestedProject === project ? new Set(permissions) : new Set()
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  startRun.mockResolvedValue({ runId: 'run-1', status: 'running' });
});

describe('VT-08 — a caller without playbooks:run', () => {
  it('is refused with 403 and never reaches the service', async () => {
    grantIn('Apex', 'playbooks:view');

    const res = await request(buildApp())
      .post('/api/playbooks/runs')
      .send({ project: 'Apex', definitionId: 'def-1' });

    expect(res.status).toBe(403);
    expect(res.body.missing).toEqual(['playbooks:run']);
    // "Zero run rows written" — the service that writes them was never called.
    expect(startRun).not.toHaveBeenCalled();
  });

  it('is refused when the permission is held in a different project', async () => {
    grantIn('SomeOtherProject', 'playbooks:run');

    const res = await request(buildApp())
      .post('/api/playbooks/runs')
      .send({ project: 'Apex', definitionId: 'def-1' });

    expect(res.status).toBe(403);
    expect(startRun).not.toHaveBeenCalled();
  });

  it('resolves permissions against the project in the body', async () => {
    grantIn('Apex', 'playbooks:run');

    await request(buildApp())
      .post('/api/playbooks/runs')
      .send({ project: 'Apex', definitionId: 'def-1' });

    expect(getUserPermissions).toHaveBeenCalledWith(USER_OID, 'Apex');
  });
});

describe('starting a run through the endpoint', () => {
  beforeEach(() => grantIn('Apex', 'playbooks:run'));

  it('returns the run handle', async () => {
    const res = await request(buildApp())
      .post('/api/playbooks/runs')
      .send({ project: 'Apex', definitionId: 'def-1' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ runId: 'run-1', status: 'running' });
    expect(startRun).toHaveBeenCalledWith({
      project: 'Apex',
      definitionId: 'def-1',
      initiatorUserId: USER_OID,
    });
  });

  it('reports a missing published version as 400, naming the reason', async () => {
    startRun.mockRejectedValue(new PlaybookNoPublishedVersionError('Draft and approve'));

    const res = await request(buildApp())
      .post('/api/playbooks/runs')
      .send({ project: 'Apex', definitionId: 'def-1' });

    // Someone hitting this has most likely forgotten to publish a draft, and the message says so
    // rather than returning a generic failure.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no published version/i);
    expect(res.body.error).toMatch(/Draft and approve/);
  });

  it('reports an unknown definition as 404', async () => {
    startRun.mockRejectedValue(new PlaybookDefinitionNotFoundError('Apex', 'def-9'));

    const res = await request(buildApp())
      .post('/api/playbooks/runs')
      .send({ project: 'Apex', definitionId: 'def-9' });

    // Not 403: the permission check already passed for this project, so the caller is allowed to
    // know that no such definition exists in it.
    expect(res.status).toBe(404);
  });

  it('rejects a request missing its project or definition', async () => {
    const app = buildApp();

    const noProject = await request(app).post('/api/playbooks/runs').send({ definitionId: 'd' });
    const noDefinition = await request(app)
      .post('/api/playbooks/runs')
      .send({ project: 'Apex' });

    // A request with no project cannot be permission-checked against one, so the guard refuses it
    // before the handler's own validation is reached.
    expect(noProject.status).toBe(403);
    expect(noDefinition.status).toBe(400);
    expect(startRun).not.toHaveBeenCalled();
  });
});
