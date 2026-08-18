/**
 * VT-03 / VT-04 / VT-12 — persist safe Trace Events against PostgreSQL.
 * Requires a migrated TEST_DATABASE_URL / DATABASE_URL (`npm run test:integration`).
 */
import './setup';
import { eq, sql } from 'drizzle-orm';
import { db } from './setup';
import pool from '../../src/server/db';
import { TRACE_REDACTED_MARKER } from '../../src/shared/types/observability';
import { toSafeTraceEvent } from '../../src/shared/utils/traceRedaction';
import { insertSafeTraceEvents } from '../../src/server/services/traceEventStorageService';
import { traceEvents, tracePathRollups } from '../../src/server/db/schema';

const TRACE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function rowsOf<T>(result: { rows?: T[] } | T[]): T[] {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

async function cleanup(): Promise<void> {
  await db.delete(traceEvents).where(eq(traceEvents.traceId, TRACE_ID));
  await db.delete(tracePathRollups).where(eq(tracePathRollups.fromRoute, '/observability/from'));
}

describe('Safe Trace Event Storage integration', () => {
  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(async () => {
    await pool.end();
  });

  it('DoD-1 / VT-03 round-trips redacted fields through Drizzle', async () => {
    const safe = toSafeTraceEvent({
      eventType: 'api_request',
      occurredAt: '2026-08-17T12:00:00.000Z',
      actorUserId: null,
      projectId: 'Apex',
      traceId: TRACE_ID,
      sessionId: 'session-obs-1',
      routeTemplate: '/api/interviews/:id',
      httpMethod: 'GET',
      statusCode: 200,
      durationMs: 11,
      severity: 'info',
      details: { keep: 'ok', token: 'nope' },
    });

    await insertSafeTraceEvents([safe]);

    const rows = await db.select().from(traceEvents).where(eq(traceEvents.traceId, TRACE_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe('api_request');
    expect(rows[0]?.routeTemplate).toBe('/api/interviews/:id');
    expect(rows[0]?.details).toEqual({ keep: 'ok', token: TRACE_REDACTED_MARKER });
    expect(rows[0]?.occurredAt).toContain('2026-08-17');
  });

  it('DoD-0 / VT-12 persists no denied secrets, bodies, query strings, or raw stacks', async () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const pat = 'b'.repeat(52);
    await insertSafeTraceEvents([
      toSafeTraceEvent({
        eventType: 'error',
        occurredAt: '2026-08-17T12:01:00.000Z',
        actorUserId: null,
        traceId: TRACE_ID,
        routeTemplate: '/api/work-items/99?q=secretQuery',
        details: {
          headers: {
            Authorization: 'Bearer leaked-header',
            Cookie: 'sid=abc',
            'Content-Type': 'application/json',
          },
          body: { interviewText: 'BODY-MARKER' },
          note: `Bearer leaked-bearer ${jwt} ${pat} api_key=sk-live-xyz postgres://u:p@host/db`,
          error: Object.assign(new Error('Bearer leaked-error'), {
            stack: 'Error: Bearer leaked-error\n    at secret.js:1:1\n' + '    at frame\n'.repeat(40),
            extra: 'raw-enumerable',
          }),
        },
      }),
    ]);

    const stored = await db
      .select({ details: traceEvents.details, routeTemplate: traceEvents.routeTemplate })
      .from(traceEvents)
      .where(eq(traceEvents.traceId, TRACE_ID));
    const blob = JSON.stringify(stored);
    expect(stored[0]?.routeTemplate).toBe('/api/work-items/:id');
    expect(blob).not.toContain('leaked-header');
    expect(blob).not.toContain('leaked-bearer');
    expect(blob).not.toContain('BODY-MARKER');
    expect(blob).not.toContain('secretQuery');
    expect(blob).not.toContain('sk-live-xyz');
    expect(blob).not.toContain(jwt);
    expect(blob).not.toContain(pat);
    expect(blob).not.toContain('raw-enumerable');
  });

  it('DoD-2 rejects invalid discriminator and query-bearing routes at the database', async () => {
    await expect(
      db.insert(traceEvents).values({
        eventType: 'not_a_type' as never,
        occurredAt: new Date().toISOString(),
        traceId: TRACE_ID,
        details: {},
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(traceEvents).values({
        eventType: 'api_request',
        occurredAt: new Date().toISOString(),
        traceId: TRACE_ID,
        routeTemplate: '/api/x?y=1',
        details: {},
      }),
    ).rejects.toThrow();
  });

  it('DoD-2 NFR / VT-04 installs the intended indexes for actor, trace, session, route, and cutoff queries', async () => {
    const result = await db.execute<{ indexname: string }>(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'trace_events'`,
    );
    const names = rowsOf(result).map((row) => row.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'idx_trace_events_actor_occurred',
        'idx_trace_events_trace_occurred',
        'idx_trace_events_session_occurred',
        'idx_trace_events_route_occurred',
        'idx_trace_events_occurred',
      ]),
    );
  });

  it('DoD-0 creates identifier-free rollup rows', async () => {
    await db.insert(tracePathRollups).values({
      fromRoute: '/observability/from',
      toRoute: '/observability/to',
      day: '2026-08-17',
      transitionCount: 3,
      distinctActorCount: 2,
    });
    const rows = await db
      .select()
      .from(tracePathRollups)
      .where(eq(tracePathRollups.fromRoute, '/observability/from'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('actorUserId');
    expect(JSON.stringify(rows[0])).not.toMatch(/user-|oid-/);
  });
});
