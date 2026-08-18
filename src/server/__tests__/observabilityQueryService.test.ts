/**
 * TBI-007 — ObservabilityQueryService.
 * Criterion ids: DoD-0, VT-01, VT-02, VT-03, VT-08, VT-09, VT-10, VT-11, VT-12.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CAPTURE_BUFFER_CAPACITY,
  type CaptureHealthResponse,
  type UserTrailQuery,
} from '../../shared/types/observability';
import {
  SAFE_TRACE_EVENT_SELECT,
  createObservabilityQueryService,
  mapTraceEventView,
} from '../services/observabilityQueryService';
import { traceEvents, tracePathRollups } from '../db/schema';
import { parseUserTrailQuery } from '../services/observabilityQueryValidation';

jest.mock('../db/drizzle', () => ({ db: { select: jest.fn() } }));
jest.mock('../services/observabilityOperationsService', () => ({
  getCaptureHealth: jest.fn(),
}));

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const FROM = '2026-08-01T00:00:00.000Z';
const TO = '2026-08-10T00:00:00.000Z';

function trailQuery(overrides: Partial<UserTrailQuery> = {}): UserTrailQuery {
  return {
    actorId: ACTOR_ID,
    from: FROM,
    to: TO,
    traceId: null,
    routeTemplate: null,
    statusCode: null,
    eventType: null,
    cursor: null,
    ...overrides,
  };
}

function safeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    eventType: 'api_request',
    occurredAt: '2026-08-01T12:00:00.000Z',
    actorId: ACTOR_ID,
    projectId: 'Apex',
    traceId: TRACE_ID,
    sessionId: SESSION_ID,
    routeTemplate: '/api/projects',
    method: 'GET',
    statusCode: 200,
    durationMs: 8,
    severity: 'info',
    trigger: 'human',
    diagnosticSummary: 'ok',
    ...overrides,
  };
}

function mockDb(rows: unknown[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ orderBy });
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });
  return { select, from, where, orderBy, limit };
}

describe('observabilityQueryService', () => {
  it('VT-01 returns chronological rows with id tie-breaks and never exposes details', async () => {
    const earlier = safeRow({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      occurredAt: '2026-08-01T12:00:00.000Z',
    });
    const laterSameTs = safeRow({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      occurredAt: '2026-08-01T12:00:00.000Z',
      details: {
        authorization: 'Bearer secret-token',
        cookie: 'sid=abc',
        email: 'user@test.com',
        body: { interview: 'secret-body' },
        stack: 'Error: boom\n    at secret.js:1:1',
      },
    });
    const chain = mockDb([earlier, laterSameTs]);
    const service = createObservabilityQueryService({ db: chain });

    const page = await service.queryUserTrail(trailQuery());

    expect(chain.select).toHaveBeenCalledWith(SAFE_TRACE_EVENT_SELECT);
    expect(SAFE_TRACE_EVENT_SELECT).not.toHaveProperty('details');
    expect(chain.limit).toHaveBeenCalledWith(51);
    expect(page.items.map((item) => item.id)).toEqual([earlier.id, laterSameTs.id]);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('details');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('user@test.com');
    expect(serialized).not.toContain('secret-body');
    expect(serialized).not.toContain('secret.js');
    expect(page.items[1]).toEqual(
      expect.objectContaining({
        id: laterSameTs.id,
        actorId: ACTOR_ID,
        trigger: 'human',
      }),
    );
    expect(page.items[1]).not.toHaveProperty('details');
  });

  it('VT-01 mapper ignores an injected details blob on a raw row', () => {
    const mapped = mapTraceEventView({
      ...safeRow(),
      details: { authorization: 'Bearer leaked', stack: 'raw-stack' },
    });
    expect(mapped).not.toHaveProperty('details');
    expect(JSON.stringify(mapped)).not.toContain('leaked');
    expect(JSON.stringify(mapped)).not.toContain('raw-stack');
  });

  it('VT-02 emits exactly 50 rows and a continuation cursor from 51 matches', async () => {
    const rows = Array.from({ length: 51 }, (_, index) =>
      safeRow({
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`,
        occurredAt: `2026-08-01T12:00:${String(index).padStart(2, '0')}.000Z`,
      }),
    );
    const chain = mockDb(rows);
    const service = createObservabilityQueryService({ db: chain });

    const page = await service.queryUserTrail(trailQuery());

    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.capReached).toBe(false);
    expect(page.items.map((item) => item.id)).not.toContain(rows[50].id);
  });

  it('VT-03 stops at 500 rows with capReached and no cursor while matches remain', async () => {
    const rows = Array.from({ length: 51 }, (_, index) =>
      safeRow({
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 400).padStart(12, '0')}`,
        occurredAt: `2026-08-01T13:00:${String(index).padStart(2, '0')}.000Z`,
      }),
    );
    const chain = mockDb(rows);
    const service = createObservabilityQueryService({ db: chain });
    const parsed = parseUserTrailQuery({
      actorId: ACTOR_ID,
      from: FROM,
      to: TO,
    });

    const page = await service.queryUserTrail({
      ...parsed,
      cursor: {
        emittedCount: 450,
        last: { occurredAt: '2026-08-01T12:59:00.000Z', id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000449' },
      },
    });

    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toBeNull();
    expect(page.capReached).toBe(true);
  });

  it('VT-09 returns an empty collection envelope and null for unknown exact resources', async () => {
    const empty = mockDb([]);
    const service = createObservabilityQueryService({ db: empty });

    await expect(service.queryUserTrail(trailQuery())).resolves.toEqual({
      items: [],
      nextCursor: null,
      capReached: false,
    });
    await expect(
      service.queryTrace({ traceId: TRACE_ID, from: null, to: null, cursor: null }),
    ).resolves.toBeNull();
    await expect(
      service.querySessionOverlay({
        sessionId: SESSION_ID,
        from: FROM,
        to: TO,
        eventType: null,
        cursor: null,
      }),
    ).resolves.toBeNull();
    await expect(
      service.queryJourneyMap({
        fromDay: '2026-08-01',
        toDay: '2026-08-17',
        fromRoute: null,
        toRoute: null,
        cursor: null,
      }),
    ).resolves.toEqual({ items: [], nextCursor: null, capReached: false });
  });

  it('VT-10 returns only Trace Event overlays and never queries agent lifecycle tables', async () => {
    const chain = mockDb([safeRow({ eventType: 'error', sessionId: SESSION_ID })]);
    const service = createObservabilityQueryService({ db: chain });

    const page = await service.querySessionOverlay({
      sessionId: SESSION_ID,
      from: FROM,
      to: TO,
      eventType: null,
      cursor: null,
    });

    expect(page).toEqual(
      expect.objectContaining({
        sessionId: SESSION_ID,
        capReached: false,
        nextCursor: null,
      }),
    );
    expect(page?.events).toHaveLength(1);
    expect(chain.from).toHaveBeenCalledWith(traceEvents);
    expect(chain.from).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'agent_runs' }));

    const source = fs.readFileSync(
      path.resolve(__dirname, '../services/observabilityQueryService.ts'),
      'utf8',
    );
    expect(source).toMatch(/getSessionTimeline/);
    expect(chain.from).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'agent_runs' }));
  });

  it('VT-11 reads Journey rollups only and never scans raw Trace Events for that path', async () => {
    const chain = mockDb([
      {
        day: '2026-08-17',
        fromRoute: '/home',
        toRoute: '/calendar',
        transitionCount: 4,
        distinctActorCount: 2,
      },
    ]);
    const service = createObservabilityQueryService({ db: chain });

    const page = await service.queryJourneyMap({
      fromDay: '2026-08-01',
      toDay: '2026-08-17',
      fromRoute: null,
      toRoute: null,
      cursor: null,
    });

    expect(chain.from).toHaveBeenCalledWith(tracePathRollups);
    expect(page.items).toEqual([
      {
        day: '2026-08-17',
        fromRoute: '/home',
        toRoute: '/calendar',
        transitionCount: 4,
        distinctActorCount: 2,
      },
    ]);
    expect(JSON.stringify(page)).not.toMatch(/actorId|traceId|details/);
  });

  it('VT-12 / DoD-2 delegates Capture Health without event payload content', async () => {
    const snapshot: CaptureHealthResponse = {
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
    const getCaptureHealth = jest.fn().mockResolvedValue(snapshot);
    const service = createObservabilityQueryService({
      db: mockDb([]),
      getCaptureHealth,
    });

    await expect(service.getCaptureHealth()).resolves.toEqual(snapshot);
    expect(getCaptureHealth).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(snapshot)).not.toMatch(/details|actorUserId|traceId/);
  });
});
