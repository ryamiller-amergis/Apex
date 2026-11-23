/**
 * Integration-style tests for /api/incident-triage routes.
 * RBAC, the flag service, the store and the sweep are mocked.
 */
import request from 'supertest';
import express, { type NextFunction, type Request, type Response } from 'express';

const mockIsFeatureEnabled = jest.fn();
const mockListIncidents = jest.fn();
const mockGetIncidentDetail = jest.fn();
const mockGetSettings = jest.fn();
const mockUpsertSettings = jest.fn();
const mockSweepProject = jest.fn();
const mockRequestIncidentAnalysis = jest.fn();
const mockSendTestCard = jest.fn();
const mockIsServiceNowConfigured = jest.fn();
const mockGrantedPermissions = new Set<string>();
let mockAssignedProjects: string[] = [];

class MockSweepUnavailableError extends Error {
  readonly reason: 'not_enabled' | 'not_configured';

  constructor(reason: 'not_enabled' | 'not_configured') {
    super(reason);
    this.name = 'IncidentTriageSweepUnavailableError';
    this.reason = reason;
  }
}

jest.mock('../middleware/rbac', () => ({
  requirePermission: (key: string) => (_req: Request, res: Response, next: NextFunction) =>
    mockGrantedPermissions.has(key) ? next() : res.status(403).json({ error: 'Forbidden' }),
  requireProjectAccess:
    (resolve: (req: Request) => string | undefined) => (req: Request, res: Response, next: NextFunction) =>
      mockAssignedProjects.includes(resolve(req) ?? '')
        ? next()
        : res.status(403).json({ error: 'Forbidden: not assigned to this project' }),
  resolveRequestProject: (req: Request) =>
    (typeof req.query?.project === 'string' && req.query.project)
    || (typeof req.body?.project === 'string' && req.body.project)
    || undefined,
}));
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}));
jest.mock('../services/incidentTriageStore', () => ({
  listIncidents: (...args: unknown[]) => mockListIncidents(...args),
  getIncidentDetail: (...args: unknown[]) => mockGetIncidentDetail(...args),
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  upsertSettings: (...args: unknown[]) => mockUpsertSettings(...args),
  defaultSettings: (project: string) => ({
    project,
    enabled: false,
    assignmentGroupIds: [],
    backfillDays: 7,
    watermark: null,
    lastSweepAt: null,
    lastSweepError: null,
    teamsWebhookMasked: null,
  }),
}));
jest.mock('../services/incidentTriageSweep', () => ({
  IncidentTriageSweepUnavailableError: MockSweepUnavailableError,
  sweepProject: (...args: unknown[]) => mockSweepProject(...args),
}));
jest.mock('../services/incidentTriageRuns', () => ({
  requestIncidentAnalysis: (...args: unknown[]) => mockRequestIncidentAnalysis(...args),
}));
jest.mock('../services/incidentTriageTeams', () => ({
  sendIncidentTriageTestCard: (...args: unknown[]) => mockSendTestCard(...args),
}));
jest.mock('../services/serviceNowClient', () => ({
  ...jest.requireActual('../services/serviceNowClient'),
  isServiceNowConfigured: () => mockIsServiceNowConfigured(),
}));

import incidentTriageRouter from '../routes/incidentTriage';
import { ServiceNowRequestError } from '../services/serviceNowClient';

const PROJECT = 'Apex';
const q = `project=${encodeURIComponent(PROJECT)}`;
const INCIDENT_ID = '3f2c1e1a-4b5d-4c6e-8f70-1a2b3c4d5e6f';
const GROUP_ID = 'a'.repeat(32);

function buildApp(userOid = 'user-1') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Request & { user?: unknown }).user = { profile: { oid: userOid } };
    next();
  });
  app.use('/api/incident-triage', incidentTriageRouter);
  app.use((err: { status?: number; message?: string }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? 'error' });
  });
  return app;
}

function settingsFixture(overrides: Record<string, unknown> = {}) {
  return {
    project: PROJECT,
    enabled: true,
    assignmentGroupIds: [GROUP_ID],
    backfillDays: 7,
    watermark: null,
    lastSweepAt: null,
    lastSweepError: null,
    teamsWebhookMasked: null,
    ...overrides,
  };
}

const INCIDENT = {
  id: INCIDENT_ID,
  project: PROJECT,
  sysId: 'b'.repeat(32),
  number: 'INC0012345',
  shortDescription: 'Timecard page fails',
  latestAnalysis: null,
};

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockIsFeatureEnabled.mockResolvedValue(true);
  mockIsServiceNowConfigured.mockReturnValue(true);
  mockGrantedPermissions.clear();
  ['incident-triage:view', 'incident-triage:run', 'incident-triage:manage'].forEach((key) =>
    mockGrantedPermissions.add(key),
  );
  mockAssignedProjects = [PROJECT];
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('flag and access', () => {
  it('404 when the flag is off', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);

    const res = await request(buildApp()).get(`/api/incident-triage/incidents?${q}`);

    expect(res.status).toBe(404);
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith('servicenow-incident-triage', {
      userId: 'user-1',
      project: PROJECT,
    });
    expect(mockListIncidents).not.toHaveBeenCalled();
  });

  it('403 without the permission', async () => {
    mockGrantedPermissions.clear();

    const res = await request(buildApp()).get(`/api/incident-triage/incidents?${q}`);

    expect(res.status).toBe(403);
    expect(mockListIncidents).not.toHaveBeenCalled();
  });

  it('403 when the user lacks the permission for a manage route', async () => {
    mockGrantedPermissions.delete('incident-triage:manage');

    const settings = await request(buildApp()).get(`/api/incident-triage/settings?${q}`);
    const update = await request(buildApp())
      .put('/api/incident-triage/settings')
      .send({ project: PROJECT, enabled: true });

    expect(settings.status).toBe(403);
    expect(update.status).toBe(403);
    expect(mockUpsertSettings).not.toHaveBeenCalled();
  });

  it('403 when the user lacks the run permission for sweep', async () => {
    mockGrantedPermissions.delete('incident-triage:run');

    const res = await request(buildApp()).post('/api/incident-triage/sweep').send({ project: PROJECT });

    expect(res.status).toBe(403);
    expect(mockSweepProject).not.toHaveBeenCalled();
  });

  it('403 for a project the user cannot access', async () => {
    mockAssignedProjects = ['Other'];

    const res = await request(buildApp()).get(`/api/incident-triage/incidents?${q}`);

    expect(res.status).toBe(403);
    expect(mockListIncidents).not.toHaveBeenCalled();
  });

  it('400 when the project is missing', async () => {
    const res = await request(buildApp()).get('/api/incident-triage/incidents');

    expect(res.status).toBe(400);
  });
});

describe('GET /incidents', () => {
  it('lists incidents', async () => {
    mockListIncidents.mockResolvedValue([INCIDENT]);

    const res = await request(buildApp()).get(
      `/api/incident-triage/incidents?${q}&verdict=bug&state=In%20Progress&q=timecard&limit=10`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ incidents: [INCIDENT] });
    expect(mockListIncidents).toHaveBeenCalledWith(PROJECT, {
      verdict: 'bug',
      state: 'In Progress',
      q: 'timecard',
      limit: 10,
    });
  });

  it('uses a default limit and caps a large one', async () => {
    mockListIncidents.mockResolvedValue([]);

    await request(buildApp()).get(`/api/incident-triage/incidents?${q}`);
    await request(buildApp()).get(`/api/incident-triage/incidents?${q}&limit=9999`);

    expect(mockListIncidents.mock.calls[0][1].limit).toBe(50);
    expect(mockListIncidents.mock.calls[1][1].limit).toBe(200);
  });

  it('400 for an unknown verdict', async () => {
    const res = await request(buildApp()).get(`/api/incident-triage/incidents?${q}&verdict=nope`);

    expect(res.status).toBe(400);
    expect(mockListIncidents).not.toHaveBeenCalled();
  });
});

describe('GET /incidents/:id', () => {
  it('returns the incident with its analyses', async () => {
    mockGetIncidentDetail.mockResolvedValue({ incident: INCIDENT, analyses: [] });

    const res = await request(buildApp()).get(`/api/incident-triage/incidents/${INCIDENT_ID}?${q}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ incident: INCIDENT, analyses: [] });
    expect(mockGetIncidentDetail).toHaveBeenCalledWith(PROJECT, INCIDENT_ID);
  });

  it('detail 404 for an unknown id', async () => {
    mockGetIncidentDetail.mockResolvedValue(null);

    const res = await request(buildApp()).get(`/api/incident-triage/incidents/${INCIDENT_ID}?${q}`);

    expect(res.status).toBe(404);
  });

  it('404 for an id that is not a uuid, without touching the store', async () => {
    const res = await request(buildApp()).get(`/api/incident-triage/incidents/not-a-uuid?${q}`);

    expect(res.status).toBe(404);
    expect(mockGetIncidentDetail).not.toHaveBeenCalled();
  });
});

describe('POST /sweep', () => {
  it('sweep returns counts', async () => {
    mockSweepProject.mockResolvedValue({ fetched: 3, upserted: 2, newAnalyses: 1 });

    const res = await request(buildApp()).post('/api/incident-triage/sweep').send({ project: PROJECT });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ fetched: 3, upserted: 2, newAnalyses: 1 });
    expect(mockSweepProject).toHaveBeenCalledWith(PROJECT, { requestedBy: 'user-1' });
  });

  it('sweep 409 when disabled', async () => {
    mockSweepProject.mockRejectedValue(new MockSweepUnavailableError('not_enabled'));

    const res = await request(buildApp()).post('/api/incident-triage/sweep').send({ project: PROJECT });

    expect(res.status).toBe(409);
  });

  it('503 when not configured', async () => {
    mockSweepProject.mockRejectedValue(new MockSweepUnavailableError('not_configured'));

    const res = await request(buildApp()).post('/api/incident-triage/sweep').send({ project: PROJECT });

    expect(res.status).toBe(503);
  });

  it('502 with the safe message on a ServiceNow error', async () => {
    mockSweepProject.mockRejectedValue(
      new ServiceNowRequestError('ServiceNow request failed (HTTP 500)', 500),
    );

    const res = await request(buildApp()).post('/api/incident-triage/sweep').send({ project: PROJECT });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'ServiceNow request failed (HTTP 500)' });
  });

  it('passes any other error to the error handler', async () => {
    mockSweepProject.mockRejectedValue(new Error('database down'));

    const res = await request(buildApp()).post('/api/incident-triage/sweep').send({ project: PROJECT });

    expect(res.status).toBe(500);
  });
});

describe('POST /incidents/:id/analyze', () => {
  const analyzeUrl = `/api/incident-triage/incidents/${INCIDENT_ID}/analyze`;

  it('POST analyze creates a manual analysis and admits it', async () => {
    mockRequestIncidentAnalysis.mockResolvedValue({ status: 'admitted', runId: 'run-1' });

    const res = await request(buildApp()).post(analyzeUrl).send({ project: PROJECT });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId: 'run-1' });
    expect(mockRequestIncidentAnalysis).toHaveBeenCalledWith({
      project: PROJECT,
      incidentId: INCIDENT_ID,
      requestedBy: 'user-1',
    });
  });

  it('409 when one is already running', async () => {
    mockRequestIncidentAnalysis.mockResolvedValue({ status: 'already_running' });

    const res = await request(buildApp()).post(analyzeUrl).send({ project: PROJECT });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'An analysis for this incident is already running' });
  });

  it('404 for an unknown incident', async () => {
    mockRequestIncidentAnalysis.mockResolvedValue({ status: 'not_found' });

    const res = await request(buildApp()).post(analyzeUrl).send({ project: PROJECT });

    expect(res.status).toBe(404);
  });

  it('404 for an id that is not a uuid, without starting a run', async () => {
    const res = await request(buildApp())
      .post('/api/incident-triage/incidents/not-a-uuid/analyze')
      .send({ project: PROJECT });

    expect(res.status).toBe(404);
    expect(mockRequestIncidentAnalysis).not.toHaveBeenCalled();
  });

  it('403 without the run permission', async () => {
    mockGrantedPermissions.delete('incident-triage:run');

    const res = await request(buildApp()).post(analyzeUrl).send({ project: PROJECT });

    expect(res.status).toBe(403);
    expect(mockRequestIncidentAnalysis).not.toHaveBeenCalled();
  });

  it('passes an admission error to the error handler', async () => {
    mockRequestIncidentAnalysis.mockRejectedValue(new Error('service bus down'));

    const res = await request(buildApp()).post(analyzeUrl).send({ project: PROJECT });

    expect(res.status).toBe(500);
  });
});

describe('settings', () => {
  it('returns defaults when no row exists', async () => {
    mockGetSettings.mockResolvedValue(null);

    const res = await request(buildApp()).get(`/api/incident-triage/settings?${q}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      project: PROJECT,
      enabled: false,
      assignmentGroupIds: [],
      backfillDays: 7,
      teamsWebhookMasked: null,
    });
  });

  it('returns the stored settings', async () => {
    mockGetSettings.mockResolvedValue(settingsFixture({ backfillDays: 14 }));

    const res = await request(buildApp()).get(`/api/incident-triage/settings?${q}`);

    expect(res.status).toBe(200);
    expect(res.body.backfillDays).toBe(14);
  });

  it('PUT stores valid settings with the acting user', async () => {
    mockUpsertSettings.mockResolvedValue(settingsFixture({ enabled: true, backfillDays: 14 }));

    const res = await request(buildApp())
      .put('/api/incident-triage/settings')
      .send({
        project: PROJECT,
        enabled: true,
        assignmentGroupIds: [GROUP_ID.toUpperCase(), GROUP_ID],
        backfillDays: 14,
      });

    expect(res.status).toBe(200);
    expect(mockUpsertSettings).toHaveBeenCalledWith(
      PROJECT,
      { enabled: true, assignmentGroupIds: [GROUP_ID], backfillDays: 14 },
      'user-1',
    );
    expect(res.body.backfillDays).toBe(14);
  });

  it.each([
    ['a bad sys_id', { assignmentGroupIds: ['not-a-sys-id'] }],
    ['a non-array group list', { assignmentGroupIds: GROUP_ID }],
    ['too many groups', { assignmentGroupIds: Array.from({ length: 21 }, (_v, i) => i.toString(16).padStart(32, '0')) }],
    ['backfillDays below range', { backfillDays: 0 }],
    ['backfillDays above range', { backfillDays: 31 }],
    ['a fractional backfillDays', { backfillDays: 2.5 }],
    ['a non-boolean enabled', { enabled: 'yes' }],
    ['no settings fields', {}],
  ])('PUT settings rejects %s', async (_label, body) => {
    const res = await request(buildApp())
      .put('/api/incident-triage/settings')
      .send({ project: PROJECT, ...body });

    expect(res.status).toBe(400);
    expect(mockUpsertSettings).not.toHaveBeenCalled();
  });
});

describe('Teams webhook settings', () => {
  const WORKFLOWS_URL = 'https://prod-12.westus.logic.azure.com/workflows/abc/triggers/manual?sig=topsecret9';

  it.each([
    ['another host', 'https://example.com/hook?sig=topsecret9'],
    ['http', 'http://prod-12.westus.logic.azure.com/workflows/abc?sig=topsecret9'],
    ['text', 'topsecret9'],
    ['an empty string', ''],
    ['a number', 42],
    ['an object', { url: 'topsecret9' }],
  ])('PUT settings rejects a non-Workflows host and never echoes the URL (%s)', async (_label, teamsWebhookUrl) => {
    const res = await request(buildApp())
      .put('/api/incident-triage/settings')
      .send({ project: PROJECT, teamsWebhookUrl });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Webhook must be a Teams Workflows URL' });
    expect(res.text).not.toContain('topsecret9');
    expect(mockUpsertSettings).not.toHaveBeenCalled();
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('topsecret9');
  });

  it('PUT stores encrypted and returns masked', async () => {
    mockUpsertSettings.mockResolvedValue(
      settingsFixture({ teamsWebhookMasked: 'prod-12.westus.logic.azure.com…ret9' }),
    );

    const res = await request(buildApp())
      .put('/api/incident-triage/settings')
      .send({ project: PROJECT, teamsWebhookUrl: ` ${WORKFLOWS_URL} ` });

    expect(res.status).toBe(200);
    expect(mockUpsertSettings).toHaveBeenCalledWith(PROJECT, { teamsWebhookUrl: WORKFLOWS_URL }, 'user-1');
    expect(res.body.teamsWebhookMasked).toBe('prod-12.westus.logic.azure.com…ret9');
    expect(res.text).not.toContain('topsecret9');
    expect(res.text).not.toContain('workflows');
  });

  it('PUT with null clears the webhook', async () => {
    mockUpsertSettings.mockResolvedValue(settingsFixture());

    const res = await request(buildApp())
      .put('/api/incident-triage/settings')
      .send({ project: PROJECT, teamsWebhookUrl: null });

    expect(res.status).toBe(200);
    expect(mockUpsertSettings).toHaveBeenCalledWith(PROJECT, { teamsWebhookUrl: null }, 'user-1');
    expect(res.body.teamsWebhookMasked).toBeNull();
  });
});

describe('POST /settings/test-post', () => {
  const testPostUrl = '/api/incident-triage/settings/test-post';

  it('test-post 409 without webhook', async () => {
    mockGetSettings.mockResolvedValue(settingsFixture({ teamsWebhookMasked: null }));

    const res = await request(buildApp()).post(testPostUrl).send({ project: PROJECT });

    expect(res.status).toBe(409);
    expect(mockSendTestCard).not.toHaveBeenCalled();
  });

  it('409 when the project has no settings row', async () => {
    mockGetSettings.mockResolvedValue(null);

    const res = await request(buildApp()).post(testPostUrl).send({ project: PROJECT });

    expect(res.status).toBe(409);
    expect(mockSendTestCard).not.toHaveBeenCalled();
  });

  it('test-post 200 on 2xx', async () => {
    mockGetSettings.mockResolvedValue(settingsFixture({ teamsWebhookMasked: 'host…ret9' }));
    mockSendTestCard.mockResolvedValue({ ok: true, status: 202 });

    const res = await request(buildApp()).post(testPostUrl).send({ project: PROJECT });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockSendTestCard).toHaveBeenCalledWith(PROJECT);
  });

  it('test-post 502 otherwise', async () => {
    mockGetSettings.mockResolvedValue(settingsFixture({ teamsWebhookMasked: 'host…ret9' }));
    mockSendTestCard.mockResolvedValue({ ok: false, status: 500 });

    const res = await request(buildApp()).post(testPostUrl).send({ project: PROJECT });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Teams returned 500' });
  });

  it('502 without a status when Teams did not answer', async () => {
    mockGetSettings.mockResolvedValue(settingsFixture({ teamsWebhookMasked: 'host…ret9' }));
    mockSendTestCard.mockResolvedValue({ ok: false, status: null });

    const res = await request(buildApp()).post(testPostUrl).send({ project: PROJECT });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Teams did not respond' });
  });

  it('test-post 403 without manage', async () => {
    mockGrantedPermissions.delete('incident-triage:manage');

    const res = await request(buildApp()).post(testPostUrl).send({ project: PROJECT });

    expect(res.status).toBe(403);
    expect(mockSendTestCard).not.toHaveBeenCalled();
  });

  it('403 for a project the user cannot access', async () => {
    mockAssignedProjects = ['Other'];

    const res = await request(buildApp()).post(testPostUrl).send({ project: PROJECT });

    expect(res.status).toBe(403);
    expect(mockSendTestCard).not.toHaveBeenCalled();
  });
});
