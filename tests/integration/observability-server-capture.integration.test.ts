/**
 * VT-06 / VT-12 — server capture against PostgreSQL.
 * Requires a migrated TEST_DATABASE_URL / DATABASE_URL (`npm run test:integration`).
 */
import './setup';
import express from 'express';
import request from 'supertest';
import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from './setup';
import pool from '../../src/server/db';
import { TRACE_REDACTED_MARKER } from '../../src/shared/types/observability';
import { insertSafeTraceEvents } from '../../src/server/services/traceEventStorageService';
import { createObservabilityCaptureService } from '../../src/server/services/observabilityCaptureService';
import {
  captureServerError,
  createObservabilityCaptureMiddleware,
} from '../../src/server/middleware/observabilityCapture';
import { traceEvents } from '../../src/server/db/schema';

const TRACE_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

async function cleanup(): Promise<void> {
  await db.delete(traceEvents).where(eq(traceEvents.traceId, TRACE_ID));
}

describe('Failure-isolated server capture integration', () => {
  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(async () => {
    await pool.end();
  });

  it('AC-0 / DoD-0 persists a redacted API event without changing the response', async () => {
    const service = createObservabilityCaptureService({
      isCaptureEnabled: () => true,
      insertBatch: insertSafeTraceEvents,
      retryDelayMs: 0,
    });
    const app = express();
    app.use((req, _res, next) => {
      (req as Request & { user?: { profile: { oid: string } } }).user = {
        profile: { oid: 'user-oid-1' },
      };
      next();
    });
    app.use(
      createObservabilityCaptureMiddleware({
        isEnabled: () => true,
        capture: (candidate) => service.capture({ ...candidate, actorUserId: '' }),
      }),
    );
    app.get('/projects', (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const response = await request(app).get('/projects').set('traceparent', TRACEPARENT);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });

    await service.flush();
    const rows = await db.select().from(traceEvents).where(eq(traceEvents.traceId, TRACE_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe('api_request');
    expect(rows[0]?.routeTemplate).toBe('/projects');
    expect(rows[0]?.httpMethod).toBe('GET');
    expect(rows[0]?.statusCode).toBe(200);
  });

  it('AC-1 / VT-06 does not fail the user request when inserts fail', async () => {
    const service = createObservabilityCaptureService({
      isCaptureEnabled: () => true,
      insertBatch: async () => {
        throw new Error('insert_failed');
      },
      retryDelayMs: 0,
    });
    const app = express();
    app.use((req, _res, next) => {
      (req as Request & { user?: { profile: { oid: string } } }).user = {
        profile: { oid: 'user-oid-1' },
      };
      next();
    });
    app.use(
      createObservabilityCaptureMiddleware({
        isEnabled: () => true,
        capture: (candidate) => service.capture(candidate),
      }),
    );
    app.get('/projects', (_req, res) => {
      res.status(201).json({ created: true });
    });
    app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
      captureServerError(req, err, res, {
        isEnabled: () => true,
        capture: (candidate) => service.capture(candidate),
      });
      res.status(500).json({ error: err.message });
    });

    const response = await request(app).get('/projects').set('traceparent', TRACEPARENT);
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ created: true });
    await service.flush();
    expect(service.getHealth().flushErrorCount).toBe(1);
  });

  it('DoD-2 writes independently from two capture-service instances', async () => {
    const first = createObservabilityCaptureService({
      isCaptureEnabled: () => true,
      insertBatch: insertSafeTraceEvents,
    });
    const second = createObservabilityCaptureService({
      isCaptureEnabled: () => true,
      insertBatch: insertSafeTraceEvents,
    });

    first.capture({
      eventType: 'api_request',
      occurredAt: '2026-08-17T18:00:00.000Z',
      actorUserId: '',
      traceId: TRACE_ID,
      routeTemplate: '/api/one',
      httpMethod: 'GET',
      statusCode: 200,
      details: { instance: 'a', token: 'secret-a' },
    });
    second.capture({
      eventType: 'api_request',
      occurredAt: '2026-08-17T18:00:01.000Z',
      actorUserId: '',
      traceId: TRACE_ID,
      routeTemplate: '/api/two',
      httpMethod: 'GET',
      statusCode: 200,
      details: { instance: 'b', token: 'secret-b' },
    });

    await first.flush();
    await second.flush();

    const rows = await db.select().from(traceEvents).where(eq(traceEvents.traceId, TRACE_ID));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.routeTemplate).sort()).toEqual(['/api/one', '/api/two']);
    expect(JSON.stringify(rows)).not.toMatch(/secret-a|secret-b/);
    expect(rows.every((row) => row.details.token === TRACE_REDACTED_MARKER)).toBe(true);
    expect(first.getHealth().bufferDepth).toBe(0);
    expect(second.getHealth().bufferDepth).toBe(0);
  });
});
