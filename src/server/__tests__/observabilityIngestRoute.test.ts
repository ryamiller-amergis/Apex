/**
 * TBI-004 / PBI-002 — POST /api/observability/events HTTP contract.
 * Criterion ids: AC-0, AC-2, AC-3, DoD-1, DoD-2, VT-02, VT-06, VT-07, VT-09.
 */
jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn() }));
jest.mock('../utils/superAdmin', () => ({ isSuperAdminRequest: jest.fn(() => false) }));
jest.mock('../services/observabilityIngestService', () => ({
  getObservabilityIngestService: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import observabilityRoutes from '../routes/observability';
import { getObservabilityIngestService } from '../services/observabilityIngestService';
import { isCaptureExcludedPath } from '../middleware/observabilityCapturePolicy';

const mockGetService = getObservabilityIngestService as jest.MockedFunction<typeof getObservabilityIngestService>;

function buildApp(userOid: string | null = 'user-a') {
  const app = express();
  app.use((req, _res, next) => {
    if (userOid) {
      (req as express.Request & { user?: { profile: { oid: string } } }).user = {
        profile: { oid: userOid },
      };
    }
    next();
  });
  app.use('/api/observability', observabilityRoutes);
  return app;
}

describe('POST /api/observability/events', () => {
  const ingest = jest.fn();

  beforeEach(() => {
    ingest.mockReset();
    mockGetService.mockReturnValue({ ingest, resetRateLimitForTests: jest.fn() } as never);
  });

  it('AC-0 / VT-02 returns 202 for an accepted authenticated batch', async () => {
    ingest.mockResolvedValue({ ok: true, accepted: 1 });
    const response = await request(buildApp())
      .post('/api/observability/events')
      .send({ project: 'Apex', events: [{ type: 'route_view' }] });
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ accepted: 1 });
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'user-a' }),
    );
  });

  it('DoD-1 returns 401 when the session is missing', async () => {
    const response = await request(buildApp(null))
      .post('/api/observability/events')
      .send({ project: 'Apex', events: [] });
    expect(response.status).toBe(401);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('VT-09 returns 404 when ingest reports the flag disabled', async () => {
    ingest.mockResolvedValue({
      ok: false,
      status: 404,
      error: 'Not found',
      code: 'FLAG_DISABLED',
    });
    const response = await request(buildApp())
      .post('/api/observability/events')
      .send({ project: 'Apex', events: [{ type: 'route_view' }] });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Not found', code: 'FLAG_DISABLED' });
  });

  it('AC-2 / VT-07 maps oversized JSON to 400 without calling a partial accept', async () => {
    const pad = 'x'.repeat(6000);
    const response = await request(buildApp())
      .post('/api/observability/events')
      .send({ project: 'Apex', events: [{ type: 'route_view' }], pad });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(ingest).not.toHaveBeenCalled();
  });

  it('AC-2 / VT-06 returns 429 with Retry-After', async () => {
    ingest.mockResolvedValue({
      ok: false,
      status: 429,
      error: 'Too many requests',
      code: 'RATE_LIMITED',
      retryAfterSec: 42,
    });
    const response = await request(buildApp())
      .post('/api/observability/events')
      .send({ project: 'Apex', events: [{ type: 'route_view' }] });
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('42');
    expect(response.body.code).toBe('RATE_LIMITED');
  });

  it('DoD-2 excludes the canonical ingest path from server capture', () => {
    expect(isCaptureExcludedPath('/api/observability/events')).toBe(true);
  });
});
