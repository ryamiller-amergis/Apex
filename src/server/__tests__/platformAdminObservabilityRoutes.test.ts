/**
 * TBI-006/TBI-007 — GET /api/platform-admin/observability/health
 * Health is now served through the FEAT-005 query router (viewer flag + project).
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
import platformAdminRouter from '../routes/platformAdmin';
import { requireSuperAdmin } from '../middleware/rbac';
import { getCaptureHealth } from '../services/observabilityQueryService';
import { isFeatureEnabled } from '../services/featureFlagService';

const mockRequireSuperAdmin = requireSuperAdmin as jest.Mock;
const mockGetCaptureHealth = getCaptureHealth as jest.MockedFunction<typeof getCaptureHealth>;
const mockIsFeatureEnabled = isFeatureEnabled as jest.MockedFunction<typeof isFeatureEnabled>;

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

describe('GET /api/platform-admin/observability/health', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireSuperAdmin.mockImplementation((_req, _res, next) => next());
    mockIsFeatureEnabled.mockResolvedValue(true);
  });

  it('VT-07 / DoD-2 returns 200 with the exact CaptureHealthResponse projection', async () => {
    mockGetCaptureHealth.mockResolvedValue(healthy);

    const res = await request(buildApp()).get('/api/platform-admin/observability/health?project=Apex');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(healthy);
    expect(JSON.stringify(res.body)).not.toMatch(/details|actorUserId|traceId/);
  });

  it('VT-08 returns 403 for a non-Super-Admin and never invokes the query service', async () => {
    mockRequireSuperAdmin.mockImplementation((_req, res) => {
      res.status(403).json({ error: 'Forbidden' });
    });

    const res = await request(buildApp()).get('/api/platform-admin/observability/health?project=Apex');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
    expect(mockGetCaptureHealth).not.toHaveBeenCalled();
  });

  it('VT-09 returns 401 for an unauthenticated caller and discloses no health data', async () => {
    const res = await request(buildApp({ authenticated: false })).get(
      '/api/platform-admin/observability/health?project=Apex',
    );

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Not authenticated' });
    expect(mockGetCaptureHealth).not.toHaveBeenCalled();
  });

  it('VT-10 returns generic 500 when store statistics fail', async () => {
    mockGetCaptureHealth.mockRejectedValue(new Error('relation size denied'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await request(buildApp()).get('/api/platform-admin/observability/health?project=Apex');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toMatch(/relation size|droppedEvents|trace_events/);
    spy.mockRestore();
  });
});
