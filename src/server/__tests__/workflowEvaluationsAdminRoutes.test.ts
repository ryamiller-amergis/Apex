/**
 * Admin workflow evaluation routes: guard chain, list, detail, appendix, export.
 */
import request from 'supertest';
import express from 'express';

let permissionGranted = true;
let projectAccessGranted = true;
let flagEnabled = true;
const requestedPermissions: string[][] = [];

jest.mock('../middleware/rbac', () => {
  const actual = jest.requireActual('../middleware/rbac') as {
    resolveRequestProject: (req: express.Request) => string | undefined;
  };
  return {
    requirePermission: (...keys: string[]) =>
      (_req: express.Request, res: express.Response, next: express.NextFunction) => {
        requestedPermissions.push(keys);
        if (keys.includes('admin:roles') && !permissionGranted) {
          res.status(403).json({ error: 'Forbidden', missing: keys });
          return;
        }
        next();
      },
    requireProjectAccess: () =>
      (_req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (!projectAccessGranted) {
          res.status(403).json({ error: 'Forbidden' });
          return;
        }
        next();
      },
    resolveRequestProject: actual.resolveRequestProject,
  };
});

jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn(async () => flagEnabled),
  isFeatureOperational: jest.fn(async () => flagEnabled),
}));

jest.mock('../services/workflowEvaluationService', () => ({}));
jest.mock('../services/workflowEvaluationJobOrchestrator', () => ({
  createWorkflowEvaluationJobOrchestrator: () => ({ retryJob: jest.fn() }),
  registerWorkflowEvaluationJobListener: jest.fn(),
}));

const mockList = jest.fn();
const mockDetail = jest.fn();
const mockAppendix = jest.fn();
const mockExport = jest.fn();
jest.mock('../services/workflowEvaluationAdminService', () => {
  const actual = jest.requireActual('../services/workflowEvaluationAdminService');
  return {
    ...actual,
    listAdminEvaluationEvents: (...args: unknown[]) => mockList(...args),
    getAdminEvaluationEventDetail: (...args: unknown[]) => mockDetail(...args),
    getAdminEvaluationJudgeAppendix: (...args: unknown[]) => mockAppendix(...args),
    exportAdminEvaluationEvents: (...args: unknown[]) => mockExport(...args),
  };
});

const mockGetSettings = jest.fn();
const mockUpdateSettings = jest.fn();
jest.mock('../services/workflowEvaluationModelSettingsService', () => {
  const actual = jest.requireActual('../services/workflowEvaluationModelSettingsService');
  return {
    ...actual,
    getEvaluationModelSettings: (...args: unknown[]) => mockGetSettings(...args),
    updateEvaluationModelSettings: (...args: unknown[]) => mockUpdateSettings(...args),
  };
});

import workflowEvaluationsRouter from '../routes/workflowEvaluations';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const BASE = '/api/projects/proj-a/workflow-evaluations/admin';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: unknown }).user = { profile: { oid: 'user-1', displayName: 'Ada' } };
    next();
  });
  app.use('/api/projects/:projectId/workflow-evaluations', workflowEvaluationsRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  requestedPermissions.length = 0;
  permissionGranted = true;
  projectAccessGranted = true;
  flagEnabled = true;
  mockList.mockResolvedValue({ items: [], nextCursor: null });
  mockDetail.mockResolvedValue({ id: EVENT_ID });
  mockAppendix.mockResolvedValue({ status: 'ok', markdown: '# Narrative' });
  mockExport.mockResolvedValue({
    status: 'ok',
    filename: 'workflow-evaluations-proj-a-2026-10-21.csv',
    contentType: 'text/csv; charset=utf-8',
    body: 'event_id\r\n',
    rowCount: 0,
  });
});

describe('admin workflow evaluation routes', () => {
  it('lists events for the path project with parsed filters', async () => {
    const res = await request(buildApp()).get(`${BASE}/events?outcome=reject&from=2026-10-01&limit=10`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
    expect(mockList).toHaveBeenCalledWith('proj-a', { outcome: 'reject', from: '2026-10-01' }, { limit: 10, cursor: undefined });
    expect(requestedPermissions).toContainEqual(['admin:roles']);
  });

  it.each([
    ['outcome=maybe'],
    ['limit=500'],
    ['cursor=junk'],
    ['from=2026-10-21&to=2026-10-01'],
  ])('answers 400 for %s', async (query) => {
    const res = await request(buildApp()).get(`${BASE}/events?${query}`);
    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('answers 403 without admin:roles', async () => {
    permissionGranted = false;
    const res = await request(buildApp()).get(`${BASE}/events`);
    expect(res.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('answers 403 for a caller not assigned to the project', async () => {
    projectAccessGranted = false;
    const res = await request(buildApp()).get(`${BASE}/events`);
    expect(res.status).toBe(403);
  });

  it('answers 404 when the flag is off', async () => {
    flagEnabled = false;
    const res = await request(buildApp()).get(`${BASE}/events`);
    expect(res.status).toBe(404);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('answers 400 when ?project= names another project', async () => {
    const res = await request(buildApp()).get(`${BASE}/events?project=proj-b`);
    expect(res.status).toBe(400);
  });

  it('returns detail wrapped in { event } and 404 for missing or malformed ids', async () => {
    const ok = await request(buildApp()).get(`${BASE}/events/${EVENT_ID}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ event: { id: EVENT_ID } });
    expect(mockDetail).toHaveBeenCalledWith('proj-a', EVENT_ID);

    mockDetail.mockResolvedValueOnce(null);
    expect((await request(buildApp()).get(`${BASE}/events/${EVENT_ID}`)).status).toBe(404);
    expect((await request(buildApp()).get(`${BASE}/events/not-a-uuid`)).status).toBe(404);
  });

  it('returns the appendix, 404 when absent, 502 when the read fails', async () => {
    const ok = await request(buildApp()).get(`${BASE}/events/${EVENT_ID}/judge-appendix`);
    expect(ok.body).toEqual({ markdown: '# Narrative' });

    mockAppendix.mockResolvedValueOnce({ status: 'not_found' });
    expect((await request(buildApp()).get(`${BASE}/events/${EVENT_ID}/judge-appendix`)).status).toBe(404);

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockAppendix.mockRejectedValueOnce(new Error('blob down'));
    expect((await request(buildApp()).get(`${BASE}/events/${EVENT_ID}/judge-appendix`)).status).toBe(502);
    errorSpy.mockRestore();
  });

  it('exports as an attachment', async () => {
    const res = await request(buildApp()).get(`${BASE}/export?format=csv&outcome=reject`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toBe('attachment; filename="workflow-evaluations-proj-a-2026-10-21.csv"');
    expect(mockExport).toHaveBeenCalledWith('proj-a', { outcome: 'reject' }, 'csv', 'user-1');
  });

  it('rejects an unknown export format and a too-large export without an attachment', async () => {
    const bad = await request(buildApp()).get(`${BASE}/export?format=xml`);
    expect(bad.status).toBe(400);

    mockExport.mockResolvedValueOnce({ status: 'too_many', limit: 2000 });
    const tooMany = await request(buildApp()).get(`${BASE}/export?format=json`);
    expect(tooMany.status).toBe(422);
    expect(tooMany.headers['content-disposition']).toBeUndefined();
  });

  it('reads the evaluation model settings for the path project', async () => {
    const settings = {
      hasSkillConfig: true,
      model: null,
      effort: null,
      effective: { model: 'composer-2.5', effort: null, source: 'app_default' },
    };
    mockGetSettings.mockResolvedValueOnce(settings);
    const res = await request(buildApp()).get(`${BASE}/settings`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(settings);
    expect(mockGetSettings).toHaveBeenCalledWith('proj-a');
  });

  it('saves a trimmed model and effort as the signed-in user', async () => {
    mockUpdateSettings.mockResolvedValueOnce({ hasSkillConfig: true });
    const res = await request(buildApp())
      .put(`${BASE}/settings`)
      .send({ model: ' claude-sonnet ', effort: 'high' });
    expect(res.status).toBe(200);
    expect(mockUpdateSettings).toHaveBeenCalledWith('proj-a', { model: 'claude-sonnet', effort: 'high' }, 'Ada');
  });

  it.each([
    [{ model: '', effort: null }],
    [{ model: 'x'.repeat(201), effort: null }],
    [{ model: 42, effort: null }],
    [{ model: null, effort: 'max' }],
    [{ model: null }],
  ])('answers 400 for settings %j', async (body) => {
    const res = await request(buildApp()).put(`${BASE}/settings`).send(body);
    expect(res.status).toBe(400);
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });

  it('answers 409 when the project has no default skill configuration', async () => {
    mockUpdateSettings.mockResolvedValueOnce(null);
    const res = await request(buildApp()).put(`${BASE}/settings`).send({ model: null, effort: null });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_SKILL_CONFIG');
  });
});
