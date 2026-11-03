import request from 'supertest';
import express, { type Request } from 'express';

let mockSuperAdmin = false;

jest.mock('../utils/superAdmin', () => ({ isSuperAdminRequest: () => mockSuperAdmin }));
jest.mock('../services/rbacService', () => ({ getUserPermissions: jest.fn(async () => new Set<string>()) }));
jest.mock('../services/groupService', () => ({ getUserGroupNames: jest.fn(async () => []) }));
jest.mock('../services/userProjectAssignmentService', () => ({ getAssignmentsForUser: jest.fn(async () => []) }));
jest.mock('../services/buildOrchestrator/startBuild', () => {
  const actual = jest.requireActual('../services/buildOrchestrator/startBuild');
  return { ...actual, startBuild: jest.fn() };
});
jest.mock('../services/buildQueryService', () => ({
  listBuilds: jest.fn(),
  listBuildRepositories: jest.fn(),
  normalizeListQuery: jest.fn(),
}));

import buildsRouter from '../routes/builds';
import { startBuild } from '../services/buildOrchestrator/startBuild';

const start = startBuild as jest.Mock;

function app() {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as Request & { user?: unknown }).user = { profile: { oid: 'admin-1' } };
    next();
  });
  server.use('/api/builds', buildsRouter);
  return server;
}

const body = { repository: 'apex', prompt: 'Add a reports page', clientRequestId: 'req-1' };

beforeEach(() => {
  jest.clearAllMocks();
  mockSuperAdmin = false;
  start.mockResolvedValue({
    buildRunId: 'build-1',
    playbookRunId: 'run-1',
    status: 'intake',
    queuePosition: null,
    queueReason: null,
    replayed: false,
  });
});

describe('VT-37 super admin start', () => {
  it('starts a build for a super admin who holds neither permission', async () => {
    mockSuperAdmin = true;
    const res = await request(app()).post('/api/builds?project=Apex').send(body);
    expect(res.status).toBe(202);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ requesterUserId: 'admin-1', project: 'Apex' }));
  });

  it('refuses the same request from a user without the permissions', async () => {
    const res = await request(app()).post('/api/builds?project=Apex').send(body);
    expect(res.status).toBe(403);
    expect(start).not.toHaveBeenCalled();
  });
});
