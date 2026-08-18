/**
 * TBI-007 — Super Admin Observability query routes.
 * Criterion ids: DoD-1, DoD-2, VT-05, VT-06, VT-07, VT-09, VT-12.
 */
jest.mock('../middleware/rbac', () => ({
  requireSuperAdmin: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn().mockResolvedValue(true),
  listFlags: jest.fn(),
  getFlag: jest.fn(),
  createFlag: jest.fn(),
  updateFlag: jest.fn(),
  addRule: jest.fn(),
  removeRule: jest.fn(),
  deleteFlag: jest.fn(),
  getFlagAudit: jest.fn(),
}));
jest.mock('../services/observabilityQueryService', () => ({
  queryUserTrail: jest.fn(),
  queryTrace: jest.fn(),
  querySessionOverlay: jest.fn(),
  queryJourneyMap: jest.fn(),
  getCaptureHealth: jest.fn(),
  getSessionTimeline: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import { CAPTURE_BUFFER_CAPACITY, type CaptureHealthResponse } from '../../shared/types/observability';
import { isFeatureEnabled } from '../services/featureFlagService';
import * as observabilityQueryService from '../services/observabilityQueryService';
import { requireSuperAdmin } from '../middleware/rbac';
import platformAdminRouter from '../routes/platformAdmin';

const mockRequireSuperAdmin = requireSuperAdmin as jest.Mock;
const mockIsFeatureEnabled = isFeatureEnabled as jest.MockedFunction<typeof isFeatureEnabled>;
const mockQueryUserTrail = observabilityQueryService.queryUserTrail as jest.MockedFunction<
  typeof observabilityQueryService.queryUserTrail
>;
const mockQueryTrace = observabilityQueryService.queryTrace as jest.MockedFunction<
  typeof observabilityQueryService.queryTrace
>;
const mockQuerySession = observabilityQueryService.querySessionOverlay as jest.MockedFunction<
  typeof observabilityQueryService.querySessionOverlay
>;
const mockQueryJourney = observabilityQueryService.queryJourneyMap as jest.MockedFunction<
  typeof observabilityQueryService.queryJourneyMap
>;
const mockGetCaptureHealth = observabilityQueryService.getCaptureHealth as jest.MockedFunction<
  typeof observabilityQueryService.getCaptureHealth
>;
const mockGetSessionTimeline = observabilityQueryService.getSessionTimeline as jest.MockedFunction<
  typeof observabilityQueryService.getSessionTimeline
>;

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const FROM = '2026-08-01T00:00:00.000Z';
const TO = '2026-08-10T00:00:00.000Z';

const emptyPage = { items: [], nextCursor: null, capReached: false };

const healthy: CaptureHealthResponse = {
  capturedAt: '2026-08-17T16:00:00.000Z',
  instanceId: 'host-a:42',
  captureEnabled: true,
  pipeline: {
    scope: 'instance',
    droppedEvents: 1,
    droppedEventsPerSecond: 0.02,
    bufferDepth: 4,
    bufferCapacity: CAPTURE_BUFFER_CAPACITY,
    flushErrorCount: 0,
    latestFlushError: null,
    ingestedEventsPerSecond: 0.5,
  },
  store: {
    scope: 'database',
    approximateStoreBytes: 2048,
    oldestRetainedEventAt: '2026-07-20T00:00:00.000Z',
  },
};

const emptyTimeline = {
  session: { sessionId: SESSION_ID, runIds: [] },
  verdict: {
    health: 'healthy' as const,
    label: 'Healthy',
    detail: 'The latest run is progressing within established limits.',
    hangPointEventId: null,
    assessedAt: '2026-08-17T18:00:00.000Z',
  },
  sourceStatus: {
    agent: { state: 'empty' as const },
    trace: { state: 'empty' as const },
  },
  entries: [],
  page: { nextCursor: null, returned: 0, loaded: 0, cap: 500 as const, capReached: false },
  partial: false,
};

const ENDPOINTS = [
  `/api/platform-admin/observability/trail?project=Apex&actorId=${ACTOR_ID}&from=${FROM}&to=${TO}`,
  `/api/platform-admin/observability/traces/${TRACE_ID}?project=Apex`,
  `/api/platform-admin/observability/session-overlays/${SESSION_ID}?project=Apex&from=${FROM}&to=${TO}`,
  '/api/platform-admin/observability/journeys?project=Apex&fromDay=2026-08-01&toDay=2026-08-17',
  '/api/platform-admin/observability/health?project=Apex',
  `/api/platform-admin/observability/sessions/${SESSION_ID}/timeline?project=Apex`,
];

function buildApp(options?: { authenticated?: boolean }) {
  const app = express();
  app.use((req, res, next) => {
    if (options?.authenticated === false) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    (req as express.Request & { user?: { profile: { oid: string } } }).user = {
      profile: { oid: 'super-admin' },
    };
    next();
  });
  app.use('/api/platform-admin', platformAdminRouter);
  return app;
}

describe('observability query routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireSuperAdmin.mockImplementation((_req, _res, next) => next());
    mockIsFeatureEnabled.mockResolvedValue(true);
    mockQueryUserTrail.mockResolvedValue(emptyPage);
    mockQueryTrace.mockResolvedValue(emptyPage);
    mockQuerySession.mockResolvedValue({ sessionId: SESSION_ID, events: [], nextCursor: null, capReached: false });
    mockQueryJourney.mockResolvedValue(emptyPage);
    mockGetCaptureHealth.mockResolvedValue(healthy);
    mockGetSessionTimeline.mockResolvedValue(emptyTimeline);
  });

  it('DoD-1 / VT-12 returns safe trail, journey, and health payloads for an enabled Super Admin', async () => {
    const app = buildApp();

    const trail = await request(app).get(ENDPOINTS[0]);
    const health = await request(app).get(ENDPOINTS[4]);
    const journeys = await request(app).get(ENDPOINTS[3]);

    expect(trail.status).toBe(200);
    expect(trail.body).toEqual(emptyPage);
    expect(health.status).toBe(200);
    expect(health.body).toEqual(healthy);
    expect(journeys.status).toBe(200);
    expect(JSON.stringify(health.body)).not.toMatch(/details|actorUserId|traceId/);
    expect(mockQueryUserTrail).toHaveBeenCalledTimes(1);
    expect(mockGetCaptureHealth).toHaveBeenCalledTimes(1);
  });

  it('VT-09 returns 200 empty envelopes for collections and 404 for unknown exact resources', async () => {
    mockQueryTrace.mockResolvedValue(null);
    mockQuerySession.mockResolvedValue(null);

    const app = buildApp();
    const trail = await request(app).get(ENDPOINTS[0]);
    const trace = await request(app).get(ENDPOINTS[1]);
    const session = await request(app).get(ENDPOINTS[2]);

    expect(trail.status).toBe(200);
    expect(trail.body).toEqual(emptyPage);
    expect(trace.status).toBe(404);
    expect(trace.body).toEqual({ error: 'Not found', code: 'OBSERVABILITY_NOT_FOUND' });
    expect(session.status).toBe(404);
    expect(session.body).toEqual({ error: 'Not found', code: 'OBSERVABILITY_NOT_FOUND' });
    expect(JSON.stringify(trace.body)).not.toMatch(/occurredAt|details/);
  });

  it('VT-05 returns 403 for a non-Super-Admin and never invokes query or health services', async () => {
    mockRequireSuperAdmin.mockImplementation((_req, res) => {
      res.status(403).json({ error: 'Forbidden' });
    });
    const app = buildApp();

    for (const endpoint of ENDPOINTS) {
      const res = await request(app).get(endpoint);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden' });
      expect(JSON.stringify(res.body)).not.toMatch(/items|droppedEvents|traceId/);
    }

    expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
    expect(mockQueryUserTrail).not.toHaveBeenCalled();
    expect(mockQueryTrace).not.toHaveBeenCalled();
    expect(mockQuerySession).not.toHaveBeenCalled();
    expect(mockQueryJourney).not.toHaveBeenCalled();
    expect(mockGetCaptureHealth).not.toHaveBeenCalled();
    expect(mockGetSessionTimeline).not.toHaveBeenCalled();
  });

  it('VT-06 returns 404 when observability-viewer is disabled and does not call query services', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);
    const app = buildApp();

    for (const endpoint of ENDPOINTS) {
      const res = await request(app).get(endpoint);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
    }

    expect(mockQueryUserTrail).not.toHaveBeenCalled();
    expect(mockQueryTrace).not.toHaveBeenCalled();
    expect(mockQuerySession).not.toHaveBeenCalled();
    expect(mockQueryJourney).not.toHaveBeenCalled();
    expect(mockGetCaptureHealth).not.toHaveBeenCalled();
    expect(mockGetSessionTimeline).not.toHaveBeenCalled();
  });

  it('DoD-0 / VT-04 maps malformed trail input to 400 without calling the query service', async () => {
    const res = await request(buildApp()).get(
      '/api/platform-admin/observability/trail?project=Apex&actorId=not-a-uuid&from=yesterday&to=tomorrow',
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OBSERVABILITY_INVALID_QUERY');
    expect(JSON.stringify(res.body)).not.toMatch(/items|details|traceId/);
    expect(mockQueryUserTrail).not.toHaveBeenCalled();
  });

  it('VT-07 returns a generic 500 without SQL, stack, identifiers, or Trace Event content', async () => {
    mockQueryUserTrail.mockRejectedValue(new Error('SELECT * FROM trace_events WHERE actor_user_id = secret-id'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await request(buildApp()).get(ENDPOINTS[0]);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|secret-id|stack|trace_events|cursor/);
    spy.mockRestore();
  });

  it('PBI-006 AC-0 / VT-12 returns a session timeline for an enabled Super Admin', async () => {
    const res = await request(buildApp()).get(ENDPOINTS[5]);
    expect(res.status).toBe(200);
    expect(res.body.session.sessionId).toBe(SESSION_ID);
    expect(res.body.partial).toBe(false);
    expect(mockGetSessionTimeline).toHaveBeenCalledTimes(1);
  });

  it('PBI-006 AC-3 / VT-10 rejects a malformed session ID or cursor without calling the service', async () => {
    const badId = await request(buildApp()).get(
      '/api/platform-admin/observability/sessions/not-a-uuid/timeline?project=Apex',
    );
    const badCursor = await request(buildApp()).get(
      `/api/platform-admin/observability/sessions/${SESSION_ID}/timeline?project=Apex&cursor=%%%`,
    );
    expect(badId.status).toBe(400);
    expect(badCursor.status).toBe(400);
    expect(badId.body.code).toBe('OBSERVABILITY_INVALID_QUERY');
    expect(JSON.stringify(badId.body)).not.toMatch(/runIds|entries|hangPoint/);
    expect(mockGetSessionTimeline).not.toHaveBeenCalled();
  });

  it('PBI-006 AC-3 / VT-12 returns a generic 404 for an unknown session', async () => {
    const { ObservabilityQueryError } = await import('../services/observabilityQueryValidation');
    mockGetSessionTimeline.mockRejectedValue(
      new ObservabilityQueryError('OBSERVABILITY_NOT_FOUND', 'Not found', 404),
    );
    const res = await request(buildApp()).get(ENDPOINTS[5]);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found', code: 'OBSERVABILITY_NOT_FOUND' });
    expect(JSON.stringify(res.body)).not.toMatch(/runIds|entries|agent_run/);
  });

  it('PBI-006 AC-1 / VT-06 returns a safe 500 when no timeline source can produce a result', async () => {
    const { ObservabilityTimelineUnavailableError } = await import(
      '../services/observabilityQueryValidation'
    );
    mockGetSessionTimeline.mockRejectedValue(new ObservabilityTimelineUnavailableError());
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(buildApp()).get(ENDPOINTS[5]);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toMatch(/agent_run|trace_events|SELECT/);
    spy.mockRestore();
  });
});
