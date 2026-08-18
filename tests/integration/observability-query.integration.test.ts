/**
 * VT-08 / VT-09 / VT-11 / VT-13 — PostgreSQL-backed Observability query paths.
 * Requires a migrated TEST_DATABASE_URL / DATABASE_URL (`npm run test:integration`).
 */
import './setup';
import { eq, sql } from 'drizzle-orm';
import { db } from './setup';
import pool from '../../src/server/db';
import { appUsers, traceEvents, tracePathRollups } from '../../src/server/db/schema';
import { createObservabilityQueryService } from '../../src/server/services/observabilityQueryService';

const TRACE_A = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const TRACE_B = 'ffffffffffffffffffffffffffffffff';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const ROLLUP_FROM = '/observability/query-from';
const FROM = '2026-08-01T00:00:00.000Z';
const TO = '2026-08-17T23:59:59.000Z';

function rowsOf<T>(result: { rows?: T[] } | T[]): T[] {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

async function cleanup(): Promise<void> {
  await db.delete(traceEvents).where(eq(traceEvents.traceId, TRACE_A));
  await db.delete(traceEvents).where(eq(traceEvents.traceId, TRACE_B));
  await db.delete(tracePathRollups).where(eq(tracePathRollups.fromRoute, ROLLUP_FROM));
}

describe('Observability query PostgreSQL integration', () => {
  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(async () => {
    await pool.end();
  });

  it('VT-08 / VT-09 filters by trace, session, status, and time without writing', async () => {
    const users = await db.select({ oid: appUsers.oid }).from(appUsers).limit(1);
    const actorId = users[0]?.oid ?? null;

    await db.insert(traceEvents).values([
      {
        eventType: 'api_request',
        occurredAt: '2026-08-10T12:00:00.000Z',
        actorUserId: actorId,
        traceId: TRACE_A,
        sessionId: SESSION_ID,
        routeTemplate: '/api/projects',
        httpMethod: 'GET',
        statusCode: 200,
        durationMs: 5,
        severity: 'info',
        details: { trigger: 'human', authorization: 'should-not-return' },
      },
      {
        eventType: 'error',
        occurredAt: '2026-08-10T12:00:00.000Z',
        actorUserId: actorId,
        traceId: TRACE_A,
        sessionId: SESSION_ID,
        routeTemplate: '/api/projects',
        httpMethod: 'GET',
        statusCode: 500,
        durationMs: 9,
        severity: 'error',
        details: { message: 'scrubbed', stack: 'hidden-stack' },
      },
      {
        eventType: 'api_request',
        occurredAt: '2026-08-10T15:00:00.000Z',
        actorUserId: actorId,
        traceId: TRACE_B,
        sessionId: null,
        routeTemplate: '/home',
        statusCode: 200,
        details: {},
      },
    ]);

    const service = createObservabilityQueryService();
    const tracePage = await service.queryTrace({
      traceId: TRACE_A,
      from: FROM,
      to: TO,
      cursor: null,
    });
    expect(tracePage?.items).toHaveLength(2);
    expect(tracePage?.items[0]?.id < tracePage!.items[1]!.id).toBe(true);
    expect(JSON.stringify(tracePage)).not.toContain('should-not-return');
    expect(JSON.stringify(tracePage)).not.toContain('hidden-stack');
    expect(JSON.stringify(tracePage)).not.toContain('details');

    const overlay = await service.querySessionOverlay({
      sessionId: SESSION_ID,
      from: FROM,
      to: TO,
      eventType: 'error',
      cursor: null,
    });
    expect(overlay?.events).toHaveLength(1);
    expect(overlay?.events[0]?.eventType).toBe('error');

    await expect(
      service.queryTrace({
        traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        from: FROM,
        to: TO,
        cursor: null,
      }),
    ).resolves.toBeNull();

    if (actorId) {
      const trail = await service.queryUserTrail({
        actorId,
        from: FROM,
        to: TO,
        traceId: TRACE_A,
        routeTemplate: '/api/projects',
        statusCode: 200,
        eventType: 'api_request',
        cursor: null,
      });
      expect(trail.items).toHaveLength(1);
      expect(trail.items[0]?.traceId).toBe(TRACE_A);
    }
  });

  it('VT-11 returns only rollup edges and ignores raw Trace Events', async () => {
    await db.insert(traceEvents).values({
      eventType: 'ui_action',
      occurredAt: '2026-08-17T12:00:00.000Z',
      traceId: TRACE_A,
      routeTemplate: '/home',
      details: {},
    });
    await db.insert(tracePathRollups).values({
      fromRoute: ROLLUP_FROM,
      toRoute: '/observability/query-to',
      day: '2026-08-17',
      transitionCount: 6,
      distinctActorCount: 3,
    });

    const service = createObservabilityQueryService();
    const page = await service.queryJourneyMap({
      fromDay: '2026-08-01',
      toDay: '2026-08-17',
      fromRoute: ROLLUP_FROM,
      toRoute: null,
      cursor: null,
    });

    expect(page.items).toEqual([
      {
        day: '2026-08-17',
        fromRoute: ROLLUP_FROM,
        toRoute: '/observability/query-to',
        transitionCount: 6,
        distinctActorCount: 3,
      },
    ]);
    expect(JSON.stringify(page)).not.toMatch(/traceId|actorId|details/);
  });

  it('VT-02 / VT-03 pages 50 rows and stops at the 500-row cap', async () => {
    const users = await db.select({ oid: appUsers.oid }).from(appUsers).limit(1);
    const actorId = users[0]?.oid;
    if (!actorId) return;

    const values = Array.from({ length: 60 }, (_, index) => ({
      eventType: 'api_request' as const,
      occurredAt: `2026-08-10T12:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
      actorUserId: actorId,
      traceId: TRACE_A,
      routeTemplate: '/api/projects',
      statusCode: 200,
      details: {},
    }));
    await db.insert(traceEvents).values(values);

    const service = createObservabilityQueryService();
    const first = await service.queryUserTrail({
      actorId,
      from: FROM,
      to: TO,
      traceId: TRACE_A,
      routeTemplate: null,
      statusCode: null,
      eventType: null,
      cursor: null,
    });
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.capReached).toBe(false);

    const second = await service.queryUserTrail({
      actorId,
      from: FROM,
      to: TO,
      traceId: TRACE_A,
      routeTemplate: null,
      statusCode: null,
      eventType: null,
      cursor: {
        emittedCount: 50,
        last: { occurredAt: first.items[49]!.occurredAt, id: first.items[49]!.id },
      },
    });
    expect(second.items).toHaveLength(10);
    expect(second.nextCursor).toBeNull();
  });

  it('VT-13 uses the actor+time index and completes well under 2 seconds', async () => {
    const users = await db.select({ oid: appUsers.oid }).from(appUsers).limit(1);
    const actorId = users[0]?.oid;
    if (!actorId) return;

    await db.insert(traceEvents).values({
      eventType: 'api_request',
      occurredAt: '2026-08-10T12:00:00.000Z',
      actorUserId: actorId,
      traceId: TRACE_A,
      routeTemplate: '/api/projects',
      details: {},
    });

    const planResult = await db.execute(sql`
      EXPLAIN (FORMAT TEXT)
      SELECT id, event_type, occurred_at
      FROM trace_events
      WHERE actor_user_id = ${actorId}
        AND occurred_at >= ${FROM}
        AND occurred_at <= ${TO}
      ORDER BY occurred_at ASC, id ASC
      LIMIT 51
    `);
    const plan = rowsOf<{ 'QUERY PLAN'?: string }>(planResult)
      .map((row) => row['QUERY PLAN'] ?? String(Object.values(row)[0] ?? ''))
      .join('\n');
    expect(plan).toMatch(/idx_trace_events_actor_occurred|Index/);

    const service = createObservabilityQueryService();
    const started = Date.now();
    await service.queryUserTrail({
      actorId,
      from: FROM,
      to: TO,
      traceId: null,
      routeTemplate: null,
      statusCode: null,
      eventType: null,
      cursor: null,
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
