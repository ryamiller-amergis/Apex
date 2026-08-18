/**
 * PBI-002 / TBI-004 integration: ingest route + capture pipeline without awaiting DB.
 * Criterion ids: AC-0, AC-1, AC-3, VT-02, VT-08, VT-12, BR-003.
 */
jest.mock('../db/drizzle', () => ({ db: { select: jest.fn() } }));
jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn() }));
jest.mock('../utils/superAdmin', () => ({ isSuperAdminRequest: jest.fn(() => false) }));

import express from 'express';
import request from 'supertest';
import observabilityRoutes from '../routes/observability';
import { createObservabilityCaptureService } from '../services/observabilityCaptureService';
import {
  createObservabilityIngestService,
  resetObservabilityIngestServiceForTests,
  setObservabilityIngestServiceForTests,
} from '../services/observabilityIngestService';
import { TRACE_REDACTED_MARKER, type SafeTraceEventInput } from '../../shared/types/observability';
import { isCaptureExcludedPath } from '../middleware/observabilityCapturePolicy';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';
const OCCURRED_AT = '2026-08-17T17:00:00.000Z';

function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { profile: { oid: string } } }).user = {
      profile: { oid: 'user-a' },
    };
    next();
  });
  app.use('/api/observability', observabilityRoutes);
  return app;
}

describe('browser ingest + capture integration', () => {
  afterEach(() => {
    resetObservabilityIngestServiceForTests();
  });

  it('AC-0 / VT-02 / BR-003 queues a redacted event under the session actor', async () => {
    const inserted: SafeTraceEventInput[] = [];
    const capture = createObservabilityCaptureService({
      isCaptureEnabled: () => true,
      insertBatch: async (events) => {
        inserted.push(...events);
        return { insertedCount: events.length };
      },
    });
    setObservabilityIngestServiceForTests(
      createObservabilityIngestService({
        capture: (candidate) => capture.capture(candidate),
        isCaptureEnabled: async () => true,
        hasProjectAccess: async () => true,
        now: () => Date.parse(OCCURRED_AT),
      }),
    );

    const response = await request(buildApp())
      .post('/api/observability/events')
      .send({
        project: 'Apex',
        events: [
          {
            type: 'client_error',
            occurredAt: OCCURRED_AT,
            traceId: TRACE_ID,
            spanId: SPAN_ID,
            routeTemplate: '/home',
            severity: 'error',
            actor: 'user-b-id',
            details: { message: 'Bearer eyJabc.def.ghi', email: 'user@test.com' },
          },
        ],
      });

    expect(response.status).toBe(202);
    await capture.flush();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.actorUserId).toBe('user-a');
    expect(inserted[0]?.traceId).toBe(TRACE_ID);
    expect(JSON.stringify(inserted[0])).toContain(TRACE_REDACTED_MARKER);
    expect(JSON.stringify(inserted[0])).not.toMatch(/user-b-id|user@test.com/);
  });

  it('VT-12 / AC-1 returns 202 when later persistence fails', async () => {
    const capture = createObservabilityCaptureService({
      isCaptureEnabled: () => true,
      insertBatch: async () => {
        throw new Error('db down');
      },
      retryDelayMs: 0,
    });
    setObservabilityIngestServiceForTests(
      createObservabilityIngestService({
        capture: (candidate) => capture.capture(candidate),
        isCaptureEnabled: async () => true,
        hasProjectAccess: async () => true,
        now: () => Date.parse(OCCURRED_AT),
      }),
    );

    const response = await request(buildApp())
      .post('/api/observability/events')
      .send({
        project: 'Apex',
        events: [
          {
            type: 'route_view',
            occurredAt: OCCURRED_AT,
            traceId: TRACE_ID,
            spanId: SPAN_ID,
            routeTemplate: '/home',
          },
        ],
      });
    expect(response.status).toBe(202);
    await capture.flush();
    expect(capture.getHealth().flushErrorCount).toBe(1);
  });

  it('DoD-2 does not capture the ingest path', () => {
    expect(isCaptureExcludedPath('/api/observability/events')).toBe(true);
  });
});
