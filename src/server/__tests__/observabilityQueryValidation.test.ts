/**
 * TBI-007 DoD-0 / VT-04 — query parsers, range bounds, and cursor codec.
 */
import {
  OBSERVABILITY_CURSOR_VERSION,
  OBSERVABILITY_MAX_ROWS,
  OBSERVABILITY_PAGE_SIZE,
  type UserTrailQuery,
} from '../../shared/types/observability';
import {
  ObservabilityQueryError,
  encodeObservabilityCursor,
  encodeSessionTimelineCursor,
  hashTrailFilters,
  hashSessionTimelineFilters,
  parseJourneyQuery,
  parseProjectParam,
  parseSessionOverlayQuery,
  parseSessionTimelineQuery,
  parseTraceQuery,
  parseUserTrailQuery,
} from '../services/observabilityQueryValidation';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const FROM = '2026-08-01T00:00:00.000Z';
const TO = '2026-08-10T00:00:00.000Z';
const EVENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function trailParams(overrides: Record<string, unknown> = {}) {
  return {
    project: 'Apex',
    actorId: ACTOR_ID,
    from: FROM,
    to: TO,
    ...overrides,
  };
}

describe('observabilityQueryValidation VT-04', () => {
  it('DoD-0 parses a valid trail query with optional filters', () => {
    const parsed = parseUserTrailQuery(
      trailParams({
        traceId: TRACE_ID,
        routeTemplate: '/api/projects',
        statusCode: '200',
        eventType: 'api_request',
      }),
    );

    expect(parsed).toEqual<UserTrailQuery>({
      actorId: ACTOR_ID,
      from: FROM,
      to: TO,
      traceId: TRACE_ID,
      routeTemplate: '/api/projects',
      statusCode: 200,
      eventType: 'api_request',
      cursor: null,
    });
  });

  it('VT-04 / DoD-0 table — malformed input maps to a stable 400 code before any store access', () => {
    const cases: Array<{ name: string; run: () => unknown; code: string }> = [
      {
        name: 'missing project',
        run: () => parseProjectParam({}),
        code: 'OBSERVABILITY_INVALID_QUERY',
      },
      {
        name: 'malformed actor UUID',
        run: () => parseUserTrailQuery(trailParams({ actorId: 'not-a-uuid' })),
        code: 'OBSERVABILITY_INVALID_QUERY',
      },
      {
        name: 'malformed session UUID',
        run: () =>
          parseSessionOverlayQuery(
            { sessionId: 'session-1' },
            { project: 'Apex', from: FROM, to: TO },
          ),
        code: 'OBSERVABILITY_INVALID_QUERY',
      },
      {
        name: 'malformed W3C trace ID',
        run: () => parseTraceQuery({ traceId: 'not-a-trace' }, { project: 'Apex' }),
        code: 'OBSERVABILITY_INVALID_QUERY',
      },
      {
        name: 'uppercase W3C trace ID',
        run: () => parseUserTrailQuery(trailParams({ traceId: TRACE_ID.toUpperCase() })),
        code: 'OBSERVABILITY_INVALID_QUERY',
      },
      {
        name: 'invalid timestamp',
        run: () => parseUserTrailQuery(trailParams({ from: 'yesterday' })),
        code: 'OBSERVABILITY_INVALID_QUERY',
      },
      {
        name: 'invalid day',
        run: () => parseJourneyQuery({ project: 'Apex', fromDay: '2026-13-40', toDay: '2026-08-17' }),
        code: 'OBSERVABILITY_INVALID_QUERY',
      },
      {
        name: 'query-string route',
        run: () => parseUserTrailQuery(trailParams({ routeTemplate: '/api/projects?id=1' })),
        code: 'OBSERVABILITY_INVALID_QUERY',
      },
      {
        name: 'concrete route identifier',
        run: () => parseUserTrailQuery(trailParams({ routeTemplate: '/backlog/interview/99' })),
        code: 'OBSERVABILITY_INVALID_QUERY',
      },
      {
        name: 'invalid status code',
        run: () => parseUserTrailQuery(trailParams({ statusCode: '99' })),
        code: 'OBSERVABILITY_INVALID_QUERY',
      },
      {
        name: 'invalid event type',
        run: () => parseUserTrailQuery(trailParams({ eventType: 'route_view' })),
        code: 'OBSERVABILITY_INVALID_QUERY',
      },
      {
        name: 'from >= to',
        run: () => parseUserTrailQuery(trailParams({ from: TO, to: FROM })),
        code: 'OBSERVABILITY_UNSUPPORTED_RANGE',
      },
      {
        name: 'raw range over 30 days',
        run: () =>
          parseUserTrailQuery(
            trailParams({ from: '2026-07-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' }),
          ),
        code: 'OBSERVABILITY_UNSUPPORTED_RANGE',
      },
      {
        name: 'journey inverted days',
        run: () => parseJourneyQuery({ project: 'Apex', fromDay: '2026-08-18', toDay: '2026-08-17' }),
        code: 'OBSERVABILITY_UNSUPPORTED_RANGE',
      },
      {
        name: 'tampered cursor payload',
        run: () => parseUserTrailQuery(trailParams({ cursor: '%%%not-base64%%%' })),
        code: 'OBSERVABILITY_INVALID_CURSOR',
      },
    ];

    for (const testCase of cases) {
      try {
        testCase.run();
        throw new Error(`${testCase.name} did not throw`);
      } catch (err) {
        expect(err).toBeInstanceOf(ObservabilityQueryError);
        expect((err as ObservabilityQueryError).code).toBe(testCase.code);
        expect((err as ObservabilityQueryError).status).toBe(400);
      }
    }
  });

  it('VT-04 rejects a cursor whose filter fingerprint does not match the current query', () => {
    const cursor = encodeObservabilityCursor({
      version: 1,
      kind: 'trail',
      filterHash: 'deadbeef',
      emittedCount: 50,
      last: { occurredAt: FROM, id: EVENT_ID },
    });

    expect(() => parseUserTrailQuery(trailParams({ cursor }))).toThrow(
      expect.objectContaining({ code: 'OBSERVABILITY_INVALID_CURSOR' }),
    );
  });

  it('VT-02 / VT-03 round-trips a valid cursor for the same normalized filters', () => {
    const parsed = parseUserTrailQuery(trailParams());
    const cursor = encodeObservabilityCursor({
      version: 1,
      kind: 'trail',
      filterHash: hashTrailFilters(parsed),
      emittedCount: 50,
      last: { occurredAt: '2026-08-01T12:00:00.000Z', id: EVENT_ID },
    });

    const continued = parseUserTrailQuery(trailParams({ cursor }));
    expect(continued.cursor).toEqual({
      emittedCount: 50,
      last: { occurredAt: '2026-08-01T12:00:00.000Z', id: EVENT_ID },
    });
  });

  it('VT-03 refuses continuation after 500 emitted rows', () => {
    const parsed = parseUserTrailQuery(trailParams());
    const cursor = encodeObservabilityCursor({
      version: 1,
      kind: 'trail',
      filterHash: hashTrailFilters(parsed),
      emittedCount: OBSERVABILITY_MAX_ROWS,
      last: { occurredAt: FROM, id: EVENT_ID },
    });

    expect(() => parseUserTrailQuery(trailParams({ cursor }))).toThrow(
      expect.objectContaining({ code: 'OBSERVABILITY_INVALID_CURSOR' }),
    );
  });

  it('DoD-0 accepts a day-aligned journey range and UUID session overlay', () => {
    const journey = parseJourneyQuery({
      project: 'Apex',
      fromDay: '2026-08-01',
      toDay: '2026-08-17',
      fromRoute: '/home',
    });
    expect(journey).toMatchObject({
      fromDay: '2026-08-01',
      toDay: '2026-08-17',
      fromRoute: '/home',
      toRoute: null,
      cursor: null,
    });

    const overlay = parseSessionOverlayQuery(
      { sessionId: SESSION_ID },
      { project: 'Apex', from: FROM, to: TO, eventType: 'error' },
    );
    expect(overlay).toMatchObject({
      sessionId: SESSION_ID,
      eventType: 'error',
      cursor: null,
    });
  });

  it('VT-10 parses a valid session timeline query and rejects malformed session IDs or cursors', () => {
    const parsed = parseSessionTimelineQuery({ sessionId: SESSION_ID }, { project: 'Apex' });
    expect(parsed).toEqual({ sessionId: SESSION_ID, cursor: null });

    const cursor = encodeSessionTimelineCursor(hashSessionTimelineFilters(SESSION_ID), 50, {
      occurredAt: '2026-08-01T12:00:00.000Z',
      sourceRank: 0,
      sequence: 3,
      id: EVENT_ID,
    });
    const paged = parseSessionTimelineQuery({ sessionId: SESSION_ID }, { cursor });
    expect(paged.cursor).toEqual({
      emittedCount: 50,
      last: {
        occurredAt: '2026-08-01T12:00:00.000Z',
        sourceRank: 0,
        sequence: 3,
        id: EVENT_ID,
      },
    });

    expect(parseSessionTimelineQuery({ sessionId: 'express-session-abc' }, { project: 'Apex' })).toEqual({
      sessionId: 'express-session-abc',
      cursor: null,
    });
    expect(() => parseSessionTimelineQuery({ sessionId: 'bad/session' }, {})).toThrow(ObservabilityQueryError);
    expect(() => parseSessionTimelineQuery({ sessionId: SESSION_ID }, { limit: '500' })).toThrow(
      ObservabilityQueryError,
    );
    expect(() => parseSessionTimelineQuery({ sessionId: SESSION_ID }, { cursor: '%%%' })).toThrow(
      ObservabilityQueryError,
    );
    expect(() =>
      parseSessionTimelineQuery(
        { sessionId: SESSION_ID },
        {
          cursor: encodeObservabilityCursor({
            version: OBSERVABILITY_CURSOR_VERSION,
            kind: 'trail',
            filterHash: hashTrailFilters({
              actorId: ACTOR_ID,
              from: FROM,
              to: TO,
              traceId: null,
              routeTemplate: null,
              statusCode: null,
              eventType: null,
            }),
            emittedCount: 0,
            last: { occurredAt: FROM, id: EVENT_ID },
          }),
        },
      ),
    ).toThrow(ObservabilityQueryError);
    expect(OBSERVABILITY_PAGE_SIZE).toBe(50);
  });
});
