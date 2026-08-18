/**
 * Client-side Observability workspace filter validation (FEAT-006).
 * Mirrors FEAT-005 query contracts: actor UUID, 32-hex W3C trace ID, 30-day range.
 */
import {
  OBSERVABILITY_RAW_RETENTION_DAYS,
  W3C_TRACE_ID_PATTERN,
  type TraceEventType,
} from '../../shared/types/observability';

export const ACTOR_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TIME_RANGE_PRESETS = [
  '15m',
  '1h',
  '6h',
  '24h',
  '7d',
  'custom',
] as const;

export type TimeRangePreset = (typeof TIME_RANGE_PRESETS)[number];

export const TIME_RANGE_LABELS: Record<TimeRangePreset, string> = {
  '15m': 'Last 15 min',
  '1h': 'Last 1 hour',
  '6h': 'Last 6 hours',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  custom: 'Custom range',
};

const PRESET_MS: Record<Exclude<TimeRangePreset, 'custom'>, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

const MAX_RANGE_MS = OBSERVABILITY_RAW_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export type TrailEventFilter = 'all' | 'ui_action' | 'api_request' | 'error';

export interface WorkspaceFilterDraft {
  timeRange: TimeRangePreset;
  customFrom: string;
  customTo: string;
  actorId: string;
  traceId: string;
  eventType: TrailEventFilter;
}

export interface AppliedWorkspaceFilters {
  from: string;
  to: string;
  actorId: string;
  traceId: string | null;
  eventType: TraceEventType | null;
  routeTemplate?: string | null;
}

export interface FilterFieldErrors {
  actorId?: string;
  traceId?: string;
  timeRange?: string;
}

export function emptyFilterDraft(): WorkspaceFilterDraft {
  return {
    timeRange: '1h',
    customFrom: '',
    customTo: '',
    actorId: '',
    traceId: '',
    eventType: 'all',
  };
}

export function resolveTimeRange(
  draft: Pick<WorkspaceFilterDraft, 'timeRange' | 'customFrom' | 'customTo'>,
  nowMs = Date.now(),
): { from: string; to: string } | { error: string } {
  if (draft.timeRange === 'custom') {
    if (!draft.customFrom.trim() || !draft.customTo.trim()) {
      return { error: 'Custom range requires both start and end times' };
    }
    const fromMs = Date.parse(draft.customFrom);
    const toMs = Date.parse(draft.customTo);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
      return { error: 'Custom range must use valid timestamps' };
    }
    if (!(fromMs < toMs)) {
      return { error: 'Start time must be before end time' };
    }
    if (toMs - fromMs > MAX_RANGE_MS) {
      return { error: `Time range cannot exceed ${OBSERVABILITY_RAW_RETENTION_DAYS} days` };
    }
    return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
  }

  const span = PRESET_MS[draft.timeRange];
  return { from: new Date(nowMs - span).toISOString(), to: new Date(nowMs).toISOString() };
}

export function validateWorkspaceFilters(draft: WorkspaceFilterDraft, nowMs = Date.now()): {
  errors: FilterFieldErrors;
  applied: AppliedWorkspaceFilters | null;
} {
  const errors: FilterFieldErrors = {};
  const actorId = draft.actorId.trim();
  const traceId = draft.traceId.trim();

  if (!actorId) {
    errors.actorId = 'Actor is required — enter a user ID (UUID)';
  } else if (!ACTOR_UUID_PATTERN.test(actorId)) {
    errors.actorId = 'Invalid actor — must be a valid user ID (UUID)';
  }

  if (traceId && !W3C_TRACE_ID_PATTERN.test(traceId)) {
    errors.traceId = 'Malformed Trace ID — expected 32 hexadecimal characters';
  }

  const range = resolveTimeRange(draft, nowMs);
  if ('error' in range) {
    errors.timeRange = range.error;
  }

  if (Object.keys(errors).length > 0 || 'error' in range) {
    return { errors, applied: null };
  }

  return {
    errors: {},
    applied: {
      from: range.from,
      to: range.to,
      actorId: actorId.toLowerCase(),
      traceId: traceId || null,
      eventType: draft.eventType === 'all' ? null : draft.eventType,
    },
  };
}

export function formatStoreBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function retentionAgeMs(oldestRetainedEventAt: string | null, nowMs = Date.now()): number | null {
  if (!oldestRetainedEventAt) return null;
  const then = Date.parse(oldestRetainedEventAt);
  if (Number.isNaN(then)) return null;
  return Math.max(0, nowMs - then);
}

export function isRetentionBoundaryReached(oldestRetainedEventAt: string | null, nowMs = Date.now()): boolean {
  const age = retentionAgeMs(oldestRetainedEventAt, nowMs);
  if (age === null) return false;
  return age >= MAX_RANGE_MS;
}

export function isBufferAtCapacity(depth: number, capacity: number): boolean {
  return capacity > 0 && depth >= capacity;
}

export function describeEventType(eventType: string): string {
  if (eventType === 'ui_action') return 'UI Action';
  if (eventType === 'api_request') return 'API Call';
  if (eventType === 'error') return 'Error';
  if (eventType === 'agent_event') return 'Agent';
  return eventType;
}

export function formatTrailDescription(event: {
  eventType: string;
  routeTemplate: string | null;
  method: string | null;
  statusCode: number | null;
  durationMs: number | null;
  diagnosticSummary: string | null;
}): string {
  if (event.diagnosticSummary) return event.diagnosticSummary;
  const route = event.routeTemplate ?? 'unknown_route';
  if (event.eventType === 'api_request') {
    const method = event.method ?? 'GET';
    const status = event.statusCode != null ? String(event.statusCode) : '';
    const duration = event.durationMs != null ? `${event.durationMs}ms` : '';
    return [method, route, status, duration && `(${duration})`].filter(Boolean).join(' ');
  }
  if (event.eventType === 'ui_action') {
    return `Navigated to ${route}`;
  }
  return route;
}
