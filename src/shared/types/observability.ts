/**
 * Shared Observability contracts for Safe Trace Event Storage.
 * Candidate shapes are untrusted; only SafeTraceEventInput may be persisted.
 */
import type { AgentRunHealth } from './chat';

export const TRACE_EVENT_TYPES = ['api_request', 'error', 'ui_action', 'agent_event'] as const;
export type TraceEventType = (typeof TRACE_EVENT_TYPES)[number];

export const TRACE_HEADER_ALLOWLIST = [
  'content-type',
  'content-length',
  'user-agent',
  'x-request-id',
  'traceparent',
] as const;
export type AllowedTraceHeader = (typeof TRACE_HEADER_ALLOWLIST)[number];

/** Denied detail keys, compared case-insensitively after stripping `_` and `-`. */
export const TRACE_DENIED_DETAIL_KEYS = [
  'pat',
  'token',
  'secret',
  'password',
  'authorization',
  'cookie',
  'apikey',
  'connectionstring',
  'email',
] as const;

export const W3C_TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
export const HTTP_STATUS_MIN = 100;
export const HTTP_STATUS_MAX = 599;

export const TRACE_REDACTED_MARKER = '[REDACTED]';
export const TRACE_TRUNCATED_MARKER = '[TRUNCATED]';

export interface TraceEventCandidate {
  eventType: unknown;
  occurredAt?: unknown;
  actorUserId?: unknown;
  projectId?: unknown;
  traceId: unknown;
  sessionId?: unknown;
  routeTemplate?: unknown;
  httpMethod?: unknown;
  statusCode?: unknown;
  durationMs?: unknown;
  severity?: unknown;
  headers?: unknown;
  details?: unknown;
  error?: unknown;
}

export type JsonSafePrimitive = string | number | boolean | null;
export type JsonSafeValue = JsonSafePrimitive | JsonSafeValue[] | SafeTraceDetails;

export interface SafeTraceDetails {
  [key: string]: JsonSafeValue;
}

export interface SafeTraceEventInput {
  eventType: TraceEventType;
  occurredAt: string;
  actorUserId: string | null;
  projectId: string | null;
  traceId: string;
  sessionId: string | null;
  routeTemplate: string | null;
  httpMethod: string | null;
  statusCode: number | null;
  durationMs: number | null;
  severity: string | null;
  details: SafeTraceDetails;
}

export type TraceRedactionRuleId =
  | 'invalid_event_type'
  | 'invalid_trace_id'
  | 'invalid_occurred_at';

export class TraceRedactionError extends Error {
  readonly code = 'TRACE_REDACTION_FAILED';

  constructor(readonly ruleId: TraceRedactionRuleId) {
    super(ruleId);
    this.name = 'TraceRedactionError';
  }
}

/** Feature flag that gates all server and browser capture. */
export const OBSERVABILITY_CAPTURE_FLAG = 'observability-capture';

export const CAPTURE_BUFFER_CAPACITY = 10_000;
export const CAPTURE_FLUSH_BATCH_SIZE = 100;
export const CAPTURE_FLUSH_INTERVAL_MS = 2_000;
export const CAPTURE_FLAG_SNAPSHOT_MS = 5_000;
export const CAPTURE_SHUTDOWN_DRAIN_MS = 2_000;
export const CAPTURE_RETRY_DELAY_MS = 50;
/** Rolling window used for dropped/ingested events-per-second health rates. */
export const CAPTURE_HEALTH_RATE_WINDOW_MS = 60_000;

export const OBSERVABILITY_INGEST_PATH = '/api/observability/events';
export const UNKNOWN_ROUTE_TEMPLATE = 'unknown_route';

export const BROWSER_TRACE_EVENT_TYPES = ['route_view', 'client_error', 'unhandled_rejection'] as const;
export type BrowserTraceEventType = (typeof BROWSER_TRACE_EVENT_TYPES)[number];

export const INGEST_MAX_EVENTS = 10;
export const INGEST_MAX_BYTES = 5_120;
export const INGEST_RATE_LIMIT_PER_MINUTE = 12;
export const INGEST_CLOCK_SKEW_PAST_MS = 24 * 60 * 60 * 1000;
export const INGEST_CLOCK_SKEW_FUTURE_MS = 5 * 60 * 1000;
export const BROWSER_FLUSH_INTERVAL_MS = 5_000;
export const BROWSER_QUEUE_CAPACITY = 100;
export const BROWSER_BATCH_SIZE = 10;

export type CaptureDisposition = 'queued' | 'disabled' | 'excluded' | 'dropped';
export type CaptureTrigger = 'human' | 'poll';
export type CaptureSsePhase = 'open' | 'close';

export interface BrowserTraceEventBase {
  type: BrowserTraceEventType;
  occurredAt: string;
  traceId: string;
  spanId: string;
  routeTemplate: string;
  actor?: unknown;
}

export interface BrowserRouteViewEvent extends BrowserTraceEventBase {
  type: 'route_view';
}

export interface BrowserClientErrorEvent extends BrowserTraceEventBase {
  type: 'client_error';
  severity: 'error';
  details: {
    message: string;
    stack?: string;
  };
}

export interface BrowserUnhandledRejectionEvent extends BrowserTraceEventBase {
  type: 'unhandled_rejection';
  severity: 'error';
  details: {
    message: string;
    stack?: string;
  };
}

export type BrowserTraceEventCandidate =
  | BrowserRouteViewEvent
  | BrowserClientErrorEvent
  | BrowserUnhandledRejectionEvent;

export interface BrowserIngestBatchRequest {
  project: string;
  events: BrowserTraceEventCandidate[];
}

export interface BrowserIngestAcceptedResponse {
  accepted: number;
}

export interface BrowserIngestRejectedResponse {
  error: string;
  code: string;
}

export interface ServerTraceCandidate {
  eventType: 'api_request' | 'error' | 'ui_action';
  occurredAt: string;
  actorUserId: string;
  projectId?: string;
  sessionId?: string;
  traceId: string;
  routeTemplate: string;
  httpMethod?: string;
  statusCode?: number;
  durationMs?: number;
  severity?: 'info' | 'warning' | 'error';
  trigger?: CaptureTrigger;
  ssePhase?: CaptureSsePhase;
  details?: unknown;
  headers?: unknown;
  error?: unknown;
}

export interface CaptureFlushError {
  occurredAt: string;
  message: string;
}

export interface CaptureHealthSnapshot {
  bufferDepth: number;
  bufferCapacity: typeof CAPTURE_BUFFER_CAPACITY;
  droppedEvents: number;
  droppedEventsPerSecond: number;
  flushErrorCount: number;
  lastFlushError: CaptureFlushError | null;
  acceptedEvents: number;
  persistedEvents: number;
  ingestedEventsPerSecond: number;
}

export type CaptureHealthPipelineScope = 'instance';
export type CaptureHealthStoreScope = 'database';

/** Payload-free Super Admin Capture Health contract (TBI-006 / FEAT-004). */
export interface CaptureHealthResponse {
  capturedAt: string;
  instanceId: string;
  captureEnabled: boolean;
  pipeline: {
    scope: CaptureHealthPipelineScope;
    droppedEvents: number;
    droppedEventsPerSecond: number;
    bufferDepth: number;
    bufferCapacity: typeof CAPTURE_BUFFER_CAPACITY;
    flushErrorCount: number;
    latestFlushError: CaptureFlushError | null;
    ingestedEventsPerSecond: number;
  };
  store: {
    scope: CaptureHealthStoreScope;
    approximateStoreBytes: number;
    oldestRetainedEventAt: string | null;
  };
}

/** Feature flag that gates Super Admin Observability query routes. */
export const OBSERVABILITY_VIEWER_FLAG = 'observability-viewer';

export const OBSERVABILITY_PAGE_SIZE = 50;
export const OBSERVABILITY_MAX_ROWS = 500;
export const OBSERVABILITY_RAW_RETENTION_DAYS = 30;
export const OBSERVABILITY_CURSOR_VERSION = 1;

export type ObservabilityQueryKind = 'trail' | 'trace' | 'session' | 'journey' | 'session_timeline';

export type ObservabilityErrorCode =
  | 'OBSERVABILITY_INVALID_QUERY'
  | 'OBSERVABILITY_UNSUPPORTED_RANGE'
  | 'OBSERVABILITY_INVALID_CURSOR'
  | 'OBSERVABILITY_NOT_FOUND';

export interface ObservabilityErrorResponse {
  error: string;
  code: ObservabilityErrorCode;
}

export interface TraceEventView {
  id: string;
  eventType: TraceEventType;
  occurredAt: string;
  actorId: string | null;
  projectId: string | null;
  traceId: string;
  sessionId: string | null;
  routeTemplate: string | null;
  method: string | null;
  statusCode: number | null;
  durationMs: number | null;
  severity: string | null;
  trigger: CaptureTrigger | null;
  diagnosticSummary: string | null;
}

export interface PageEnvelope<T> {
  items: T[];
  nextCursor: string | null;
  capReached: boolean;
}

export type TraceEventPage = PageEnvelope<TraceEventView>;

export interface SessionOverlayPage {
  sessionId: string;
  events: TraceEventView[];
  nextCursor: string | null;
  capReached: boolean;
}

export interface JourneyEdgeView {
  day: string;
  fromRoute: string;
  toRoute: string;
  transitionCount: number;
  distinctActorCount: number;
}

export type JourneyEdgePage = PageEnvelope<JourneyEdgeView>;

export interface TraceEventKeyset {
  occurredAt: string;
  id: string;
}

export interface JourneyKeyset {
  day: string;
  fromRoute: string;
  toRoute: string;
}

export interface ObservabilityCursorState<TKeyset> {
  emittedCount: number;
  last: TKeyset;
}

export interface UserTrailQuery {
  actorId: string;
  from: string;
  to: string;
  traceId: string | null;
  routeTemplate: string | null;
  statusCode: number | null;
  eventType: TraceEventType | null;
  cursor: ObservabilityCursorState<TraceEventKeyset> | null;
}

export interface TraceQuery {
  traceId: string;
  from: string | null;
  to: string | null;
  cursor: ObservabilityCursorState<TraceEventKeyset> | null;
}

export interface SessionOverlayQuery {
  sessionId: string;
  from: string;
  to: string;
  eventType: TraceEventType | null;
  cursor: ObservabilityCursorState<TraceEventKeyset> | null;
}

export interface JourneyQuery {
  fromDay: string;
  toDay: string;
  fromRoute: string | null;
  toRoute: string | null;
  cursor: ObservabilityCursorState<JourneyKeyset> | null;
}

/** FEAT-007 Session Timeline — merged canonical lifecycle + Trace Event overlay. */
export const SESSION_TIMELINE_SOURCE_RANK = {
  agent: 0,
  trace: 1,
} as const;

export type SessionTimelineSource = keyof typeof SESSION_TIMELINE_SOURCE_RANK;
export type SessionTimelineSourceState = 'complete' | 'empty' | 'failed';
export type SessionTimelineEntryStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'info';

export interface SessionTimelineKeyset {
  occurredAt: string;
  sourceRank: 0 | 1;
  sequence: number;
  id: string;
}

export interface SessionTimelineQuery {
  sessionId: string;
  cursor: ObservabilityCursorState<SessionTimelineKeyset> | null;
}

export interface SessionTimelineEntryBase {
  id: string;
  source: SessionTimelineSource;
  occurredAt: string;
  title: string;
  status: SessionTimelineEntryStatus;
  safeDetail?: string;
  details: Array<{ label: string; value: string }>;
}

export interface AgentTimelineEntry extends SessionTimelineEntryBase {
  source: 'agent';
  runId: string;
  eventType: string;
  phase?: string;
  sequence: number;
  toolName?: string;
  durationMs?: number;
}

export interface TraceTimelineEntry extends SessionTimelineEntryBase {
  source: 'trace';
  eventType: 'api_request' | 'error' | 'ui_action';
  traceId: string;
  routeTemplate?: string;
  method?: string;
  statusCode?: number;
  durationMs?: number;
  severity?: string;
}

export type SessionTimelineEntry = AgentTimelineEntry | TraceTimelineEntry;

export interface SessionTimelineVerdict {
  health: AgentRunHealth | null;
  label: string;
  detail: string;
  hangPointEventId: string | null;
  assessedAt: string;
}

export interface SessionTimelineSourceStatus {
  state: SessionTimelineSourceState;
  message?: string;
}

export interface SessionTimelineResponse {
  session: {
    sessionId: string;
    interviewId?: string;
    runIds: string[];
    startedAt?: string;
    completedAt?: string;
  };
  verdict: SessionTimelineVerdict;
  sourceStatus: Record<SessionTimelineSource, SessionTimelineSourceStatus>;
  entries: SessionTimelineEntry[];
  page: {
    nextCursor: string | null;
    returned: number;
    loaded: number;
    cap: typeof OBSERVABILITY_MAX_ROWS;
    capReached: boolean;
  };
  partial: boolean;
}

/** FEAT-009 Interactive Journey Map — graph view over FEAT-005 paginated rollup edges. */
export const JOURNEY_MIN_TRANSITIONS = [1, 10, 50, 100] as const;
export type JourneyMinTransitions = (typeof JOURNEY_MIN_TRANSITIONS)[number];
export const JOURNEY_DEFAULT_MIN_TRANSITIONS: JourneyMinTransitions = 1;
export const JOURNEY_CANVAS_EDGE_LIMIT = 100;
export const JOURNEY_TABLE_PAGE_SIZE = OBSERVABILITY_PAGE_SIZE;

export interface JourneyNode {
  routeTemplate: string;
  transitionCount: number;
  distinctActorCount: number;
}

export interface JourneyEdge {
  fromRoute: string;
  toRoute: string;
  transitionCount: number;
  distinctActorCount: number;
  lastSeen: string;
}

export interface JourneyMapRange {
  from: string;
  to: string;
}

export interface JourneyMapResponse {
  generatedAt: string;
  rollupThrough: string;
  availableFrom: string;
  availableTo: string;
  range: JourneyMapRange;
  machineTransitionsExcluded: true;
  truncated: boolean;
  nodes: JourneyNode[];
  edges: JourneyEdge[];
}

export interface JourneyMapFilters {
  from: string;
  to: string;
  minTransitions: JourneyMinTransitions;
}

export interface JourneyTrailHandoff {
  fromRoute: string;
  toRoute: string;
  from: string;
  to: string;
}

export type JourneyDatePreset = '7d' | '30d' | 'custom';
