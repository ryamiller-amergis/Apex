/**
 * TBI-014 DoD-0, DoD-1, DoD-3; PBI-017 AC-3 / VT-05..VT-08, VT-13.
 * Real `requirePermission`; permissions are granted per project through a mocked source.
 */
jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../db', () => ({ __esModule: true, default: { end: jest.fn(), on: jest.fn() } }));

const getUserPermissions = jest.fn();
jest.mock('../services/rbacService', () => ({
  getUserPermissions: (...a: unknown[]) => getUserPermissions(...a),
}));

jest.mock('../utils/superAdmin', () => ({
  isSuperAdminRequest: () => false,
  getAppEnvironment: () => 'local',
}));

jest.mock('../services/groupService', () => ({
  getUserGroupNames: async () => [],
  getUserGroupNamesForProject: async () => [],
}));

jest.mock('../services/userProjectAssignmentService', () => ({
  getAssignmentsForUser: async () => ['Apex', 'Other'],
}));

const isFeatureEnabled = jest.fn(async () => false);
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: (...a: unknown[]) => isFeatureEnabled(...(a as [])),
}));

jest.mock('../services/buildOrchestrator/startBuild', () => ({
  startBuild: jest.fn(),
  refusalOf: () => null,
}));

jest.mock('../services/buildQueryService', () => ({
  listBuilds: jest.fn(),
  listBuildRepositories: jest.fn(),
  normalizeListQuery: () => ({}),
}));

const getBuildDetail = jest.fn();
const listBuildRunEvents = jest.fn();
jest.mock('../services/buildRunProjectionService', () => ({
  getBuildDetail: (...a: unknown[]) => getBuildDetail(...a),
  listBuildRunEvents: (...a: unknown[]) => listBuildRunEvents(...a),
  normalizeEventsLimit: jest.requireActual('../services/buildRunProjectionService').normalizeEventsLimit,
}));

import express from 'express';
import request from 'supertest';
import buildsRouter from '../routes/builds';

const USER_OID = 'viewer-oid';
const BUILD_ID = '00000000-0000-4000-8000-000000000001';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { profile: { oid: USER_OID } };
    next();
  });
  app.use('/api/builds', buildsRouter);
  return app;
}

function grantIn(project: string, ...keys: string[]): void {
  getUserPermissions.mockImplementation(async (_userId: string, requested?: string) =>
    requested === project ? new Set(keys) : new Set<string>());
}

const DETAIL = { build: { id: BUILD_ID, project: 'Apex', status: 'building' }, stage: { kind: 'stage', key: 'building' } };

beforeEach(() => {
  jest.clearAllMocks();
  grantIn('Apex', 'builds:view');
  getBuildDetail.mockResolvedValue({ kind: 'ok', detail: DETAIL });
  listBuildRunEvents.mockResolvedValue({ kind: 'ok', response: { events: [], total: 0 } });
});

describe('GET /api/builds/:id', () => {
  it('VT-05 TBI-014 DoD-0 passes the projection through for the caller project', async () => {
    const res = await request(buildApp()).get(`/api/builds/${BUILD_ID}?project=Apex`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DETAIL);
    expect(getBuildDetail).toHaveBeenCalledWith({ project: 'Apex', buildId: BUILD_ID });
  });

  it('VT-06 PBI-017 AC-3 returns 403 when builds:view is held only in another project', async () => {
    grantIn('Other', 'builds:view');
    const res = await request(buildApp()).get(`/api/builds/${BUILD_ID}?project=Apex`);
    expect(res.status).toBe(403);
    expect(res.body.build).toBeUndefined();
    expect(getBuildDetail).not.toHaveBeenCalled();
    expect(getUserPermissions).toHaveBeenCalledWith(USER_OID, 'Apex');
  });

  it('VT-06 returns 403 when the caller holds another key only', async () => {
    grantIn('Apex', 'builds:run');
    const res = await request(buildApp()).get(`/api/builds/${BUILD_ID}/events?project=Apex`);
    expect(res.status).toBe(403);
    expect(listBuildRunEvents).not.toHaveBeenCalled();
  });

  it('VT-06 returns 404 when no project is named', async () => {
    const detail = await request(buildApp()).get(`/api/builds/${BUILD_ID}`);
    const events = await request(buildApp()).get(`/api/builds/${BUILD_ID}/events`);
    expect(detail.status).toBe(404);
    expect(events.status).toBe(404);
    expect(getBuildDetail).not.toHaveBeenCalled();
  });

  it('VT-07 TBI-014 DoD-3 returns 403 Forbidden with no build data for a build in another project', async () => {
    getBuildDetail.mockResolvedValue({ kind: 'wrong-project' });
    listBuildRunEvents.mockResolvedValue({ kind: 'wrong-project' });
    const detail = await request(buildApp()).get(`/api/builds/${BUILD_ID}?project=Apex`);
    const events = await request(buildApp()).get(`/api/builds/${BUILD_ID}/events?project=Apex`);
    expect(detail.status).toBe(403);
    expect(detail.body).toEqual({ error: 'Forbidden' });
    expect(events.status).toBe(403);
    expect(events.body).toEqual({ error: 'Forbidden' });
  });

  it('returns 404 when the build does not exist', async () => {
    getBuildDetail.mockResolvedValue({ kind: 'not-found' });
    const res = await request(buildApp()).get(`/api/builds/${BUILD_ID}?project=Apex`);
    expect(res.status).toBe(404);
  });

  it('accepts the projectId alias', async () => {
    const res = await request(buildApp()).get(`/api/builds/${BUILD_ID}?projectId=Apex`);
    expect(res.status).toBe(200);
  });

  it('VT-08 serves both routes with the flag off and never checks the flag', async () => {
    const detail = await request(buildApp()).get(`/api/builds/${BUILD_ID}?project=Apex`);
    const events = await request(buildApp()).get(`/api/builds/${BUILD_ID}/events?project=Apex`);
    expect(detail.status).toBe(200);
    expect(events.status).toBe(200);
    expect(isFeatureEnabled).not.toHaveBeenCalled();
  });
});

describe('GET /api/builds/:id/events', () => {
  it.each([
    ['5000', 500],
    ['abc', 200],
    ['10', 10],
  ])('VT-13 TBI-014 DoD-1 clamps limit %s to %d', async (raw, expected) => {
    const res = await request(buildApp()).get(`/api/builds/${BUILD_ID}/events?project=Apex&limit=${raw}`);
    expect(res.status).toBe(200);
    expect(listBuildRunEvents).toHaveBeenCalledWith({ project: 'Apex', buildId: BUILD_ID, limit: expected });
  });

  it('VT-13 passes the projection body through', async () => {
    const body = { events: [{ id: 'e1', occurredAt: '2026-10-28T10:00:00.000Z', kind: 'task.merged', message: 'Merged', taskKey: null }], total: 600 };
    listBuildRunEvents.mockResolvedValue({ kind: 'ok', response: body });
    const res = await request(buildApp()).get(`/api/builds/${BUILD_ID}/events?project=Apex`);
    expect(res.body).toEqual(body);
  });
});
