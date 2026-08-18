/**
 * TBI-006 / VT-01 / VT-02 / VT-05 — retention and capture-health against PostgreSQL.
 * Requires a migrated TEST_DATABASE_URL / DATABASE_URL (`npm run test:integration`).
 */
import './setup';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from './setup';
import pool from '../../src/server/db';
import { traceEvents, tracePathRollups } from '../../src/server/db/schema';
import {
  OBSERVABILITY_RETENTION_LOCK_KEY,
  createObservabilityOperationsService,
  resetObservabilityOperationsForTests,
} from '../../src/server/services/observabilityOperationsService';
import { CAPTURE_BUFFER_CAPACITY } from '../../src/shared/types/observability';

const TRACE_EXPIRED = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TRACE_BOUNDARY = 'cccccccccccccccccccccccccccccccc';
const TRACE_RECENT = 'dddddddddddddddddddddddddddddddd';
const ROLLUP_FROM = '/observability/retention-from';

async function cleanup(): Promise<void> {
  await db.delete(traceEvents).where(eq(traceEvents.traceId, TRACE_EXPIRED));
  await db.delete(traceEvents).where(eq(traceEvents.traceId, TRACE_BOUNDARY));
  await db.delete(traceEvents).where(eq(traceEvents.traceId, TRACE_RECENT));
  await db.delete(tracePathRollups).where(eq(tracePathRollups.fromRoute, ROLLUP_FROM));
}

describe('Observability retention and capture health integration', () => {
  beforeEach(async () => {
    resetObservabilityOperationsForTests();
    await cleanup();
  });

  afterEach(async () => {
    resetObservabilityOperationsForTests();
    await cleanup();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('VT-01 / DoD-0 deletes only strictly expired raw events and preserves boundary, recent, and rollup rows', async () => {
    await db.execute(sql`
      INSERT INTO trace_events (event_type, occurred_at, trace_id, details)
      VALUES
        ('api_request', NOW() - INTERVAL '31 days', ${TRACE_EXPIRED}, '{}'::jsonb),
        ('api_request', NOW() - INTERVAL '30 days' + INTERVAL '1 minute', ${TRACE_BOUNDARY}, '{}'::jsonb),
        ('api_request', NOW() - INTERVAL '1 day', ${TRACE_RECENT}, '{}'::jsonb)
    `);
    await db.insert(tracePathRollups).values({
      fromRoute: ROLLUP_FROM,
      toRoute: '/observability/retention-to',
      day: '2026-08-17',
      transitionCount: 5,
      distinctActorCount: 3,
    });

    const ops = createObservabilityOperationsService();
    const result = await ops.runRetentionCycle();

    expect(result.skipped).toBe(false);
    expect(result.deletedCount).toBeGreaterThanOrEqual(1);

    const remaining = await db
      .select({ traceId: traceEvents.traceId })
      .from(traceEvents)
      .where(inArray(traceEvents.traceId, [TRACE_EXPIRED, TRACE_BOUNDARY, TRACE_RECENT]));
    const ids = remaining.map((row) => row.traceId);
    expect(ids).not.toContain(TRACE_EXPIRED);
    expect(ids).toEqual(expect.arrayContaining([TRACE_BOUNDARY, TRACE_RECENT]));

    const rollups = await db
      .select()
      .from(tracePathRollups)
      .where(eq(tracePathRollups.fromRoute, ROLLUP_FROM));
    expect(rollups).toHaveLength(1);
  });

  it('VT-02 / BR-012 skips the cycle when another connection holds the advisory lock', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        OBSERVABILITY_RETENTION_LOCK_KEY,
      ]);

      const ops = createObservabilityOperationsService();
      const result = await ops.runRetentionCycle();
      expect(result).toEqual({ skipped: true, deletedCount: 0 });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('VT-05 reads payload-free store statistics from PostgreSQL', async () => {
    const ops = createObservabilityOperationsService({
      instanceId: 'integration:1',
      isCaptureEnabled: () => true,
      getCaptureHealth: () => ({
        bufferDepth: 0,
        bufferCapacity: CAPTURE_BUFFER_CAPACITY,
        droppedEvents: 0,
        droppedEventsPerSecond: 0,
        flushErrorCount: 0,
        lastFlushError: null,
        acceptedEvents: 0,
        persistedEvents: 0,
        ingestedEventsPerSecond: 0,
      }),
    });

    const snapshot = await ops.getCaptureHealth();
    expect(snapshot.pipeline.scope).toBe('instance');
    expect(snapshot.store.scope).toBe('database');
    expect(snapshot.store.approximateStoreBytes).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(snapshot)).not.toMatch(/details|actorUserId|traceId/);

    await db.execute(sql`
      INSERT INTO trace_events (event_type, occurred_at, trace_id, details)
      VALUES ('api_request', NOW() - INTERVAL '2 days', ${TRACE_RECENT}, '{}'::jsonb)
    `);
    const populated = await ops.getCaptureHealth();
    expect(populated.store.oldestRetainedEventAt).not.toBeNull();
    expect(populated.pipeline.bufferCapacity).toBe(CAPTURE_BUFFER_CAPACITY);
  });
});
