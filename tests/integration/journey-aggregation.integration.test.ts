/**
 * TBI-010 / VT-06–VT-10 / VT-13 / VT-14 — Journey rollup reconciliation against PostgreSQL.
 * Requires a migrated TEST_DATABASE_URL / DATABASE_URL (`npm run test:integration`).
 */
import './setup';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from './setup';
import pool from '../../src/server/db';
import { appUsers, traceEvents, tracePathRollups } from '../../src/server/db/schema';
import {
  JOURNEY_ROLLUP_LOCK_KEY,
  createJourneyAggregationService,
  resetJourneyAggregationServiceForTests,
} from '../../src/server/services/journeyAggregationService';

const TRACE_A = 'aaaaaaaa111111111111111111111111';
const TRACE_B = 'bbbbbbbb222222222222222222222222';
const TRACE_LATE = 'cccccccc333333333333333333333333';
const STALE_FROM = '/planning';
const STALE_TO = '/cloud-cost';
const DAY = '1999-01-15';
const PREV_DAY = '1999-01-14';

function rowsOf<T>(result: { rows?: T[] } | T[]): T[] {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

async function cleanup(): Promise<void> {
  await db.delete(traceEvents).where(inArray(traceEvents.traceId, [TRACE_A, TRACE_B, TRACE_LATE]));
  await db.delete(tracePathRollups).where(inArray(tracePathRollups.day, [DAY, PREV_DAY]));
}

async function actors(): Promise<string[]> {
  const users = await db.select({ oid: appUsers.oid }).from(appUsers).limit(2);
  return users.map((row) => row.oid);
}

describe('Journey aggregation PostgreSQL integration', () => {
  beforeEach(async () => {
    resetJourneyAggregationServiceForTests();
    await cleanup();
  });

  afterEach(async () => {
    resetJourneyAggregationServiceForTests();
    await cleanup();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('VT-06 / DoD-2 reconciles the same day twice without increasing counts', async () => {
    const [actorId] = await actors();
    if (!actorId) return;

    await db.insert(traceEvents).values([
      {
        eventType: 'ui_action',
        occurredAt: `${DAY}T12:00:00.000Z`,
        actorUserId: actorId,
        traceId: TRACE_A,
        routeTemplate: '/home',
        details: { browserEventType: 'route_view' },
      },
      {
        eventType: 'ui_action',
        occurredAt: `${DAY}T12:01:00.000Z`,
        actorUserId: actorId,
        traceId: TRACE_A,
        routeTemplate: '/calendar',
        details: { browserEventType: 'route_view' },
      },
    ]);

    const service = createJourneyAggregationService({
      isCaptureEnabled: async () => true,
    });
    const first = await service.reconcileJourneyDays(DAY, DAY);
    const second = await service.reconcileJourneyDays(DAY, DAY);

    expect(second).toEqual(first);
    const rows = await db
      .select()
      .from(tracePathRollups)
      .where(eq(tracePathRollups.fromRoute, '/home'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.toRoute).toBe('/calendar');
    expect(rows[0]?.day).toBe(DAY);
    expect(rows[0]?.transitionCount).toBe(1);
    expect(rows[0]?.distinctActorCount).toBe(1);
  });

  it('VT-07 / DoD-2 converges a late eligible event into the rebuilt day exactly once', async () => {
    const [actorId] = await actors();
    if (!actorId) return;

    await db.insert(traceEvents).values([
      {
        eventType: 'ui_action',
        occurredAt: `${DAY}T12:00:00.000Z`,
        actorUserId: actorId,
        traceId: TRACE_A,
        routeTemplate: '/home',
        details: { browserEventType: 'route_view' },
      },
      {
        eventType: 'ui_action',
        occurredAt: `${DAY}T12:01:00.000Z`,
        actorUserId: actorId,
        traceId: TRACE_A,
        routeTemplate: '/calendar',
        details: { browserEventType: 'route_view' },
      },
    ]);
    const service = createJourneyAggregationService({ isCaptureEnabled: async () => true });
    await service.reconcileJourneyDays(DAY, DAY);

    await db.insert(traceEvents).values({
      eventType: 'ui_action',
      occurredAt: `${DAY}T12:02:00.000Z`,
      actorUserId: actorId,
      traceId: TRACE_LATE,
      routeTemplate: '/backlog',
      details: { browserEventType: 'route_view' },
    });
    await service.reconcileJourneyDays(DAY, DAY);

    const rows = await db
      .select()
      .from(tracePathRollups)
      .where(eq(tracePathRollups.day, DAY));
    const homeCalendar = rows.find((row) => row.fromRoute === '/home' && row.toRoute === '/calendar');
    const calendarBacklog = rows.find((row) => row.fromRoute === '/calendar' && row.toRoute === '/backlog');
    expect(homeCalendar?.transitionCount).toBe(1);
    expect(calendarBacklog?.transitionCount).toBe(1);
    expect(rows.every((row) => row.transitionCount === 1)).toBe(true);
  });

  it('VT-08 / DoD-2 removes stale derived rows when the source range is empty', async () => {
    await db.insert(tracePathRollups).values({
      fromRoute: STALE_FROM,
      toRoute: STALE_TO,
      day: DAY,
      transitionCount: 9,
      distinctActorCount: 4,
    });

    const service = createJourneyAggregationService({ isCaptureEnabled: async () => true });
    const result = await service.reconcileJourneyDays(DAY, DAY);
    expect(result.edgesWritten).toBe(0);

    const remaining = await db
      .select()
      .from(tracePathRollups)
      .where(eq(tracePathRollups.fromRoute, STALE_FROM));
    expect(remaining).toHaveLength(0);
  });

  it('VT-09 / BR-012 skips writes when another connection holds the advisory lock', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JOURNEY_ROLLUP_LOCK_KEY]);

      const service = createJourneyAggregationService({ isCaptureEnabled: async () => true });
      const result = await service.runJourneyAggregationCycle();
      expect(result.status).toBe('lock_skipped');
      expect(result.edgesWritten).toBe(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('VT-10 / DoD-2 rolls back the day when insert fails after delete', async () => {
    await db.insert(tracePathRollups).values({
      fromRoute: STALE_FROM,
      toRoute: STALE_TO,
      day: DAY,
      transitionCount: 3,
      distinctActorCount: 2,
    });

    const service = createJourneyAggregationService({
      isCaptureEnabled: async () => true,
      afterTargetDayDelete: async () => {
        throw new Error('injected insert failure');
      },
    });

    await expect(service.reconcileJourneyDays(DAY, DAY)).rejects.toThrow('injected insert failure');

    const remaining = await db
      .select()
      .from(tracePathRollups)
      .where(eq(tracePathRollups.fromRoute, STALE_FROM));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.transitionCount).toBe(3);
  });

  it('VT-14 / DoD-1 / BR-009 never persists actor ids or concrete routes in rollups', async () => {
    const ids = await actors();
    const actorId = ids[0];
    if (!actorId) return;

    await db.insert(traceEvents).values([
      {
        eventType: 'ui_action',
        occurredAt: `${DAY}T12:00:00.000Z`,
        actorUserId: actorId,
        traceId: TRACE_A,
        routeTemplate: '/home',
        details: { browserEventType: 'route_view' },
      },
      {
        eventType: 'ui_action',
        occurredAt: `${DAY}T12:01:00.000Z`,
        actorUserId: actorId,
        traceId: TRACE_A,
        routeTemplate: '/calendar',
        details: { browserEventType: 'route_view' },
      },
      {
        eventType: 'ui_action',
        occurredAt: `${DAY}T12:02:00.000Z`,
        actorUserId: actorId,
        traceId: TRACE_B,
        routeTemplate: '/backlog/prd/concrete-id',
        details: { browserEventType: 'route_view' },
      },
      {
        eventType: 'api_request',
        occurredAt: `${DAY}T12:03:00.000Z`,
        actorUserId: actorId,
        traceId: TRACE_B,
        routeTemplate: '/api/projects',
        details: { trigger: 'poll' },
      },
    ]);

    const service = createJourneyAggregationService({ isCaptureEnabled: async () => true });
    await service.reconcileJourneyDays(DAY, DAY);

    const rows = await db.select().from(tracePathRollups).where(eq(tracePathRollups.day, DAY));
    const blob = JSON.stringify(rows);
    expect(blob).not.toContain(actorId);
    expect(blob).not.toContain('concrete-id');
    expect(blob).not.toContain('/api/projects');
    expect(rows.every((row) => !row.fromRoute.includes('?') && !row.toRoute.includes('?'))).toBe(true);
    expect(rows.some((row) => row.fromRoute === '/home' && row.toRoute === '/calendar')).toBe(true);
  });

  it('VT-05 assigns a cross-midnight transition to the destination UTC day only', async () => {
    const [actorId] = await actors();
    if (!actorId) return;

    await db.insert(traceEvents).values([
      {
        eventType: 'ui_action',
        occurredAt: `${PREV_DAY}T23:50:00.000Z`,
        actorUserId: actorId,
        traceId: TRACE_A,
        routeTemplate: '/home',
        details: { browserEventType: 'route_view' },
      },
      {
        eventType: 'ui_action',
        occurredAt: `${DAY}T00:05:00.000Z`,
        actorUserId: actorId,
        traceId: TRACE_A,
        routeTemplate: '/calendar',
        details: { browserEventType: 'route_view' },
      },
    ]);

    const service = createJourneyAggregationService({ isCaptureEnabled: async () => true });
    await service.reconcileJourneyDays(PREV_DAY, DAY);

    const rows = await db.select().from(tracePathRollups).where(eq(tracePathRollups.fromRoute, '/home'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.day).toBe(DAY);
    expect(rows[0]?.toRoute).toBe('/calendar');
  });

  it('VT-13 uses bounded indexed access for the eligible source query', async () => {
    const indexResult = await db.execute<{ indexname: string }>(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'trace_events'`,
    );
    const names = rowsOf(indexResult).map((row) => row.indexname);
    expect(names).toEqual(
      expect.arrayContaining(['idx_trace_events_actor_occurred', 'idx_trace_events_occurred']),
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const explained = await client.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON)
         SELECT id, actor_user_id, route_template, occurred_at
         FROM trace_events
         WHERE event_type = 'ui_action'
           AND actor_user_id IS NOT NULL
           AND occurred_at >= TIMESTAMPTZ '2026-08-16T23:30:00Z'
           AND occurred_at < TIMESTAMPTZ '2026-08-18T00:00:00Z'
         ORDER BY actor_user_id, occurred_at, id`,
      );
      const planText = JSON.stringify(explained.rows);
      expect(planText).toMatch(/Index Scan|Bitmap Index Scan|Index Only Scan/);
      expect(planText).toMatch(/idx_trace_events_occurred|idx_trace_events_actor_occurred/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
