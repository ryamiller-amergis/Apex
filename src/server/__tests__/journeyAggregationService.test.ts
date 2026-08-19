/**
 * TBI-010 — Build normalized Journey Map rollups.
 * Criterion ids are greppable: DoD-0, DoD-1, DoD-2, BR-009, BR-012, VT-01–VT-05, VT-11, VT-14.
 */
jest.mock('../db/drizzle', () => ({
  db: {
    execute: jest.fn(),
    transaction: jest.fn(),
  },
}));
jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn() }));
jest.mock('../services/featureFlagService', () => ({
  isFeatureOperational: jest.fn(),
}));

import { getTableColumns, getTableName } from 'drizzle-orm';
import {
  BROWSER_TRACE_EVENT_TYPES,
  OBSERVABILITY_CAPTURE_FLAG,
  TRACE_EVENT_TYPES,
  UNKNOWN_ROUTE_TEMPLATE,
} from '../../shared/types/observability';
import { isRegisteredApexRouteTemplate } from '../../shared/utils/observabilityRouteRegistry';
import { traceEvents, tracePathRollups } from '../db/schema';
import { isFeatureOperational } from '../services/featureFlagService';
import {
  JOURNEY_INACTIVITY_MS,
  JOURNEY_ROLLUP_LOCK_KEY,
  aggregateJourneyEdges,
  createJourneyAggregationService,
  deriveJourneyTransitions,
  isEligibleJourneySource,
  utcDayOf,
  type JourneySourceEvent,
} from '../services/journeyAggregationService';

function event(overrides: Partial<JourneySourceEvent> & Pick<JourneySourceEvent, 'id' | 'occurredAt' | 'routeTemplate'>): JourneySourceEvent {
  return {
    actorUserId: 'actor-a',
    eventType: 'ui_action',
    browserEventType: 'route_view',
    trigger: null,
    ...overrides,
  };
}

describe('S1 FEAT-001 / FEAT-003 contracts', () => {
  it('DoD-1 / VT-04 / VT-14 confirms live route_view, machine-marker, unique rollup key, and UUID idempotency fields', () => {
    expect(TRACE_EVENT_TYPES).toContain('ui_action');
    expect(BROWSER_TRACE_EVENT_TYPES).toContain('route_view');
    expect(OBSERVABILITY_CAPTURE_FLAG).toBe('observability-capture');
    expect(UNKNOWN_ROUTE_TEMPLATE).toBe('unknown_route');
    expect(isRegisteredApexRouteTemplate('/home')).toBe(true);
    expect(isRegisteredApexRouteTemplate('/backlog/interview/abc')).toBe(false);
    expect(getTableName(traceEvents)).toBe('trace_events');
    expect(getTableName(tracePathRollups)).toBe('trace_path_rollups');
    expect(Object.keys(getTableColumns(traceEvents))).toEqual(
      expect.arrayContaining(['id', 'actorUserId', 'eventType', 'occurredAt', 'routeTemplate', 'details']),
    );
    expect(Object.keys(getTableColumns(tracePathRollups))).toEqual(
      expect.arrayContaining(['fromRoute', 'toRoute', 'day', 'transitionCount', 'distinctActorCount']),
    );
    expect(JOURNEY_ROLLUP_LOCK_KEY).toBe('apex:journey-rollup');
    expect(JOURNEY_INACTIVITY_MS).toBe(30 * 60 * 1000);
  });
});

describe('isEligibleJourneySource', () => {
  it('DoD-1 / VT-04 rejects poll, machine, actorless, malformed, and concrete routes', () => {
    expect(isEligibleJourneySource(event({ id: '1', occurredAt: '2026-08-17T12:00:00.000Z', routeTemplate: '/home' }))).toBe(true);
    expect(
      isEligibleJourneySource(
        event({ id: '2', occurredAt: '2026-08-17T12:00:00.000Z', routeTemplate: '/home', trigger: 'poll' }),
      ),
    ).toBe(false);
    expect(
      isEligibleJourneySource(
        event({ id: '3', occurredAt: '2026-08-17T12:00:00.000Z', routeTemplate: '/home', actorUserId: null }),
      ),
    ).toBe(false);
    expect(
      isEligibleJourneySource(
        event({ id: '4', occurredAt: '2026-08-17T12:00:00.000Z', routeTemplate: '/home', eventType: 'api_request' }),
      ),
    ).toBe(false);
    expect(
      isEligibleJourneySource(
        event({
          id: '5',
          occurredAt: '2026-08-17T12:00:00.000Z',
          routeTemplate: '/home',
          browserEventType: 'client_error',
        }),
      ),
    ).toBe(false);
    expect(
      isEligibleJourneySource(
        event({ id: '6', occurredAt: '2026-08-17T12:00:00.000Z', routeTemplate: '/backlog/interview/abc-123' }),
      ),
    ).toBe(false);
    expect(
      isEligibleJourneySource(
        event({ id: '7', occurredAt: '2026-08-17T12:00:00.000Z', routeTemplate: UNKNOWN_ROUTE_TEMPLATE }),
      ),
    ).toBe(false);
  });
});

describe('deriveJourneyTransitions', () => {
  it('VT-01 / DoD-0 derives consecutive human transitions with exact counts and no actor in output', () => {
    const transitions = deriveJourneyTransitions([
      event({ id: 'a1', actorUserId: 'actor-a', occurredAt: '2026-08-17T12:00:00.000Z', routeTemplate: '/home' }),
      event({ id: 'a2', actorUserId: 'actor-a', occurredAt: '2026-08-17T12:01:00.000Z', routeTemplate: '/calendar' }),
      event({ id: 'b1', actorUserId: 'actor-b', occurredAt: '2026-08-17T12:02:00.000Z', routeTemplate: '/home' }),
      event({ id: 'b2', actorUserId: 'actor-b', occurredAt: '2026-08-17T12:03:00.000Z', routeTemplate: '/calendar' }),
      event({ id: 'b3', actorUserId: 'actor-b', occurredAt: '2026-08-17T12:04:00.000Z', routeTemplate: '/backlog' }),
    ]);

    expect(transitions).toEqual([
      { fromRoute: '/home', toRoute: '/calendar', day: '2026-08-17' },
      { fromRoute: '/home', toRoute: '/calendar', day: '2026-08-17' },
      { fromRoute: '/calendar', toRoute: '/backlog', day: '2026-08-17' },
    ]);
    expect(JSON.stringify(transitions)).not.toMatch(/actor-a|actor-b|actorUserId/);

    const rollups = aggregateJourneyEdges([
      event({ id: 'a1', actorUserId: 'actor-a', occurredAt: '2026-08-17T12:00:00.000Z', routeTemplate: '/home' }),
      event({ id: 'a2', actorUserId: 'actor-a', occurredAt: '2026-08-17T12:01:00.000Z', routeTemplate: '/calendar' }),
      event({ id: 'b1', actorUserId: 'actor-b', occurredAt: '2026-08-17T12:02:00.000Z', routeTemplate: '/home' }),
      event({ id: 'b2', actorUserId: 'actor-b', occurredAt: '2026-08-17T12:03:00.000Z', routeTemplate: '/calendar' }),
    ]);
    expect(rollups).toEqual([
      {
        fromRoute: '/home',
        toRoute: '/calendar',
        day: '2026-08-17',
        transitionCount: 2,
        distinctActorCount: 2,
      },
    ]);
    expect(JSON.stringify(rollups)).not.toMatch(/actor-a|actor-b|actorUserId/);
  });

  it('VT-02 / DoD-0 orders by occurrence time then event id when input is shuffled or tied', () => {
    const transitions = deriveJourneyTransitions([
      event({ id: 'z-last', actorUserId: 'actor-a', occurredAt: '2026-08-17T12:00:00.000Z', routeTemplate: '/backlog' }),
      event({ id: 'a-first', actorUserId: 'actor-a', occurredAt: '2026-08-17T12:00:00.000Z', routeTemplate: '/home' }),
      event({ id: 'm-mid', actorUserId: 'actor-a', occurredAt: '2026-08-17T12:00:00.000Z', routeTemplate: '/calendar' }),
    ]);

    expect(transitions).toEqual([
      { fromRoute: '/home', toRoute: '/calendar', day: '2026-08-17' },
      { fromRoute: '/calendar', toRoute: '/backlog', day: '2026-08-17' },
    ]);
  });

  it('VT-03 / DoD-2 links at 29:59 and exactly 30:00 and starts a new journey beyond 30:00', () => {
    const start = '2026-08-17T12:00:00.000Z';
    const at2959 = new Date(Date.parse(start) + JOURNEY_INACTIVITY_MS - 1000).toISOString();
    const at3000 = new Date(Date.parse(start) + JOURNEY_INACTIVITY_MS).toISOString();
    const beyond = new Date(Date.parse(start) + JOURNEY_INACTIVITY_MS + 1).toISOString();

    expect(
      deriveJourneyTransitions([
        event({ id: '1', occurredAt: start, routeTemplate: '/home' }),
        event({ id: '2', occurredAt: at2959, routeTemplate: '/calendar' }),
      ]),
    ).toEqual([{ fromRoute: '/home', toRoute: '/calendar', day: utcDayOf(at2959) }]);

    expect(
      deriveJourneyTransitions([
        event({ id: '1', occurredAt: start, routeTemplate: '/home' }),
        event({ id: '2', occurredAt: at3000, routeTemplate: '/calendar' }),
      ]),
    ).toEqual([{ fromRoute: '/home', toRoute: '/calendar', day: utcDayOf(at3000) }]);

    expect(
      deriveJourneyTransitions([
        event({ id: '1', occurredAt: start, routeTemplate: '/home' }),
        event({ id: '2', occurredAt: beyond, routeTemplate: '/calendar' }),
      ]),
    ).toEqual([]);
  });

  it('VT-04 / DoD-1 / BR-009 excludes poll, machine, actorless, self-navigation, and concrete routes', () => {
    const transitions = deriveJourneyTransitions([
      event({ id: '1', occurredAt: '2026-08-17T12:00:00.000Z', routeTemplate: '/home' }),
      event({
        id: '2',
        occurredAt: '2026-08-17T12:01:00.000Z',
        routeTemplate: '/home',
      }),
      event({
        id: '3',
        occurredAt: '2026-08-17T12:02:00.000Z',
        routeTemplate: '/calendar',
        trigger: 'poll',
      }),
      event({
        id: '4',
        occurredAt: '2026-08-17T12:03:00.000Z',
        routeTemplate: '/backlog',
        actorUserId: null,
      }),
      event({
        id: '5',
        occurredAt: '2026-08-17T12:04:00.000Z',
        routeTemplate: '/backlog/prd/concrete-id',
      }),
      event({
        id: '6',
        occurredAt: '2026-08-17T12:05:00.000Z',
        routeTemplate: '/planning',
        eventType: 'api_request',
      }),
    ]);
    expect(transitions).toEqual([]);
  });

  it('VT-05 / DoD-2 assigns a cross-midnight transition once to the destination UTC day', () => {
    const transitions = deriveJourneyTransitions([
      event({ id: '1', occurredAt: '2026-08-16T23:50:00.000Z', routeTemplate: '/home' }),
      event({ id: '2', occurredAt: '2026-08-17T00:05:00.000Z', routeTemplate: '/calendar' }),
    ]);
    expect(transitions).toEqual([{ fromRoute: '/home', toRoute: '/calendar', day: '2026-08-17' }]);
    expect(transitions.filter((row) => row.day === '2026-08-16')).toEqual([]);
  });

  it('DoD-2 ignores duplicate source ids and empty input', () => {
    expect(deriveJourneyTransitions([])).toEqual([]);
    const transitions = deriveJourneyTransitions([
      event({ id: 'dup', occurredAt: '2026-08-17T12:00:00.000Z', routeTemplate: '/home' }),
      event({ id: 'dup', occurredAt: '2026-08-17T12:01:00.000Z', routeTemplate: '/calendar' }),
      event({ id: 'next', occurredAt: '2026-08-17T12:02:00.000Z', routeTemplate: '/backlog' }),
    ]);
    expect(transitions).toEqual([{ fromRoute: '/home', toRoute: '/backlog', day: '2026-08-17' }]);
  });

  it('DoD-2 uses a pre-range predecessor only as context for the destination day', () => {
    const transitions = deriveJourneyTransitions(
      [
        event({ id: '1', occurredAt: '2026-08-16T23:50:00.000Z', routeTemplate: '/home' }),
        event({ id: '2', occurredAt: '2026-08-17T00:10:00.000Z', routeTemplate: '/calendar' }),
        event({ id: '3', occurredAt: '2026-08-17T00:20:00.000Z', routeTemplate: '/backlog' }),
      ],
      { fromDay: '2026-08-17', throughDay: '2026-08-17' },
    );
    expect(transitions).toEqual([
      { fromRoute: '/home', toRoute: '/calendar', day: '2026-08-17' },
      { fromRoute: '/calendar', toRoute: '/backlog', day: '2026-08-17' },
    ]);
  });
});

describe('runJourneyAggregationCycle', () => {
  const isFeatureOperationalMock = isFeatureOperational as jest.MockedFunction<typeof isFeatureOperational>;

  beforeEach(() => {
    jest.clearAllMocks();
    isFeatureOperationalMock.mockResolvedValue(true);
  });

  it('VT-11 / BR-010 returns disabled without lock, source query, delete, or insert', async () => {
    const reconcileDays = jest.fn();
    const service = createJourneyAggregationService({
      isCaptureEnabled: async () => false,
      store: { reconcileDays },
      now: () => new Date('2026-08-17T15:00:00.000Z'),
    });

    const result = await service.runJourneyAggregationCycle();

    expect(result.status).toBe('disabled');
    expect(result.daysReconciled).toBe(0);
    expect(result.edgesWritten).toBe(0);
    expect(reconcileDays).not.toHaveBeenCalled();
  });

  it('DoD-0 / BR-012 reconciles previous and current UTC days when the lock is acquired', async () => {
    const reconcileDays = jest.fn().mockResolvedValue({
      lockAcquired: true,
      edgesWritten: 4,
      sourceRowsConsidered: 11,
      daysReconciled: 2,
    });
    const service = createJourneyAggregationService({
      isCaptureEnabled: async () => true,
      store: { reconcileDays },
      now: () => new Date('2026-08-17T15:00:00.000Z'),
    });

    const result = await service.runJourneyAggregationCycle();

    expect(reconcileDays).toHaveBeenCalledWith({
      fromDay: '2026-08-16',
      throughDay: '2026-08-17',
    });
    expect(result).toMatchObject({
      status: 'completed',
      daysReconciled: 2,
      edgesWritten: 4,
      sourceRowsConsidered: 11,
    });
    expect(typeof result.durationMs).toBe('number');
  });

  it('DoD-2 / BR-012 returns lock_skipped without writing when another instance owns the cycle', async () => {
    const reconcileDays = jest.fn().mockResolvedValue({
      lockAcquired: false,
      edgesWritten: 0,
      sourceRowsConsidered: 0,
      daysReconciled: 0,
    });
    const service = createJourneyAggregationService({
      store: { reconcileDays },
      now: () => new Date('2026-08-17T15:00:00.000Z'),
    });

    const result = await service.runJourneyAggregationCycle();
    expect(result.status).toBe('lock_skipped');
    expect(result.edgesWritten).toBe(0);
  });

  it('DoD-2 accepts an explicit backfill range', async () => {
    const reconcileDays = jest.fn().mockResolvedValue({
      lockAcquired: true,
      edgesWritten: 1,
      sourceRowsConsidered: 2,
      daysReconciled: 3,
    });
    const service = createJourneyAggregationService({ store: { reconcileDays } });

    const result = await service.reconcileJourneyDays('2026-08-01', '2026-08-03');
    expect(reconcileDays).toHaveBeenCalledWith({ fromDay: '2026-08-01', throughDay: '2026-08-03' });
    expect(result).toEqual({ daysReconciled: 3, edgesWritten: 1 });
  });

  it('VT-14 / DoD-1 operational metrics omit actors and routes', async () => {
    const track = jest.fn();
    const service = createJourneyAggregationService({
      store: {
        reconcileDays: async () => ({
          lockAcquired: true,
          edgesWritten: 2,
          sourceRowsConsidered: 5,
          daysReconciled: 2,
        }),
      },
      track,
      now: () => new Date('2026-08-17T15:00:00.000Z'),
    });

    await service.runJourneyAggregationCycle();
    const payload = JSON.stringify(track.mock.calls);
    expect(payload).not.toMatch(/actor-|\/home|\/calendar|actorUserId|fromRoute/);
    expect(track).toHaveBeenCalledWith(
      'observability.journey_rollup.completed',
      expect.objectContaining({ status: 'completed' }),
      expect.objectContaining({ edgesWritten: 2, sourceRowsConsidered: 5, daysReconciled: 2 }),
    );
  });
});
