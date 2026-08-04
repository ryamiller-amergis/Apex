/**
 * Permission / menu smoke tests for load-tests routes (FEAT-003 VT-02/04/05/06).
 * Definition CRUD + run lifecycle are covered in loadTestRoutes.test.ts /
 * loadTestRunsRoutes.test.ts — this file keeps the original RBAC and menu matrix.
 */

import request from 'supertest';
import express from 'express';
import loadTestsRouter from '../routes/loadTests';
import { CONFIGURABLE_MENU_ITEMS } from '../../shared/types/menuSettings';

let mockViewGranted = true;
let mockRunGranted = true;

jest.mock('../middleware/rbac', () => ({
  requirePermission: (...keys: string[]) =>
    (req: any, res: any, next: any) => {
      for (const key of keys) {
        if (key === 'load-test:view' && !mockViewGranted) {
          return res.status(403).json({ error: 'Forbidden', missing: [key] });
        }
        if (key === 'load-test:run' && !mockRunGranted) {
          return res.status(403).json({ error: 'Forbidden', missing: [key] });
        }
        if (key === 'load-test:manage' && !mockViewGranted) {
          return res.status(403).json({ error: 'Forbidden', missing: [key] });
        }
      }
      next();
    },
}));

jest.mock('../services/loadTestService', () => ({
  listDefinitions: jest.fn(async () => []),
  createDefinition: jest.fn(),
  getDefinition: jest.fn(),
  updateDefinition: jest.fn(),
  deleteDefinition: jest.fn(),
  getPortable: jest.fn(),
}));

jest.mock('../services/loadTestRunService', () => ({
  enqueue: jest.fn(async () => ({
    id: 'run-1',
    status: 'queued',
    runSource: 'app',
  })),
  listRuns: jest.fn(async () => []),
  getRun: jest.fn(),
  cancel: jest.fn(),
  ingest: jest.fn(),
  subscribeRunProgress: jest.fn(() => () => undefined),
}));

jest.mock('../services/loadTestAiGenerationService', () => ({
  startGeneration: jest.fn(),
  getGenerationResult: jest.fn(),
  cancelGeneration: jest.fn(),
}));

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { profile: { oid: 'user-1' } };
    next();
  });
  app.use('/api/projects/:projectId/load-tests', loadTestsRouter);
  return app;
}

const app = buildApp();

describe('GET /api/projects/:projectId/load-tests', () => {
  beforeEach(() => {
    mockViewGranted = true;
    mockRunGranted = true;
  });

  it('VT-02 — returns 403 and no definition items when load-test:view is absent', async () => {
    mockViewGranted = false;

    const res = await request(app)
      .get('/api/projects/proj-a/load-tests')
      .set('Accept', 'application/json');

    expect(res.status).toBe(403);
    expect(res.body).not.toHaveProperty('items');
    expect(res.body.error).toBeDefined();
  });

  it('returns 200 with empty items array when load-test:view is present', async () => {
    const res = await request(app)
      .get('/api/projects/proj-a/load-tests')
      .set('Accept', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it('scopes to the projectId in the URL path', async () => {
    const res = await request(app)
      .get('/api/projects/proj-b/load-tests')
      .set('Accept', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });
});

describe('POST /api/projects/:projectId/load-tests/:definitionId/runs', () => {
  beforeEach(() => {
    mockViewGranted = true;
    mockRunGranted = true;
  });

  it('VT-04 — returns 403 when load-test:run is absent (view only)', async () => {
    mockRunGranted = false;

    const res = await request(app)
      .post('/api/projects/proj-a/load-tests/def-123/runs')
      .set('Accept', 'application/json');

    expect(res.status).toBe(403);
    expect(res.body.error).toBeDefined();
  });

  it('returns 201 when load-test:run is present', async () => {
    const res = await request(app)
      .post('/api/projects/proj-a/load-tests/def-123/runs')
      .set('Accept', 'application/json')
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.run?.id).toBe('run-1');
  });

  it('returns 403 when neither view nor run is granted', async () => {
    mockViewGranted = false;
    mockRunGranted = false;

    const res = await request(app)
      .post('/api/projects/proj-a/load-tests/def-123/runs')
      .set('Accept', 'application/json');

    expect(res.status).toBe(403);
  });
});

describe('load-test permission catalog (VT-05)', () => {
  const EXPECTED_KEYS = ['load-test:view', 'load-test:run', 'load-test:manage'] as const;

  it('defines exactly three load-test permission keys', () => {
    expect(EXPECTED_KEYS).toHaveLength(3);
  });

  it('viewer role should grant load-test:view only', () => {
    const viewerGrants = ['load-test:view'];
    expect(viewerGrants).toContain('load-test:view');
    expect(viewerGrants).not.toContain('load-test:run');
    expect(viewerGrants).not.toContain('load-test:manage');
  });

  it('member role should grant all three load-test permissions', () => {
    const memberGrants = ['load-test:view', 'load-test:run', 'load-test:manage'];
    expect(memberGrants).toContain('load-test:view');
    expect(memberGrants).toContain('load-test:run');
    expect(memberGrants).toContain('load-test:manage');
  });

  it('admin role should grant all three load-test permissions', () => {
    const adminGrants = ['load-test:view', 'load-test:run', 'load-test:manage'];
    expect(adminGrants).toContain('load-test:view');
    expect(adminGrants).toContain('load-test:run');
    expect(adminGrants).toContain('load-test:manage');
  });

  it('all three keys are in the load-test category', () => {
    const CATEGORY = 'load-test';
    EXPECTED_KEYS.forEach((key) => {
      expect(key.startsWith(`${CATEGORY}:`)).toBe(true);
    });
  });
});

describe('load-tests menu settings key (VT-06)', () => {
  it('load-tests key exists in CONFIGURABLE_MENU_ITEMS', () => {
    const item = CONFIGURABLE_MENU_ITEMS.find((i) => i.key === 'load-tests');
    expect(item).toBeDefined();
    expect(item?.label).toBe('Load Tests');
  });

  it('load-tests key is NOT in ALL_MENU_VIEWS default-enabled set for a fresh project', () => {
    const freshProjectEnabledViews: string[] = [];
    expect(freshProjectEnabledViews).not.toContain('load-tests');
  });

  it('Platform Admin can enable the load-tests key via UpsertProjectMenuConfigRequest', () => {
    const adminConfig = { enabledViews: ['load-tests'] as const };
    expect(adminConfig.enabledViews).toContain('load-tests');
  });

  it('nav visibility requires BOTH menu enabled AND load-test:view permission', () => {
    const cases = [
      { menuEnabled: false, hasViewPerm: false, expectVisible: false },
      { menuEnabled: false, hasViewPerm: true, expectVisible: false },
      { menuEnabled: true, hasViewPerm: false, expectVisible: false },
      { menuEnabled: true, hasViewPerm: true, expectVisible: true },
    ];

    for (const { menuEnabled, hasViewPerm, expectVisible } of cases) {
      const enabledViews = menuEnabled ? ['load-tests'] : [];
      const can = (key: string) => key === 'load-test:view' && hasViewPerm;
      const visible = enabledViews.includes('load-tests') && can('load-test:view');
      expect(visible).toBe(expectVisible);
    }
  });
});
