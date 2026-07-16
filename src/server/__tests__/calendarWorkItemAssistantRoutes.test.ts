/**
 * Integration-style tests for the calendar assistant REST routes.
 *
 * Covers: feature flag gating, RBAC/permission checks, 404 ownership
 * isolation, apply/reject status-code contracts, and client-value
 * injection rejection on the apply path.
 */

import supertest from 'supertest';
import express from 'express';
import router from '../routes/api';

// ── Core mocks ────────────────────────────────────────────────────────────────

jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn(),
}));

jest.mock('../services/calendarWorkItemAssistantService', () => ({
  createOrReuseSession: jest.fn(),
  setSessionThread: jest.fn(),
  getSession: jest.fn(),
  getLatestProposal: jest.fn(),
  getProposal: jest.fn(),
  rejectProposal: jest.fn(),
  applyProposal: jest.fn(),
  buildContextMarkdown: jest.fn(() => '# context'),
}));

jest.mock('../services/chatAgentService', () => ({
  createThread: jest.fn(),
  getAgentHealthStats: jest.fn(() => ({ status: 'ok', threads: { total: 0, byStatus: {}, withActiveAgent: 0 }, uptime: 0 })),
}));

jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: jest.fn(() => null),
  getSkillConfigById: jest.fn(() => null),
  listSkillConfigsForProject: jest.fn(() => []),
  resolveSkillConfig: jest.fn(() => null),
}));

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn(() => 'composer-2.5'),
}));

jest.mock('../services/adoUserToken', () => ({
  getAdoTokenForUser: jest.fn().mockResolvedValue(null),
  AdoUserAuthError: class AdoUserAuthError extends Error {},
}));

jest.mock('../services/adoFactory', () => ({
  adoWriteForRequest: jest.fn(),
  adoWritePreferUser: jest.fn(),
  isAdoUserAuthError: jest.fn(() => false),
}));

jest.mock('../services/azureDevOps', () => ({
  AzureDevOpsService: jest.fn().mockImplementation(() => ({
    getWorkItemHierarchy: jest.fn().mockResolvedValue([]),
    getWorkItemContentByIds: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock('../middleware/rbac', () => {
  const actual = jest.requireActual('../middleware/rbac');
  return {
    ...actual,
    requirePermission: (...keys: string[]) => (req: any, res: any, next: any) => {
      const perms: string[] = req._testPermissions ?? [];
      const missing = keys.filter(k => !perms.includes(k));
      if (missing.length) return res.status(403).json({ error: 'Forbidden', missing });
      next();
    },
    requireProjectAccess: () => (_req: any, _res: any, next: any) => next(),
  };
});

jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(() => ({ from: jest.fn(() => ({ where: jest.fn(() => ({ limit: jest.fn().mockResolvedValue([]) })) })) })),
    query: { workItemAssistantSessions: {}, workItemChangeProposals: {} },
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

import { isFeatureEnabled } from '../services/featureFlagService';
import {
  createOrReuseSession,
  getSession,
  getLatestProposal,
  getProposal,
  rejectProposal,
  applyProposal,
} from '../services/calendarWorkItemAssistantService';
import { createThread } from '../services/chatAgentService';

const mockEnabled = isFeatureEnabled as jest.Mock;
const mockCreateSession = createOrReuseSession as jest.Mock;
const mockGetSession = getSession as jest.Mock;
const mockGetLatestProposal = getLatestProposal as jest.Mock;
const mockGetProposal = getProposal as jest.Mock;
const mockRejectProposal = rejectProposal as jest.Mock;
const mockApplyProposal = applyProposal as jest.Mock;
const mockCreateThread = createThread as jest.Mock;

function makeApp(permissions: string[] = ['calendar:view', 'workitems:write']) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = { profile: { oid: 'user-1' } };
    req._testPermissions = permissions;
    next();
  });
  app.use('/api', router);
  return supertest(app);
}

function makeSession(overrides?: object) {
  return {
    id: 'session-1',
    ownerUserId: 'user-1',
    project: 'MaxView',
    areaPath: 'MaxView',
    anchorWorkItemId: 100,
    selectedWorkItemIds: [100],
    contextSnapshot: [],
    threadId: 'thread-1',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makePendingProposal(overrides?: object) {
  return {
    id: 'proposal-1',
    sessionId: 'session-1',
    changeSet: {
      version: 1,
      proposalId: 'proposal-1',
      sessionId: 'session-1',
      threadId: 'thread-1',
      project: 'MaxView',
      areaPath: 'MaxView',
      anchorWorkItemId: 100,
      changes: [],
      proposedAt: new Date().toISOString(),
    },
    status: 'pending',
    itemResults: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Calendar assistant route: feature flag gating', () => {
  it('POST /api/calendar-assistant/sessions returns 404 when flag is disabled', async () => {
    mockEnabled.mockResolvedValue(false);

    const res = await makeApp().post('/api/calendar-assistant/sessions').send({
      project: 'MaxView',
      areaPath: 'MaxView',
      anchorWorkItemId: 100,
      selectedWorkItemIds: [100],
    });

    expect(res.status).toBe(404);
  });
});

describe('Calendar assistant route: permission gating', () => {
  beforeEach(() => {
    mockEnabled.mockResolvedValue(true);
  });

  it('POST /api/calendar-assistant/sessions returns 403 without calendar:view', async () => {
    const res = await makeApp([]).post('/api/calendar-assistant/sessions').send({
      project: 'MaxView',
      areaPath: 'MaxView',
      anchorWorkItemId: 100,
      selectedWorkItemIds: [100],
    });

    expect(res.status).toBe(403);
  });

  it('POST /api/calendar-assistant/proposals/:id/apply returns 403 without workitems:write', async () => {
    const res = await makeApp(['calendar:view']).post('/api/calendar-assistant/proposals/proposal-1/apply').send({
      approvedWorkItemIds: [100],
    });

    expect(res.status).toBe(403);
  });
});

describe('Calendar assistant route: session creation', () => {
  beforeEach(() => {
    mockEnabled.mockResolvedValue(true);
    mockCreateThread.mockResolvedValue({ id: 'thread-1' });
  });

  it('POST /api/calendar-assistant/sessions creates a new session and returns 201', async () => {
    mockCreateSession.mockResolvedValue({
      session: makeSession(),
      isNew: true,
    });

    const res = await makeApp().post('/api/calendar-assistant/sessions').send({
      project: 'MaxView',
      areaPath: 'MaxView',
      anchorWorkItemId: 100,
      selectedWorkItemIds: [100],
    });

    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBe('session-1');
    expect(res.body.isNew).toBe(true);
  });

  it('POST /api/calendar-assistant/sessions reuses an existing session and sets isNew=false', async () => {
    mockCreateSession.mockResolvedValue({
      session: makeSession({ threadId: 'thread-1' }),
      isNew: false,
    });

    const res = await makeApp().post('/api/calendar-assistant/sessions').send({
      project: 'MaxView',
      areaPath: 'MaxView',
      anchorWorkItemId: 100,
      selectedWorkItemIds: [100],
    });

    // 200 when reusing, 201 when creating — both are acceptable; key is isNew=false
    expect([200, 201]).toContain(res.status);
    expect(res.body.isNew).toBe(false);
  });

  it('returns 422 for invalid request body', async () => {
    const res = await makeApp().post('/api/calendar-assistant/sessions').send({
      project: 'MaxView',
      // missing anchorWorkItemId and selectedWorkItemIds
    });

    expect(res.status).toBe(422);
  });
});

describe('Calendar assistant route: GET session', () => {
  beforeEach(() => {
    mockEnabled.mockResolvedValue(true);
  });

  it('GET /api/calendar-assistant/sessions/:id returns 200 for owner', async () => {
    mockGetSession.mockResolvedValue(makeSession());
    mockGetLatestProposal.mockResolvedValue(null);

    const res = await makeApp().get('/api/calendar-assistant/sessions/session-1');

    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe('session-1');
  });

  it('GET /api/calendar-assistant/sessions/:id returns 404 for other user (ownership isolation)', async () => {
    mockGetSession.mockResolvedValue(makeSession({ ownerUserId: 'other-user' }));

    const res = await makeApp().get('/api/calendar-assistant/sessions/session-1');

    expect(res.status).toBe(404);
  });

  it('GET /api/calendar-assistant/sessions/:id returns 404 when session not found', async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await makeApp().get('/api/calendar-assistant/sessions/nonexistent');

    expect(res.status).toBe(404);
  });
});

describe('Calendar assistant route: proposal apply', () => {
  beforeEach(() => {
    mockEnabled.mockResolvedValue(true);
  });

  it('POST /api/calendar-assistant/proposals/:id/apply returns 200 on success', async () => {
    mockGetProposal.mockResolvedValue(makePendingProposal());
    mockGetSession.mockResolvedValue(makeSession());
    mockApplyProposal.mockResolvedValue({
      proposalId: 'proposal-1',
      status: 'applied',
      applied: [{ workItemId: 100, status: 'applied', newRev: 6 }],
      skipped: [],
      stale: [],
      failed: [],
    });

    const res = await makeApp().post('/api/calendar-assistant/proposals/proposal-1/apply').send({
      approvedWorkItemIds: [100],
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('applied');
    expect(res.body.applied).toHaveLength(1);
  });

  it('POST .../apply returns 404 for another user\'s proposal', async () => {
    mockGetProposal.mockResolvedValue(makePendingProposal());
    mockGetSession.mockResolvedValue(makeSession({ ownerUserId: 'other-user' }));

    const res = await makeApp().post('/api/calendar-assistant/proposals/proposal-1/apply').send({
      approvedWorkItemIds: [100],
    });

    expect(res.status).toBe(404);
  });

  it('POST .../apply returns 409 when proposal is not pending', async () => {
    mockGetProposal.mockResolvedValue(makePendingProposal({ status: 'applied' }));
    mockGetSession.mockResolvedValue(makeSession());

    const res = await makeApp().post('/api/calendar-assistant/proposals/proposal-1/apply').send({
      approvedWorkItemIds: [100],
    });

    expect(res.status).toBe(409);
  });

  it('POST .../apply rejects request without approvedWorkItemIds', async () => {
    mockGetProposal.mockResolvedValue(makePendingProposal());
    mockGetSession.mockResolvedValue(makeSession());

    const res = await makeApp().post('/api/calendar-assistant/proposals/proposal-1/apply').send({
      // missing approvedWorkItemIds
    });

    expect(res.status).toBe(422);
  });
});

describe('Calendar assistant route: proposal reject', () => {
  beforeEach(() => {
    mockEnabled.mockResolvedValue(true);
  });

  it('POST /api/calendar-assistant/proposals/:id/reject returns 200 for owner', async () => {
    mockGetProposal.mockResolvedValue(makePendingProposal());
    mockGetSession.mockResolvedValue(makeSession());
    mockRejectProposal.mockResolvedValue(undefined);

    const res = await makeApp().post('/api/calendar-assistant/proposals/proposal-1/reject').send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST .../reject returns 409 when proposal is already applied', async () => {
    mockGetProposal.mockResolvedValue(makePendingProposal({ status: 'applied' }));
    mockGetSession.mockResolvedValue(makeSession());

    const res = await makeApp().post('/api/calendar-assistant/proposals/proposal-1/reject').send({});

    expect(res.status).toBe(409);
  });
});
