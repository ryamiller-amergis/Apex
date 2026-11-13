/**
 * Shared Observability contracts for Safe Trace Event Storage.
 * Candidate shapes are untrusted; only SafeTraceEventInput may be persisted.
 */
import type { AgentRunHealth } from './chat';
import type { EffortLevel } from './effort';

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

/** Product Owner Observability Digest — skill-driven multi-window telemetry synthesis. */
export const OBSERVABILITY_PO_SKILL_PATH = '.cursor/skills/observability-po-digest/SKILL.md';
export const OBSERVABILITY_PO_DEFAULT_MODEL = 'composer-2.5';
export const OBSERVABILITY_PO_DEFAULT_EFFORT: EffortLevel = 'medium';
export const OBSERVABILITY_PO_SCHEDULE_HOURS = [6, 18] as const;

export const OBSERVABILITY_TREND_WINDOWS = [
  'today',
  '1d',
  '7d',
  '14d',
  '30d',
  '60d',
] as const;

export type ObservabilityTrendWindow = (typeof OBSERVABILITY_TREND_WINDOWS)[number];

export const OBSERVABILITY_TREND_WINDOW_LABELS: Record<ObservabilityTrendWindow, string> = {
  today: 'Today',
  '1d': 'Last day',
  '7d': 'Last 7 days',
  '14d': 'Last 14 days',
  '30d': 'Last 30 days',
  '60d': 'Last 60 days',
};

export type ObservabilityDigestSlot = 'morning_6am' | 'evening_6pm' | 'on_demand';
export type ObservabilityTrendDirection = 'up' | 'down' | 'flat';

export type ObservabilityWindowComparisonMap = Record<ObservabilityTrendWindow, number>;

export interface ObservabilityTopUserItem {
  userId: string;
  displayName: string;
  role: string;
  interactions: number;
  sessions: number;
  modulesUsed: number;
  topModule: string;
  deltaPct: number;
  trend: ObservabilityTrendDirection;
  windowComparison: ObservabilityWindowComparisonMap;
}

export interface ObservabilityExceptionItem {
  id: string;
  signature: string;
  module: string;
  routeTemplate: string;
  statusCode: number;
  count: number;
  affectedUsers: number;
  deltaPct: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  windowComparison: ObservabilityWindowComparisonMap;
}

export interface ObservabilityModuleRetentionDropItem {
  module: string;
  routeTemplate: string;
  previousRetentionPct: number;
  currentRetentionPct: number;
  dropPct: number;
  returningUsers: number;
  lostUsers: number;
  primaryFriction: string;
  windowComparison: ObservabilityWindowComparisonMap;
}

export interface ObservabilityDropReasonFinding {
  id: string;
  module: string;
  title: string;
  detail: string;
  evidence: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface ObservabilityDropReasonsSummary {
  headline: string;
  narrative: string;
  findings: ObservabilityDropReasonFinding[];
}

export interface ObservabilityTopModuleItem {
  module: string;
  routeTemplate: string;
  activeUsers: number;
  interactions: number;
  sharePct: number;
  retentionPct: number;
  deltaPct: number;
  trend: ObservabilityTrendDirection;
  windowComparison: ObservabilityWindowComparisonMap;
}

export interface ObservabilityAdoptionPlay {
  id: string;
  module: string;
  title: string;
  action: string;
  expectedLift: string;
  impact: 'high' | 'medium' | 'low';
}

export interface ObservabilityAdoptionSummary {
  headline: string;
  narrative: string;
  recommendations: ObservabilityAdoptionPlay[];
}

export type ObservabilityDynamicSectionTone = 'default' | 'accent' | 'warning' | 'danger';
export type ObservabilityDynamicSectionDisplayType =
  | 'insights'
  | 'table'
  | 'ranked_list'
  | 'metrics'
  | 'markdown'
  | 'tracker';

/** Section id of the skill's suggestion tracker (`suggestionTracker` in SKILL.md). */
export const OBSERVABILITY_SUGGESTION_TRACKER_SECTION_ID = 'suggestiontracker';

export const OBSERVABILITY_SUGGESTION_CATEGORIES = [
  'enhance',
  'consolidate',
  'new_module',
] as const;
export type ObservabilitySuggestionCategory =
  (typeof OBSERVABILITY_SUGGESTION_CATEGORIES)[number];

export const OBSERVABILITY_SUGGESTION_CATEGORY_LABELS: Record<
  ObservabilitySuggestionCategory,
  string
> = {
  enhance: 'Enhance module',
  consolidate: 'Consolidate / retire',
  new_module: 'New module idea',
};

export const OBSERVABILITY_SUGGESTION_STAGES = [
  'proposed',
  'planned',
  'in_progress',
  'shipped',
  'measured',
  'dropped',
] as const;
export type ObservabilitySuggestionStage = (typeof OBSERVABILITY_SUGGESTION_STAGES)[number];

export const OBSERVABILITY_SUGGESTION_STAGE_LABELS: Record<
  ObservabilitySuggestionStage,
  string
> = {
  proposed: 'Proposed',
  planned: 'Planned',
  in_progress: 'In progress',
  shipped: 'Shipped',
  measured: 'Impact measured',
  dropped: 'Dropped',
};

/** Default progress for each stage when the skill does not return `progressPct`. */
export const OBSERVABILITY_SUGGESTION_STAGE_PROGRESS: Record<
  ObservabilitySuggestionStage,
  number
> = {
  proposed: 10,
  planned: 30,
  in_progress: 55,
  shipped: 80,
  measured: 100,
  dropped: 0,
};

export interface ObservabilityDynamicSkillSectionItem {
  id?: string;
  title: string;
  subtitle?: string;
  detail?: string;
  meta?: string;
  badge?: string;
  metricLabel?: string;
  metricValue?: string | number;
  deltaPct?: number;
  windowComparison?: ObservabilityWindowComparisonMap;
  /** Suggestion tracker fields (`displayType: tracker`). */
  module?: string;
  category?: ObservabilitySuggestionCategory;
  stage?: ObservabilitySuggestionStage;
  progressPct?: number;
  firstSuggestedAt?: string;
  lastUpdatedAt?: string;
}

export interface ObservabilityDynamicSkillSection {
  id: string;
  number?: number;
  title: string;
  subtitle?: string;
  badge?: string;
  tone?: ObservabilityDynamicSectionTone;
  displayType?: ObservabilityDynamicSectionDisplayType;
  headline?: string;
  narrative?: string;
  items?: ObservabilityDynamicSkillSectionItem[];
}

export interface ObservabilityScheduleSlotStatus {
  slot: 'morning_6am' | 'evening_6pm';
  label: string;
  scheduledTimeLabel: string;
  lastRunAt: string | null;
  nextRunAt: string;
  model: string;
  effort: EffortLevel;
  status: 'ready' | 'scheduled';
}

export interface ObservabilityScheduleSummary {
  cadenceLabel: string;
  timezone: string;
  skillPath: string;
  configuredModel: string;
  configuredEffort: EffortLevel;
  morningSlot: ObservabilityScheduleSlotStatus;
  eveningSlot: ObservabilityScheduleSlotStatus;
}

export interface ObservabilityPoDigestSnapshot {
  id: string;
  project: string;
  window: ObservabilityTrendWindow;
  windowLabel: string;
  baselineLabel: string;
  slot: ObservabilityDigestSlot;
  skillPath: string;
  model: string;
  effort: EffortLevel;
  generatedAt: string;
  headline: string;
  kpis: {
    activeUsers: number;
    activeUsersDeltaPct: number;
    totalExceptions: number;
    exceptionsDeltaPct: number;
    avgModuleRetentionPct: number;
    retentionDeltaPct: number;
    topModuleName: string;
    topModuleSharePct: number;
  };
  topUsers: ObservabilityTopUserItem[];
  commonExceptions: ObservabilityExceptionItem[];
  moduleRetentionDrops: ObservabilityModuleRetentionDropItem[];
  dropReasonsSummary: ObservabilityDropReasonsSummary;
  topModules: ObservabilityTopModuleItem[];
  adoptionRecommendations: ObservabilityAdoptionSummary;
  customSections?: ObservabilityDynamicSkillSection[];
  sections?: ObservabilityDynamicSkillSection[];
}

export interface ObservabilityPoDigestResponse {
  digest: ObservabilityPoDigestSnapshot;
  schedule: ObservabilityScheduleSummary;
  history: Array<{
    id: string;
    slot: ObservabilityDigestSlot;
    window: ObservabilityTrendWindow;
    model: string;
    effort: EffortLevel;
    generatedAt: string;
    headline: string;
  }>;
}

export interface GenerateObservabilityPoDigestRequest {
  project?: string;
  window?: ObservabilityTrendWindow;
  model?: string;
  effort?: EffortLevel;
  slot?: ObservabilityDigestSlot;
}

