import request from 'supertest';
import express, { type Request } from 'express';
import { BuildStartError } from '../services/buildOrchestrator/errors';

let permissions = new Set(['builds:run', 'playbooks:run', 'builds:view']);

jest.mock('../middleware/rbac', () => ({
  requirePermission: (...keys: string[]) => (_req: unknown, res: express.Response, next: () => void) => {
    if (keys.some((key) => !permissions.has(key))) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  },
  requireProjectAccess: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveRequestProject: (req: Request) => {
    const query = req.query?.project;
    if (typeof query === 'string' && query.length > 0) return query;
    const body = (req.body as { project?: unknown } | undefined)?.project;
    return typeof body === 'string' ? body : null;
  },
}));

jest.mock('../services/buildOrchestrator/startBuild', () => {
  const actual = jest.requireActual('../services/buildOrchestrator/startBuild');
  return { ...actual, startBuild: jest.fn() };
});

jest.mock('../services/buildQueryService', () => ({
  listBuilds: jest.fn(),
  listBuildRepositories: jest.fn(),
  normalizeListQuery: jest.requireActual('../services/buildQueryService').normalizeListQuery,
}));

import buildsRouter from '../routes/builds';
import { startBuild } from '../services/buildOrchestrator/startBuild';
import { listBuilds, normalizeListQuery } from '../services/buildQueryService';

const start = startBuild as jest.Mock;
const list = listBuilds as jest.Mock;

function app() {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as Request & { user?: unknown }).user = { profile: { oid: 'user-1' } };
    next();
  });
  server.use('/api/builds', buildsRouter);
  return server;
}

const body = {
  project: 'Apex',
  repository: 'apex',
  prompt: 'Add a reports page',
  clientRequestId: 'req-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  permissions = new Set(['builds:run', 'playbooks:run', 'builds:view']);
  start.mockResolvedValue({
    buildRunId: 'build-1',
    playbookRunId: 'run-1',
    status: 'intake',
    queuePosition: null,
    queueReason: null,
    replayed: false,
  });
  list.mockResolvedValue({ builds: [], total: 0, limit: 50, offset: 0 });
});

describe('POST /api/builds', () => {
  it('VT-08 returns 403 before start when builds:run is missing', async () => {
    permissions = new Set(['playbooks:run', 'builds:view']);
    const res = await request(app()).post('/api/builds?project=Apex').send(body);
    expect(res.status).toBe(403);
    expect(start).not.toHaveBeenCalled();
  });

  it('VT-01 returns 202 for an accepted start', async () => {
    const res = await request(app()).post('/api/builds?project=Apex').send(body);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('intake');
  });

  it('VT-03 returns 409 with every refusal sentence and no prompt', async () => {
    start.mockRejectedValue(new BuildStartError(409, 'BUILD_PREFLIGHT_REFUSED', 'Three items need attention.', [
      { code: 'code_map_missing', item: 'code map', message: 'The code map is missing.', fixer: 'platform_admin', fixerLabel: 'A Platform Admin' },
      { code: 'coding_rules_missing', item: 'rules', message: 'The coding rules are missing.', fixer: 'platform_admin', fixerLabel: 'A Platform Admin' },
      { code: 'pipeline_unusable', item: 'pipeline', message: 'The pipeline is not set.', fixer: 'project_admin', fixerLabel: 'A project admin' },
    ]));
    const res = await request(app()).post('/api/builds?project=Apex').send(body);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BUILD_PREFLIGHT_REFUSED');
    expect(res.body.refusals).toHaveLength(3);
    expect(JSON.stringify(res.body)).not.toContain('Add a reports page');
  });
});

describe('GET /api/builds', () => {
  it('VT-19 stays available to builds:view and accepts projectId', async () => {
    permissions = new Set(['builds:view']);
    const res = await request(app()).get('/api/builds?projectId=Apex&limit=80');
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ project: 'Apex', limit: 50 }));
  });

  it('VT-20 caps the page at 50', () => {
    expect(normalizeListQuery({ limit: '500', offset: '-3', scope: 'mine', state: 'active' })).toEqual({
      limit: 50,
      offset: 0,
      scope: 'mine',
      state: 'active',
    });
  });
});
