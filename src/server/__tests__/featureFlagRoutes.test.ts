/**
 * Tests for the feature-flag management routes (platformAdmin) and the
 * evaluation route (featureFlags).
 */
import request from 'supertest';
import express from 'express';
import platformAdminRouter from '../routes/platformAdmin';
import featureFlagRouter from '../routes/featureFlags';
import * as featureFlagService from '../services/featureFlagService';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../services/featureFlagService');
jest.mock('../services/menuSettingsService');
jest.mock('../services/userProjectAssignmentService');
jest.mock('../services/projectCatalogService');
jest.mock('../services/projectAccessRequestService');
jest.mock('../services/pendingAssignmentService');
jest.mock('../services/groupService', () => ({
  listGroups: jest.fn(),
}));

jest.mock('../middleware/rbac', () => ({
  requireSuperAdmin: (_req: any, _res: any, next: any) => next(),
}));

const mockService = featureFlagService as jest.Mocked<typeof featureFlagService>;

// ── App factory ────────────────────────────────────────────────────────────────

function buildAdminApp(userOid = 'admin-oid', userEmail = 'admin@example.com') {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = { profile: { oid: userOid, upn: userEmail } };
    next();
  });
  app.use('/api/platform-admin', platformAdminRouter);
  return app;
}

function buildEvalApp(userOid = 'user-oid') {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = userOid ? { profile: { oid: userOid } } : undefined;
    next();
  });
  app.use('/api/feature-flags', featureFlagRouter);
  return app;
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const flagFixture = {
  id: 'flag-1',
  key: 'dark-mode',
  description: 'Dark mode toggle',
  enabled: true,
  lifecycle: 'active' as const,
  cleanupReady: false,
  createdBy: 'admin-oid',
  createdAt: '2026-06-30T00:00:00Z',
  updatedAt: '2026-06-30T00:00:00Z',
  rules: [],
};

const ruleFixture = {
  id: 'rule-1',
  flagId: 'flag-1',
  type: 'project' as const,
  value: 'my-project',
  createdBy: 'admin-oid',
  createdAt: '2026-06-30T00:00:00Z',
};

// ── GET /api/platform-admin/feature-flags ─────────────────────────────────────

describe('GET /api/platform-admin/feature-flags', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with the list of flags', async () => {
    mockService.listFlags.mockResolvedValue([flagFixture]);

    const res = await request(buildAdminApp()).get('/api/platform-admin/feature-flags');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ key: 'dark-mode' });
  });

  it('returns 500 when listFlags throws', async () => {
    mockService.listFlags.mockRejectedValue(new Error('DB error'));

    const res = await request(buildAdminApp()).get('/api/platform-admin/feature-flags');

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Internal server error' });
  });
});

// ── POST /api/platform-admin/feature-flags ────────────────────────────────────

describe('POST /api/platform-admin/feature-flags', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 201 with the created flag', async () => {
    mockService.createFlag.mockResolvedValue(flagFixture);

    const res = await request(buildAdminApp())
      .post('/api/platform-admin/feature-flags')
      .send({ key: 'dark-mode', description: 'Dark mode toggle' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ key: 'dark-mode' });
    expect(mockService.createFlag).toHaveBeenCalledWith(
      { key: 'dark-mode', description: 'Dark mode toggle' },
      { id: 'admin-oid', email: 'admin@example.com' },
    );
  });

  it('returns 400 for invalid flag key', async () => {
    mockService.createFlag.mockRejectedValue(new Error('Invalid flag key "BAD": must be kebab-case (a-z, 0-9, hyphens)'));

    const res = await request(buildAdminApp())
      .post('/api/platform-admin/feature-flags')
      .send({ key: 'BAD' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid flag key');
  });

  it('returns 500 for unexpected errors', async () => {
    mockService.createFlag.mockRejectedValue(new Error('DB error'));

    const res = await request(buildAdminApp())
      .post('/api/platform-admin/feature-flags')
      .send({ key: 'new-flag' });

    expect(res.status).toBe(500);
  });
});

// ── PATCH /api/platform-admin/feature-flags/:id ───────────────────────────────

describe('PATCH /api/platform-admin/feature-flags/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with the updated flag', async () => {
    mockService.updateFlag.mockResolvedValue({ ...flagFixture, enabled: false });

    const res = await request(buildAdminApp())
      .patch('/api/platform-admin/feature-flags/flag-1')
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false });
  });

  it('returns 404 when flag not found', async () => {
    mockService.updateFlag.mockRejectedValue(new Error('Flag not found: flag-999'));

    const res = await request(buildAdminApp())
      .patch('/api/platform-admin/feature-flags/flag-999')
      .send({ enabled: true });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Flag not found' });
  });

  it('returns 500 for unexpected errors', async () => {
    mockService.updateFlag.mockRejectedValue(new Error('DB error'));

    const res = await request(buildAdminApp())
      .patch('/api/platform-admin/feature-flags/flag-1')
      .send({ enabled: true });

    expect(res.status).toBe(500);
  });
});

// ── DELETE /api/platform-admin/feature-flags/:id ──────────────────────────────

describe('DELETE /api/platform-admin/feature-flags/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 204 on successful delete', async () => {
    mockService.deleteFlag.mockResolvedValue(undefined);

    const res = await request(buildAdminApp()).delete('/api/platform-admin/feature-flags/flag-1');

    expect(res.status).toBe(204);
    expect(mockService.deleteFlag).toHaveBeenCalledWith('flag-1', { id: 'admin-oid', email: 'admin@example.com' });
  });

  it('returns 500 when deleteFlag throws', async () => {
    mockService.deleteFlag.mockRejectedValue(new Error('DB error'));

    const res = await request(buildAdminApp()).delete('/api/platform-admin/feature-flags/flag-1');

    expect(res.status).toBe(500);
  });
});

// ── POST /api/platform-admin/feature-flags/:id/rules ──────────────────────────

describe('POST /api/platform-admin/feature-flags/:id/rules', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 201 with the created rule', async () => {
    mockService.addRule.mockResolvedValue(ruleFixture);

    const res = await request(buildAdminApp())
      .post('/api/platform-admin/feature-flags/flag-1/rules')
      .send({ type: 'project', value: 'my-project' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'project', value: 'my-project' });
  }, 15_000);

  it('returns 404 when flag not found', async () => {
    mockService.addRule.mockRejectedValue(new Error('Flag not found: flag-999'));

    const res = await request(buildAdminApp())
      .post('/api/platform-admin/feature-flags/flag-999/rules')
      .send({ type: 'project', value: 'x' });

    expect(res.status).toBe(404);
  });

  it('returns 500 for unexpected errors', async () => {
    mockService.addRule.mockRejectedValue(new Error('DB error'));

    const res = await request(buildAdminApp())
      .post('/api/platform-admin/feature-flags/flag-1/rules')
      .send({ type: 'project', value: 'x' });

    expect(res.status).toBe(500);
  });
});

// ── DELETE /api/platform-admin/feature-flags/:id/rules/:ruleId ────────────────

describe('DELETE /api/platform-admin/feature-flags/:id/rules/:ruleId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 204 on successful rule removal', async () => {
    mockService.removeRule.mockResolvedValue(undefined);

    const res = await request(buildAdminApp()).delete('/api/platform-admin/feature-flags/flag-1/rules/rule-1');

    expect(res.status).toBe(204);
    expect(mockService.removeRule).toHaveBeenCalledWith('rule-1', { id: 'admin-oid', email: 'admin@example.com' });
  });
});

// ── GET /api/platform-admin/feature-flags/:id/audit ───────────────────────────

describe('GET /api/platform-admin/feature-flags/:id/audit', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with audit entries', async () => {
    const auditEntry = {
      id: 'audit-1',
      flagId: 'flag-1',
      flagKey: 'dark-mode',
      action: 'created' as const,
      actorId: 'admin-oid',
      actorEmail: 'admin@example.com',
      details: null,
      createdAt: '2026-06-30T00:00:00Z',
    };
    mockService.getFlagAudit.mockResolvedValue([auditEntry]);

    const res = await request(buildAdminApp()).get('/api/platform-admin/feature-flags/flag-1/audit');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ action: 'created' });
  });
});

// ── GET /api/feature-flags/evaluate ───────────────────────────────────────────

describe('GET /api/feature-flags/evaluate', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with evaluated flags', async () => {
    mockService.getUserGroupIdsForProject.mockResolvedValue(['grp-1']);
    mockService.evaluateFlags.mockResolvedValue({ 'dark-mode': true, 'new-nav': false });

    const res = await request(buildEvalApp()).get('/api/feature-flags/evaluate?project=my-project');

    expect(res.status).toBe(200);
    expect(res.body.flags).toEqual({ 'dark-mode': true, 'new-nav': false });
    expect(mockService.getUserGroupIdsForProject).toHaveBeenCalledWith('user-oid', 'my-project');
    expect(mockService.evaluateFlags).toHaveBeenCalledWith({
      userId: 'user-oid',
      project: 'my-project',
      groupIds: ['grp-1'],
    });
  });

  it('returns 400 when project query param is missing', async () => {
    const res = await request(buildEvalApp()).get('/api/feature-flags/evaluate');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'project query parameter is required' });
  });

  it('returns 401 when user is not authenticated', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.user = undefined;
      next();
    });
    app.use('/api/feature-flags', featureFlagRouter);

    const res = await request(app).get('/api/feature-flags/evaluate?project=my-project');

    expect(res.status).toBe(401);
  });

  it('returns 500 when evaluateFlags throws', async () => {
    mockService.getUserGroupIdsForProject.mockResolvedValue([]);
    mockService.evaluateFlags.mockRejectedValue(new Error('DB error'));

    const res = await request(buildEvalApp()).get('/api/feature-flags/evaluate?project=my-project');

    expect(res.status).toBe(500);
  });
});
