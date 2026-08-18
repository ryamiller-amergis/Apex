/**
 * FEAT-003 ingest integration against PostgreSQL when TEST_DATABASE_URL is set.
 */
import './setup';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { db } from './setup';
import pool from '../../src/server/db';
import { traceEvents } from '../../src/server/db/schema';
import { createObservabilityCaptureService } from '../../src/server/services/observabilityCaptureService';
import {
  createObservabilityIngestService,
  setObservabilityIngestServiceForTests,
  resetObservabilityIngestServiceForTests,
} from '../../src/server/services/observabilityIngestService';
import observabilityRoutes from '../../src/server/routes/observability';
import { insertSafeTraceEvents } from '../../src/server/services/traceEventStorageService';

const TRACE_ID = 'cccccccccccccccccccccccccccccccc';

async function cleanup(): Promise<void> {
  await db.delete(traceEvents).where(eq(traceEvents.traceId, TRACE_ID));
}

describe('observability browser ingest integration', () => {
  beforeEach(cleanup);
  afterEach(async () => {
    await cleanup();
    resetObservabilityIngestServiceForTests();
  });
  afterAll(async () => {
    await pool.end();
  });

  it('AC-0 persists a browser route_view under the authenticated actor', async () => {
    const capture = createObservabilityCaptureService({
      isCaptureEnabled: () => true,
      insertBatch: insertSafeTraceEvents,
    });
    setObservabilityIngestServiceForTests(
      createObservabilityIngestService({
        capture: (candidate) => capture.capture(candidate),
        isCaptureEnabled: async () => true,
        hasProjectAccess: async () => true,
        now: () => Date.parse('2026-08-17T17:00:00.000Z'),
      }),
    );

    const app = express();
    app.use((req, _res, next) => {
      (req as express.Request & { user?: { profile: { oid: string } } }).user = {
        profile: { oid: 'user-oid-1' },
      };
      next();
    });
    app.use('/api/observability', observabilityRoutes);

    const response = await request(app)
      .post('/api/observability/events')
      .send({
        project: 'Apex',
        events: [
          {
            type: 'route_view',
            occurredAt: '2026-08-17T17:00:00.000Z',
            traceId: TRACE_ID,
            spanId: '00f067aa0ba902b7',
            routeTemplate: '/home',
          },
        ],
      });
    expect(response.status).toBe(202);
    await capture.flush();
    const rows = await db.select().from(traceEvents).where(eq(traceEvents.traceId, TRACE_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorUserId).toBe('user-oid-1');
    expect(rows[0]?.eventType).toBe('ui_action');
    expect(rows[0]?.routeTemplate).toBe('/home');
  });
});
