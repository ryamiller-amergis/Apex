/**
 * TBI-007 — safe Super Admin Observability query operations.
 * Explicit projections only; never select or spread trace_events.details.
 */
import { and, asc, eq, gt, gte, lte, or, sql, type SQL } from 'drizzle-orm';
import { db as defaultDb } from '../db/drizzle';
import { traceEvents, tracePathRollups } from '../db/schema';
import {
  OBSERVABILITY_MAX_ROWS,
  OBSERVABILITY_PAGE_SIZE,
  type CaptureHealthResponse,
  type CaptureTrigger,
  type JourneyEdgePage,
  type JourneyEdgeView,
  type JourneyQuery,
  type SessionOverlayPage,
  type SessionOverlayQuery,
  type TraceEventPage,
  type TraceEventType,
  type TraceEventView,
  type TraceQuery,
  type UserTrailQuery,
  type SessionTimelineQuery,
  type SessionTimelineResponse,
} from '../../shared/types/observability';
import { getCaptureHealth as getOperationsCaptureHealth } from './observabilityOperationsService';
import { getSessionTimeline as readSessionTimeline } from './observabilitySessionTimeline';
import {
  encodeJourneyPageCursor,
  encodeTracePageCursor,
  hashJourneyFilters,
  hashSessionFilters,
  hashTraceFilters,
  hashTrailFilters,
} from './observabilityQueryValidation';

const DIAGNOSTIC_SUMMARY_MAX = 512;

export const SAFE_TRACE_EVENT_SELECT = {
  id: traceEvents.id,
  eventType: traceEvents.eventType,
  occurredAt: traceEvents.occurredAt,
  actorId: traceEvents.actorUserId,
  projectId: traceEvents.projectId,
  traceId: traceEvents.traceId,
  sessionId: traceEvents.sessionId,
  routeTemplate: traceEvents.routeTemplate,
  method: traceEvents.httpMethod,
  statusCode: traceEvents.statusCode,
  durationMs: traceEvents.durationMs,
  severity: traceEvents.severity,
  trigger: sql<string | null>`(${traceEvents.details} ->> 'trigger')`,
  diagnosticSummary: sql<string | null>`(${traceEvents.details} ->> 'message')`,
};

const SAFE_JOURNEY_SELECT = {
  day: tracePathRollups.day,
  fromRoute: tracePathRollups.fromRoute,
  toRoute: tracePathRollups.toRoute,
  transitionCount: tracePathRollups.transitionCount,
  distinctActorCount: tracePathRollups.distinctActorCount,
};

export interface ObservabilityQueryDb {
  select: (projection: unknown) => {
    from: (table: unknown) => {
      where: (condition: unknown) => {
        orderBy: (...order: unknown[]) => {
          limit: (count: number) => Promise<unknown[]>;
        };
      };
    };
  };
}

export interface ObservabilityQueryDeps {
  db?: ObservabilityQueryDb;
  getCaptureHealth?: () => Promise<CaptureHealthResponse>;
}

export interface ObservabilityQueryService {
  queryUserTrail(filters: UserTrailQuery): Promise<TraceEventPage>;
  queryTrace(filters: TraceQuery): Promise<TraceEventPage | null>;
  querySessionOverlay(filters: SessionOverlayQuery): Promise<SessionOverlayPage | null>;
  queryJourneyMap(filters: JourneyQuery): Promise<JourneyEdgePage>;
  getCaptureHealth(): Promise<CaptureHealthResponse>;
  getSessionTimeline(query: SessionTimelineQuery): Promise<SessionTimelineResponse>;
}

function asNullString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value);
  return text.length > 0 ? text : null;
}

function mapTrigger(value: unknown): CaptureTrigger | null {
  return value === 'human' || value === 'poll' ? value : null;
}

function mapDiagnosticSummary(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.length > DIAGNOSTIC_SUMMARY_MAX ? value.slice(0, DIAGNOSTIC_SUMMARY_MAX) : value;
}

export function mapTraceEventView(row: Record<string, unknown>): TraceEventView {
  return {
    id: String(row.id),
    eventType: row.eventType as TraceEventType,
    occurredAt: String(row.occurredAt),
    actorId: asNullString(row.actorId),
    projectId: asNullString(row.projectId),
    traceId: String(row.traceId),
    sessionId: asNullString(row.sessionId),
    routeTemplate: asNullString(row.routeTemplate),
    method: asNullString(row.method),
    statusCode: typeof row.statusCode === 'number' ? row.statusCode : null,
    durationMs: typeof row.durationMs === 'number' ? row.durationMs : null,
    severity: asNullString(row.severity),
    trigger: mapTrigger(row.trigger),
    diagnosticSummary: mapDiagnosticSummary(row.diagnosticSummary),
  };
}

function mapJourneyEdge(row: Record<string, unknown>): JourneyEdgeView {
  return {
    day: String(row.day),
    fromRoute: String(row.fromRoute),
    toRoute: String(row.toRoute),
    transitionCount: Number(row.transitionCount) || 0,
    distinctActorCount: Number(row.distinctActorCount) || 0,
  };
}

function fetchLimit(emittedCount: number): number {
  const remaining = OBSERVABILITY_MAX_ROWS - emittedCount;
  return Math.min(OBSERVABILITY_PAGE_SIZE + 1, Math.max(remaining, 0) + 1);
}

function paginate<T>(
  rows: T[],
  emittedCount: number,
  encodeCursor: (emitted: number, last: T) => string,
): { items: T[]; nextCursor: string | null; capReached: boolean } {
  const remaining = OBSERVABILITY_MAX_ROWS - emittedCount;
  const take = Math.min(OBSERVABILITY_PAGE_SIZE, remaining, rows.length);
  const items = rows.slice(0, take);
  const newEmitted = emittedCount + items.length;
  const capReached = newEmitted >= OBSERVABILITY_MAX_ROWS;
  const hasMore = rows.length > items.length;
  const last = items[items.length - 1];
  const nextCursor = !capReached && hasMore && last ? encodeCursor(newEmitted, last) : null;
  return { items, nextCursor, capReached };
}

function traceKeysetPredicate(cursor: UserTrailQuery['cursor']): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    gt(traceEvents.occurredAt, cursor.last.occurredAt),
    and(eq(traceEvents.occurredAt, cursor.last.occurredAt), gt(traceEvents.id, cursor.last.id)),
  );
}

function journeyKeysetPredicate(cursor: JourneyQuery['cursor']): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    gt(tracePathRollups.day, cursor.last.day),
    and(eq(tracePathRollups.day, cursor.last.day), gt(tracePathRollups.fromRoute, cursor.last.fromRoute)),
    and(
      eq(tracePathRollups.day, cursor.last.day),
      eq(tracePathRollups.fromRoute, cursor.last.fromRoute),
      gt(tracePathRollups.toRoute, cursor.last.toRoute),
    ),
  );
}

function combine(...parts: Array<SQL | undefined>): SQL | undefined {
  const present = parts.filter((part): part is SQL => part != null);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return and(...present);
}

export function createObservabilityQueryService(
  deps: ObservabilityQueryDeps = {},
): ObservabilityQueryService {
  const drizzle = deps.db ?? (defaultDb as unknown as ObservabilityQueryDb);
  const readHealth = deps.getCaptureHealth ?? getOperationsCaptureHealth;

  async function selectTraceRows(whereClause: SQL | undefined, limit: number): Promise<TraceEventView[]> {
    const rows = await drizzle
      .select(SAFE_TRACE_EVENT_SELECT)
      .from(traceEvents)
      .where(whereClause ?? sql`true`)
      .orderBy(asc(traceEvents.occurredAt), asc(traceEvents.id))
      .limit(limit);
    return (rows as Array<Record<string, unknown>>).map(mapTraceEventView);
  }

  async function queryUserTrail(filters: UserTrailQuery): Promise<TraceEventPage> {
    const emittedCount = filters.cursor?.emittedCount ?? 0;
    const whereClause = combine(
      eq(traceEvents.actorUserId, filters.actorId),
      gte(traceEvents.occurredAt, filters.from),
      lte(traceEvents.occurredAt, filters.to),
      filters.traceId ? eq(traceEvents.traceId, filters.traceId) : undefined,
      filters.routeTemplate ? eq(traceEvents.routeTemplate, filters.routeTemplate) : undefined,
      filters.statusCode != null ? eq(traceEvents.statusCode, filters.statusCode) : undefined,
      filters.eventType ? eq(traceEvents.eventType, filters.eventType) : undefined,
      traceKeysetPredicate(filters.cursor),
    );
    const rows = await selectTraceRows(whereClause, fetchLimit(emittedCount));
    return paginate(rows, emittedCount, (emitted, last) =>
      encodeTracePageCursor('trail', hashTrailFilters(filters), emitted, {
        occurredAt: last.occurredAt,
        id: last.id,
      }),
    );
  }

  async function queryTrace(filters: TraceQuery): Promise<TraceEventPage | null> {
    const emittedCount = filters.cursor?.emittedCount ?? 0;
    const whereClause = combine(
      eq(traceEvents.traceId, filters.traceId),
      filters.from ? gte(traceEvents.occurredAt, filters.from) : undefined,
      filters.to ? lte(traceEvents.occurredAt, filters.to) : undefined,
      traceKeysetPredicate(filters.cursor),
    );
    const rows = await selectTraceRows(whereClause, fetchLimit(emittedCount));
    if (!filters.cursor && rows.length === 0) return null;
    return paginate(rows, emittedCount, (emitted, last) =>
      encodeTracePageCursor('trace', hashTraceFilters(filters), emitted, {
        occurredAt: last.occurredAt,
        id: last.id,
      }),
    );
  }

  async function querySessionOverlay(filters: SessionOverlayQuery): Promise<SessionOverlayPage | null> {
    const emittedCount = filters.cursor?.emittedCount ?? 0;
    const whereClause = combine(
      eq(traceEvents.sessionId, filters.sessionId),
      gte(traceEvents.occurredAt, filters.from),
      lte(traceEvents.occurredAt, filters.to),
      filters.eventType ? eq(traceEvents.eventType, filters.eventType) : undefined,
      traceKeysetPredicate(filters.cursor),
    );
    const rows = await selectTraceRows(whereClause, fetchLimit(emittedCount));
    if (!filters.cursor && rows.length === 0) return null;
    const page = paginate(rows, emittedCount, (emitted, last) =>
      encodeTracePageCursor('session', hashSessionFilters(filters), emitted, {
        occurredAt: last.occurredAt,
        id: last.id,
      }),
    );
    return {
      sessionId: filters.sessionId,
      events: page.items,
      nextCursor: page.nextCursor,
      capReached: page.capReached,
    };
  }

  async function queryJourneyMap(filters: JourneyQuery): Promise<JourneyEdgePage> {
    const emittedCount = filters.cursor?.emittedCount ?? 0;
    const whereClause = combine(
      gte(tracePathRollups.day, filters.fromDay),
      lte(tracePathRollups.day, filters.toDay),
      filters.fromRoute ? eq(tracePathRollups.fromRoute, filters.fromRoute) : undefined,
      filters.toRoute ? eq(tracePathRollups.toRoute, filters.toRoute) : undefined,
      journeyKeysetPredicate(filters.cursor),
    );
    const rows = (await drizzle
      .select(SAFE_JOURNEY_SELECT)
      .from(tracePathRollups)
      .where(whereClause ?? sql`true`)
      .orderBy(asc(tracePathRollups.day), asc(tracePathRollups.fromRoute), asc(tracePathRollups.toRoute))
      .limit(fetchLimit(emittedCount))) as Array<Record<string, unknown>>;
    const mapped = rows.map(mapJourneyEdge);
    return paginate(mapped, emittedCount, (emitted, last) =>
      encodeJourneyPageCursor(hashJourneyFilters(filters), emitted, {
        day: last.day,
        fromRoute: last.fromRoute,
        toRoute: last.toRoute,
      }),
    );
  }

  async function getCaptureHealth(): Promise<CaptureHealthResponse> {
    return readHealth();
  }

  async function getSessionTimeline(query: SessionTimelineQuery): Promise<SessionTimelineResponse> {
    return readSessionTimeline(query);
  }

  return {
    queryUserTrail,
    queryTrace,
    querySessionOverlay,
    queryJourneyMap,
    getCaptureHealth,
    getSessionTimeline,
  };
}

let singleton: ObservabilityQueryService | null = null;

function getService(): ObservabilityQueryService {
  singleton ??= createObservabilityQueryService();
  return singleton;
}

export function queryUserTrail(filters: UserTrailQuery): Promise<TraceEventPage> {
  return getService().queryUserTrail(filters);
}

export function queryTrace(filters: TraceQuery): Promise<TraceEventPage | null> {
  return getService().queryTrace(filters);
}

export function querySessionOverlay(filters: SessionOverlayQuery): Promise<SessionOverlayPage | null> {
  return getService().querySessionOverlay(filters);
}

export function queryJourneyMap(filters: JourneyQuery): Promise<JourneyEdgePage> {
  return getService().queryJourneyMap(filters);
}

export function getCaptureHealth(): Promise<CaptureHealthResponse> {
  return getService().getCaptureHealth();
}

export function getSessionTimeline(query: SessionTimelineQuery): Promise<SessionTimelineResponse> {
  return getService().getSessionTimeline(query);
}

export function resetObservabilityQueryServiceForTests(): void {
  singleton = null;
}
