/**
 * Pure Observability query parsers and opaque keyset cursor codec (TBI-007).
 * Rejects invalid input before any database access.
 */
import { createHash } from 'crypto';
import {
  HTTP_STATUS_MAX,
  HTTP_STATUS_MIN,
  OBSERVABILITY_CURSOR_VERSION,
  OBSERVABILITY_MAX_ROWS,
  OBSERVABILITY_PAGE_SIZE,
  OBSERVABILITY_RAW_RETENTION_DAYS,
  TRACE_EVENT_TYPES,
  W3C_TRACE_ID_PATTERN,
  type JourneyKeyset,
  type JourneyQuery,
  type ObservabilityCursorState,
  type ObservabilityErrorCode,
  type ObservabilityQueryKind,
  type SessionOverlayQuery,
  type SessionTimelineKeyset,
  type SessionTimelineQuery,
  type TraceEventKeyset,
  type TraceEventType,
  type TraceQuery,
  type UserTrailQuery,
} from '../../shared/types/observability';
import { normalizeRouteTemplate } from '../../shared/utils/traceRedaction';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_TYPE_SET = new Set<string>(TRACE_EVENT_TYPES);
const MAX_RETENTION_MS = OBSERVABILITY_RAW_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export class ObservabilityQueryError extends Error {
  readonly code: ObservabilityErrorCode;
  readonly status: number;

  constructor(code: ObservabilityErrorCode, message = 'Invalid observability query', status = 400) {
    super(message);
    this.name = 'ObservabilityQueryError';
    this.code = code;
    this.status = status;
  }
}

export interface EncodedObservabilityCursor {
  version: typeof OBSERVABILITY_CURSOR_VERSION;
  kind: ObservabilityQueryKind;
  filterHash: string;
  emittedCount: number;
  last: TraceEventKeyset | JourneyKeyset | SessionTimelineKeyset;
}

type QueryRecord = Record<string, unknown>;

function invalid(message = 'Invalid observability query'): never {
  throw new ObservabilityQueryError('OBSERVABILITY_INVALID_QUERY', message);
}

function unsupportedRange(): never {
  throw new ObservabilityQueryError('OBSERVABILITY_UNSUPPORTED_RANGE', 'Unsupported time range');
}

function invalidCursor(): never {
  throw new ObservabilityQueryError('OBSERVABILITY_INVALID_CURSOR', 'Invalid cursor');
}

export function singleQueryValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function requiredString(record: QueryRecord, key: string): string {
  const value = singleQueryValue(record[key]);
  if (!value || !value.trim()) invalid();
  return value.trim();
}

function optionalString(record: QueryRecord, key: string): string | null {
  const value = singleQueryValue(record[key]);
  if (value === undefined || value === '') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseProjectParam(query: QueryRecord): string {
  return requiredString(query, 'project');
}

export function parseUuid(value: string, label: 'actor' | 'session'): string {
  void label;
  if (!UUID_RE.test(value)) invalid();
  return value.toLowerCase();
}

/** Capture sessions use Express/browser ids; interview timelines still use UUIDs. */
export function parseSessionTimelineId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 128) invalid();
  if (/[/?#\s]/.test(trimmed)) invalid();
  return UUID_RE.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

export function parseTraceIdParam(value: string): string {
  const trimmed = value.trim();
  if (!W3C_TRACE_ID_PATTERN.test(trimmed)) invalid();
  return trimmed;
}

function parseIsoTimestamp(value: string): string {
  if (!value.endsWith('Z') && !/[+-]\d{2}:\d{2}$/.test(value)) invalid();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) invalid();
  return parsed.toISOString();
}

function parseDay(value: string): string {
  if (!DAY_RE.test(value)) invalid();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid();
  return value;
}

function assertRawRange(from: string, to: string): void {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  if (!(fromMs < toMs)) unsupportedRange();
  if (toMs - fromMs > MAX_RETENTION_MS) unsupportedRange();
}

export function parseRouteTemplateParam(value: string): string {
  if (value.includes('?') || value.includes('#')) invalid();
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) invalid();
  const canonical = trimmed.length > 1 && trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
  const normalized = normalizeRouteTemplate(canonical);
  if (!normalized || normalized !== canonical) invalid();
  return canonical;
}

function parseStatusCodeParam(value: string): number {
  if (!/^\d+$/.test(value)) invalid();
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < HTTP_STATUS_MIN || parsed > HTTP_STATUS_MAX) invalid();
  return parsed;
}

function parseEventTypeParam(value: string): TraceEventType {
  if (!EVENT_TYPE_SET.has(value)) invalid();
  return value as TraceEventType;
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function hashTrailFilters(query: Omit<UserTrailQuery, 'cursor'>): string {
  return stableHash({
    kind: 'trail',
    actorId: query.actorId,
    from: query.from,
    to: query.to,
    traceId: query.traceId,
    routeTemplate: query.routeTemplate,
    statusCode: query.statusCode,
    eventType: query.eventType,
  });
}

export function hashTraceFilters(query: Omit<TraceQuery, 'cursor'>): string {
  return stableHash({
    kind: 'trace',
    traceId: query.traceId,
    from: query.from,
    to: query.to,
  });
}

export function hashSessionFilters(query: Omit<SessionOverlayQuery, 'cursor'>): string {
  return stableHash({
    kind: 'session',
    sessionId: query.sessionId,
    from: query.from,
    to: query.to,
    eventType: query.eventType,
  });
}

export function hashJourneyFilters(query: Omit<JourneyQuery, 'cursor'>): string {
  return stableHash({
    kind: 'journey',
    fromDay: query.fromDay,
    toDay: query.toDay,
    fromRoute: query.fromRoute,
    toRoute: query.toRoute,
  });
}

export function encodeObservabilityCursor(cursor: EncodedObservabilityCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeObservabilityCursor(raw: string): EncodedObservabilityCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    invalidCursor();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalidCursor();
  const record = parsed as QueryRecord;
  if (record.version !== OBSERVABILITY_CURSOR_VERSION) invalidCursor();
  if (
    record.kind !== 'trail'
    && record.kind !== 'trace'
    && record.kind !== 'session'
    && record.kind !== 'journey'
    && record.kind !== 'session_timeline'
  ) {
    invalidCursor();
  }
  if (typeof record.filterHash !== 'string' || !record.filterHash) invalidCursor();
  if (!Number.isInteger(record.emittedCount) || (record.emittedCount as number) < 0) invalidCursor();
  if ((record.emittedCount as number) >= OBSERVABILITY_MAX_ROWS) invalidCursor();
  if (!record.last || typeof record.last !== 'object' || Array.isArray(record.last)) invalidCursor();
  return {
    version: OBSERVABILITY_CURSOR_VERSION,
    kind: record.kind as ObservabilityQueryKind,
    filterHash: record.filterHash as string,
    emittedCount: record.emittedCount as number,
    last: record.last as TraceEventKeyset | JourneyKeyset | SessionTimelineKeyset,
  };
}

function attachTraceCursor(
  kind: ObservabilityQueryKind,
  filterHash: string,
  rawCursor: string | null,
): ObservabilityCursorState<TraceEventKeyset> | null {
  if (!rawCursor) return null;
  const decoded = decodeObservabilityCursor(rawCursor);
  if (decoded.kind !== kind || decoded.filterHash !== filterHash) invalidCursor();
  const last = decoded.last as TraceEventKeyset;
  if (typeof last.occurredAt !== 'string' || typeof last.id !== 'string') invalidCursor();
  return { emittedCount: decoded.emittedCount, last };
}

function attachJourneyCursor(
  filterHash: string,
  rawCursor: string | null,
): ObservabilityCursorState<JourneyKeyset> | null {
  if (!rawCursor) return null;
  const decoded = decodeObservabilityCursor(rawCursor);
  if (decoded.kind !== 'journey' || decoded.filterHash !== filterHash) invalidCursor();
  const last = decoded.last as JourneyKeyset;
  if (typeof last.day !== 'string' || typeof last.fromRoute !== 'string' || typeof last.toRoute !== 'string') {
    invalidCursor();
  }
  return { emittedCount: decoded.emittedCount, last };
}

export function parseUserTrailQuery(query: QueryRecord): UserTrailQuery {
  const actorId = parseUuid(requiredString(query, 'actorId'), 'actor');
  const from = parseIsoTimestamp(requiredString(query, 'from'));
  const to = parseIsoTimestamp(requiredString(query, 'to'));
  assertRawRange(from, to);

  const traceIdRaw = optionalString(query, 'traceId');
  const routeRaw = optionalString(query, 'routeTemplate');
  const statusRaw = optionalString(query, 'statusCode');
  const eventRaw = optionalString(query, 'eventType');

  const domain: Omit<UserTrailQuery, 'cursor'> = {
    actorId,
    from,
    to,
    traceId: traceIdRaw ? parseTraceIdParam(traceIdRaw) : null,
    routeTemplate: routeRaw ? parseRouteTemplateParam(routeRaw) : null,
    statusCode: statusRaw ? parseStatusCodeParam(statusRaw) : null,
    eventType: eventRaw ? parseEventTypeParam(eventRaw) : null,
  };

  return {
    ...domain,
    cursor: attachTraceCursor('trail', hashTrailFilters(domain), optionalString(query, 'cursor')),
  };
}

export function parseTraceQuery(params: QueryRecord, query: QueryRecord): TraceQuery {
  const traceId = parseTraceIdParam(requiredString(params, 'traceId'));
  const fromRaw = optionalString(query, 'from');
  const toRaw = optionalString(query, 'to');
  if ((fromRaw && !toRaw) || (!fromRaw && toRaw)) invalid();
  const from = fromRaw ? parseIsoTimestamp(fromRaw) : null;
  const to = toRaw ? parseIsoTimestamp(toRaw) : null;
  if (from && to) assertRawRange(from, to);

  const domain: Omit<TraceQuery, 'cursor'> = { traceId, from, to };
  return {
    ...domain,
    cursor: attachTraceCursor('trace', hashTraceFilters(domain), optionalString(query, 'cursor')),
  };
}

export function parseSessionOverlayQuery(params: QueryRecord, query: QueryRecord): SessionOverlayQuery {
  const sessionId = parseUuid(requiredString(params, 'sessionId'), 'session');
  const from = parseIsoTimestamp(requiredString(query, 'from'));
  const to = parseIsoTimestamp(requiredString(query, 'to'));
  assertRawRange(from, to);
  const eventRaw = optionalString(query, 'eventType');

  const domain: Omit<SessionOverlayQuery, 'cursor'> = {
    sessionId,
    from,
    to,
    eventType: eventRaw ? parseEventTypeParam(eventRaw) : null,
  };
  return {
    ...domain,
    cursor: attachTraceCursor('session', hashSessionFilters(domain), optionalString(query, 'cursor')),
  };
}

export function observabilityNotFound(): never {
  throw new ObservabilityQueryError('OBSERVABILITY_NOT_FOUND', 'Not found', 404);
}

export class ObservabilityTimelineUnavailableError extends Error {
  constructor() {
    super('Session timeline unavailable');
    this.name = 'ObservabilityTimelineUnavailableError';
  }
}

export function hashSessionTimelineFilters(sessionId: string): string {
  return stableHash({ kind: 'session_timeline', sessionId });
}

function attachSessionTimelineCursor(
  filterHash: string,
  rawCursor: string | null,
): ObservabilityCursorState<SessionTimelineKeyset> | null {
  if (!rawCursor) return null;
  const decoded = decodeObservabilityCursor(rawCursor);
  if (decoded.kind !== 'session_timeline' || decoded.filterHash !== filterHash) invalidCursor();
  const last = decoded.last as SessionTimelineKeyset;
  if (typeof last.occurredAt !== 'string' || typeof last.id !== 'string') invalidCursor();
  if (last.sourceRank !== 0 && last.sourceRank !== 1) invalidCursor();
  if (!Number.isInteger(last.sequence) || last.sequence < 0) invalidCursor();
  return { emittedCount: decoded.emittedCount, last };
}

export function parseSessionTimelineQuery(params: QueryRecord, query: QueryRecord): SessionTimelineQuery {
  const sessionId = parseSessionTimelineId(requiredString(params, 'sessionId'));
  const limitRaw = optionalString(query, 'limit');
  if (limitRaw && limitRaw !== String(OBSERVABILITY_PAGE_SIZE)) invalid();
  return {
    sessionId,
    cursor: attachSessionTimelineCursor(
      hashSessionTimelineFilters(sessionId),
      optionalString(query, 'cursor'),
    ),
  };
}

export function encodeSessionTimelineCursor(
  filterHash: string,
  emittedCount: number,
  last: SessionTimelineKeyset,
): string {
  return encodeObservabilityCursor({
    version: OBSERVABILITY_CURSOR_VERSION,
    kind: 'session_timeline',
    filterHash,
    emittedCount,
    last,
  });
}

export function parseJourneyQuery(query: QueryRecord): JourneyQuery {
  const fromDay = parseDay(requiredString(query, 'fromDay'));
  const toDay = parseDay(requiredString(query, 'toDay'));
  if (fromDay > toDay) unsupportedRange();
  const fromRouteRaw = optionalString(query, 'fromRoute');
  const toRouteRaw = optionalString(query, 'toRoute');

  const domain: Omit<JourneyQuery, 'cursor'> = {
    fromDay,
    toDay,
    fromRoute: fromRouteRaw ? parseRouteTemplateParam(fromRouteRaw) : null,
    toRoute: toRouteRaw ? parseRouteTemplateParam(toRouteRaw) : null,
  };
  return {
    ...domain,
    cursor: attachJourneyCursor(hashJourneyFilters(domain), optionalString(query, 'cursor')),
  };
}

export function encodeTracePageCursor(
  kind: 'trail' | 'trace' | 'session',
  filterHash: string,
  emittedCount: number,
  last: TraceEventKeyset,
): string {
  return encodeObservabilityCursor({
    version: OBSERVABILITY_CURSOR_VERSION,
    kind,
    filterHash,
    emittedCount,
    last,
  });
}

export function encodeJourneyPageCursor(
  filterHash: string,
  emittedCount: number,
  last: JourneyKeyset,
): string {
  return encodeObservabilityCursor({
    version: OBSERVABILITY_CURSOR_VERSION,
    kind: 'journey',
    filterHash,
    emittedCount,
    last,
  });
}
