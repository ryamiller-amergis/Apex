/**
 * TBI-025 — the two read endpoints.
 *
 * Covers VT-04 (a caller without `playbooks:view` gets 403 and no run data), VT-05 (with the flag
 * off the path is 404, not 403) and VT-10 (the response equals the projection's output, unreshaped).
 *
 * As in `playbookRunRoute.test.ts`, `requirePermission` is **not** mocked. The property VT-04
 * asserts is project-scoped denial, which happens inside the real middleware; a mocked guard
 * reading a flat permission set would pass while the route was wired to the wrong project. So the
 * permission source is mocked and the middleware is real.
 *
 * VT-10 is the one that keeps the Feature honest. "The route adds no read logic" is not a property
 * you can assert by reading the route once — it is a property that decays, one convenience at a
 * time. Comparing the HTTP body to the projection's return value catches the first such addition,
 * whatever shape it takes.
 */
jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../db', () => ({ __esModule: true, default: { end: jest.fn(), on: jest.fn() } }));

const getUserPermissions = jest.fn();
jest.mock('../services/rbacService', () => ({
  getUserPermissions: (...a: unknown[]) => getUserPermissions(...a),
}));

// The real middleware waves super admins through before consulting permissions, which would make
// every denial test pass for the wrong reason.
jest.mock('../utils/superAdmin', () => ({
  isSuperAdminRequest: () => false,
  getAppEnvironment: () => 'local',
}));

const isFeatureEnabled = jest.fn();
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: (...a: unknown[]) => isFeatureEnabled(...a),
}));

const listRuns = jest.fn();
const getRun = jest.fn();
jest.mock('../services/playbookRunProjectionService', () => ({
  listRuns: (...a: unknown[]) => listRuns(...a),
  getRun: (...a: unknown[]) => getRun(...a),
}));

import express from 'express';
import request from 'supertest';
import playbooksRouter from '../routes/playbooks';

const USER_OID = 'viewer-oid';
const PROJECT = 'Apex';

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
function grantIn(project: string, ...keys: string[]): void {
  getUserPermissions.mockImplementation(async (_userId: string, requested?: string) =>
    requested === project ? new Set(keys) : new Set<string>()
  );
}

/** What the projection would return for a one-run project. */
const PROJECTION_RESULT = {
  runs: [
    {
      runId: 'run-1',
      project: PROJECT,
      definitionName: 'Demo A',
      definitionVersionId: 'ver-1',
      versionNumber: 3,
      status: 'running',
      initiatorUserId: USER_OID,
      startedAt: '2026-09-20T10:00:00.000Z',
      completedAt: null,
    },
  ],
  total: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  isFeatureEnabled.mockResolvedValue(true);
  grantIn(PROJECT, 'playbooks:view');
  listRuns.mockResolvedValue(PROJECTION_RESULT);
  getRun.mockResolvedValue({ ...PROJECTION_RESULT.runs[0], steps: [], currentStepId: null, suspension: null });
});

describe('VT-05 — with playbooks-spike off, the endpoints do not exist', () => {
  it('returns 404 rather than 403 for the run list', async () => {
    isFeatureEnabled.mockResolvedValue(false);

    const res = await request(buildApp()).get('/api/playbooks/runs').query({ project: PROJECT });

    // 403 would confirm the surface exists and is merely withheld. 404 says there is nothing here.
    expect(res.status).toBe(404);
    expect(listRuns).not.toHaveBeenCalled();
  });

  it('returns 404 for a single run', async () => {
    isFeatureEnabled.mockResolvedValue(false);

    const res = await request(buildApp())
      .get('/api/playbooks/runs/run-1')
      .query({ project: PROJECT });

    expect(res.status).toBe(404);
    expect(getRun).not.toHaveBeenCalled();
  });

  it('gates the write endpoints too, so no run can be started while the surface is dark', async () => {
    isFeatureEnabled.mockResolvedValue(false);

    const res = await request(buildApp())
      .post('/api/playbooks/runs')
      .send({ project: PROJECT, definitionId: 'def-1' });

    expect(res.status).toBe(404);
  });

  it('evaluates the flag against the project the request names', async () => {
    await request(buildApp()).get('/api/playbooks/runs').query({ project: 'SomeOtherProject' });

    expect(isFeatureEnabled).toHaveBeenCalledWith(
      'playbooks-spike',
      expect.objectContaining({ project: 'SomeOtherProject', userId: USER_OID })
    );
  });
});

describe('VT-04 — a caller without playbooks:view is refused, and gets no run data', () => {
  it('returns 403 with no run rows in the body', async () => {
    grantIn(PROJECT, 'playbooks:run');

    const res = await request(buildApp()).get('/api/playbooks/runs').query({ project: PROJECT });

    expect(res.status).toBe(403);
    // The criterion is emphatic that no run data from that project is returned, so assert on the
    // body rather than only the status.
    expect(JSON.stringify(res.body)).not.toContain('run-1');
    expect(listRuns).not.toHaveBeenCalled();
  });

  it('refuses a caller who holds the permission only in another project', async () => {
    grantIn('SomeOtherProject', 'playbooks:view');

    const res = await request(buildApp()).get('/api/playbooks/runs').query({ project: PROJECT });

    expect(res.status).toBe(403);
    expect(listRuns).not.toHaveBeenCalled();
  });

  it('checks the permission in the project the request names', async () => {
    await request(buildApp()).get('/api/playbooks/runs').query({ project: PROJECT });

    expect(getUserPermissions).toHaveBeenCalledWith(USER_OID, PROJECT);
  });

  it('refuses a request that names no project at all', async () => {
    const res = await request(buildApp()).get('/api/playbooks/runs');

    // 404 rather than 400: a request naming no project cannot be permission-checked against one
    // *or* flag-evaluated, and answering 400 would confirm the route exists to exactly the caller
    // the flag is meant to hide it from.
    expect(res.status).toBe(404);
    expect(listRuns).not.toHaveBeenCalled();
  });
});

describe('VT-10 — the response is the projection, unreshaped', () => {
  it('returns the list projection verbatim', async () => {
    const res = await request(buildApp()).get('/api/playbooks/runs').query({ project: PROJECT });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(PROJECTION_RESULT);
  });

  it('returns the detail projection verbatim', async () => {
    const detail = {
      ...PROJECTION_RESULT.runs[0],
      steps: [{ id: 's1', stepId: 'draft', stepType: 'cursor-agent', status: 'completed' }],
      currentStepId: 'gate',
      suspension: { stepId: 'gate', reason: 'awaiting-approval', deadline: '2026-09-21T10:00:00.000Z' },
    };
    getRun.mockResolvedValue(detail);

    const res = await request(buildApp())
      .get('/api/playbooks/runs/run-1')
      .query({ project: PROJECT });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(detail);
  });

  it('passes the project through to the projection, which scopes on it', async () => {
    await request(buildApp()).get('/api/playbooks/runs/run-9').query({ project: PROJECT });

    expect(getRun).toHaveBeenCalledWith(PROJECT, 'run-9');
  });

  it('404s a run the projection does not return, without saying whose it is', async () => {
    getRun.mockResolvedValue(null);

    const res = await request(buildApp())
      .get('/api/playbooks/runs/someone-elses-run')
      .query({ project: PROJECT });

    expect(res.status).toBe(404);
  });

  it('clamps limit to the display cap and defaults when it is absent or junk', async () => {
    const app = buildApp();

    await request(app).get('/api/playbooks/runs').query({ project: PROJECT, limit: '5000' });
    expect(listRuns).toHaveBeenLastCalledWith(PROJECT, 50);

    await request(app).get('/api/playbooks/runs').query({ project: PROJECT, limit: 'abc' });
    expect(listRuns).toHaveBeenLastCalledWith(PROJECT, 50);

    await request(app).get('/api/playbooks/runs').query({ project: PROJECT, limit: '10' });
    expect(listRuns).toHaveBeenLastCalledWith(PROJECT, 10);
  });
});

describe('VT-11 — the route module reaches no engine table', () => {
  /*
   * The engine-table half of VT-11 is not asserted here. `playbookEngineBoundary.test.ts` already
   * scans every file under `src/server`, `src/client` and `src/shared` for the engine schema and
   * its table prefix, which is a stronger claim than this file could make about one route — and
   * naming those markers in code here would make *this* file an offender in that scan, which is
   * how it was discovered.
   *
   * What is left for this test is the part specific to the route: that its reads go through the
   * projection rather than through a query builder of its own. That is the drift TBI-025 (d)
   * actually guards against — not a sudden decision to query the engine, but one convenience
   * query added to the route, then another.
   */
  it('holds no query builder of its own', () => {
    /* eslint-disable @typescript-eslint/no-require-imports -- node built-ins in a test */
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'playbooks.ts'), 'utf8');

    expect(source).not.toContain('drizzle-orm');
    expect(source).not.toContain('db/schema');
    // Reads arrive by exactly one door.
    expect(source).toContain('playbookRunProjectionService');
  });
});
