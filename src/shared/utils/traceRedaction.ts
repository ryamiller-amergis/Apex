/**
 * Mandatory Observability redaction boundary.
 * Pure and platform-neutral: future browser and server callers share these rules.
 */
import {
  HTTP_STATUS_MAX,
  HTTP_STATUS_MIN,
  TRACE_DENIED_DETAIL_KEYS,
  TRACE_EVENT_TYPES,
  TRACE_HEADER_ALLOWLIST,
  TRACE_REDACTED_MARKER,
  TRACE_TRUNCATED_MARKER,
  TraceRedactionError,
  W3C_TRACE_ID_PATTERN,
  type JsonSafeValue,
  type SafeTraceDetails,
  type SafeTraceEventInput,
  type TraceEventCandidate,
  type TraceEventType,
} from '../types/observability';

export const MAX_REDACTION_DEPTH = 8;
export const MAX_ARRAY_ITEMS = 50;
export const MAX_OBJECT_KEYS = 50;
export const MAX_STRING_LENGTH = 2048;
export const MAX_STACK_LINES = 20;
export const MAX_OUTPUT_CHARS = 8192;

const HEADER_ALLOWLIST = new Set<string>(TRACE_HEADER_ALLOWLIST);
const DENIED_KEYS = new Set<string>(TRACE_DENIED_DETAIL_KEYS);
const BODY_KEYS = new Set([
  'body',
  'requestbody',
  'responsebody',
]);
const EVENT_TYPE_SET = new Set<string>(TRACE_EVENT_TYPES);
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_SEGMENT = /^\d+$/;

const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+=/]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+/g;
const PAT_RE = /(?:^|[^A-Za-z0-9])([a-z0-9]{52})(?![A-Za-z0-9])/g;
const API_KEY_ASSIGN_RE = /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?[^\s'"]+/gi;
const CONNECTION_URI_RE =
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|mssql|sqlserver|redis):\/\/[^\s]+/gi;
const CONNECTION_ASSIGN_RE =
  /(?:AccountKey|SharedAccessKey|SharedAccessSignature|Password|Pwd)\s*=\s*[^;\s]+/gi;

function normalizeDeniedKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

function isDeniedKey(key: string): boolean {
  const normalized = normalizeDeniedKey(key);
  if (DENIED_KEYS.has(normalized)) return true;
  for (const denied of DENIED_KEYS) {
    if (normalized.includes(denied)) return true;
  }
  return false;
}

function isBodyKey(key: string): boolean {
  return BODY_KEYS.has(normalizeDeniedKey(key));
}

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH)}${TRACE_TRUNCATED_MARKER}`;
}

function scrubSecretPatterns(value: string): string {
  let next = value.replace(BEARER_RE, `Bearer ${TRACE_REDACTED_MARKER}`);
  next = next.replace(JWT_RE, TRACE_REDACTED_MARKER);
  next = next.replace(PAT_RE, (match, pat: string) => match.replace(pat, TRACE_REDACTED_MARKER));
  next = next.replace(API_KEY_ASSIGN_RE, (match) => {
    const separator = match.includes('=') ? '=' : ':';
    const prefix = match.slice(0, match.indexOf(separator) + 1);
    return `${prefix}${TRACE_REDACTED_MARKER}`;
  });
  next = next.replace(CONNECTION_URI_RE, TRACE_REDACTED_MARKER);
  next = next.replace(CONNECTION_ASSIGN_RE, (match) => {
    const eq = match.indexOf('=');
    return `${match.slice(0, eq + 1)}${TRACE_REDACTED_MARKER}`;
  });
  return next;
}

function scrubString(value: string): string {
  return truncateString(scrubSecretPatterns(value));
}

/** Length-bounded secret scrubbing for safe timeline display text. */
export function scrubSafeDisplayText(value: string, maxLength = 500): string {
  const scrubbed = scrubString(value);
  if (scrubbed.length <= maxLength) return scrubbed;
  return `${scrubbed.slice(0, maxLength)}${TRACE_TRUNCATED_MARKER}`;
}

function filterHeaders(headers: unknown): SafeTraceDetails | undefined {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return undefined;
  const allowed: SafeTraceDetails = {};
  for (const [rawName, rawValue] of Object.entries(headers as Record<string, unknown>)) {
    const name = rawName.toLowerCase();
    if (!HEADER_ALLOWLIST.has(name)) continue;
    if (typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      allowed[name] = typeof rawValue === 'string' ? scrubString(rawValue) : rawValue;
    }
  }
  return Object.keys(allowed).length > 0 ? allowed : undefined;
}

function isErrorLike(value: unknown): value is { message?: unknown; stack?: unknown } {
  return (
    value instanceof Error ||
    (typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      ('message' in value || 'stack' in value))
  );
}

function projectError(value: unknown): SafeTraceDetails {
  const source = isErrorLike(value) ? value : { message: String(value) };
  const message = scrubString(typeof source.message === 'string' ? source.message : 'Error');
  const stackLines =
    typeof source.stack === 'string'
      ? source.stack.split('\n').slice(0, MAX_STACK_LINES).map(scrubString)
      : [];
  const projected: SafeTraceDetails = { message };
  if (stackLines.length > 0) {
    projected.stack = stackLines.join('\n');
  }
  return projected;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): JsonSafeValue {
  if (value === null) return null;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return TRACE_TRUNCATED_MARKER;
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return TRACE_TRUNCATED_MARKER;
  }
  if (depth >= MAX_REDACTION_DEPTH) return TRACE_TRUNCATED_MARKER;
  if (typeof value !== 'object') return TRACE_TRUNCATED_MARKER;

  if (seen.has(value)) return TRACE_TRUNCATED_MARKER;
  seen.add(value);

  if (isErrorLike(value) && !Array.isArray(value)) {
    return projectError(value);
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) items.push(TRACE_TRUNCATED_MARKER);
    return items;
  }

  const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
  const result: SafeTraceDetails = {};
  for (const [key, nested] of entries) {
    if (isBodyKey(key)) continue;
    if (isDeniedKey(key)) {
      result[key] = TRACE_REDACTED_MARKER;
      continue;
    }
    if (key.toLowerCase() === 'headers') {
      const headers = filterHeaders(nested);
      if (headers) result[key] = headers;
      continue;
    }
    if (key.toLowerCase() === 'error' || key.toLowerCase() === 'err') {
      result[key] = projectError(nested);
      continue;
    }
    result[key] = redactValue(nested, depth + 1, seen);
  }
  if (Object.keys(value as Record<string, unknown>).length > MAX_OBJECT_KEYS) {
    result._truncated = TRACE_TRUNCATED_MARKER;
  }
  return result;
}

function boundOutput(details: SafeTraceDetails): SafeTraceDetails {
  const encoded = JSON.stringify(details);
  if (encoded.length <= MAX_OUTPUT_CHARS) return details;
  return {
    _truncated: TRACE_TRUNCATED_MARKER,
    preview: truncateString(encoded.slice(0, MAX_OUTPUT_CHARS)),
  };
}

export function redactTraceDetails(details: unknown): SafeTraceDetails {
  if (details === null || details === undefined) return {};
  if (typeof details !== 'object' || Array.isArray(details)) {
    return boundOutput({ value: redactValue(details, 0, new WeakSet()) });
  }
  const redacted = redactValue(details, 0, new WeakSet());
  if (!redacted || typeof redacted !== 'object' || Array.isArray(redacted)) {
    return boundOutput({ value: redacted });
  }
  return boundOutput(redacted);
}

function asNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTraceId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TraceRedactionError('invalid_trace_id');
  }
  const normalized = value.trim().toLowerCase();
  if (!W3C_TRACE_ID_PATTERN.test(normalized)) {
    throw new TraceRedactionError('invalid_trace_id');
  }
  return normalized;
}

function normalizeEventType(value: unknown): TraceEventType {
  if (typeof value !== 'string' || !EVENT_TYPE_SET.has(value)) {
    throw new TraceRedactionError('invalid_event_type');
  }
  return value as TraceEventType;
}

function normalizeOccurredAt(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  throw new TraceRedactionError('invalid_occurred_at');
}

export function normalizeRouteTemplate(value: unknown): string | null {
  const raw = asNullableString(value);
  if (!raw) return null;
  const withoutQuery = raw.split(/[?#]/, 1)[0] ?? raw;
  const path = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
  const segments = path.split('/').map((segment) => {
    if (!segment) return segment;
    if (UUID_SEGMENT.test(segment) || NUMERIC_SEGMENT.test(segment)) return ':id';
    return segment;
  });
  const normalized = segments.join('/');
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function normalizeHttpMethod(value: unknown): string | null {
  const method = asNullableString(value);
  if (!method) return null;
  return method.toUpperCase();
}

function normalizeStatusCode(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < HTTP_STATUS_MIN || value > HTTP_STATUS_MAX) return null;
  return value;
}

function normalizeDurationMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function mergeCandidateDetails(candidate: TraceEventCandidate): unknown {
  const base =
    candidate.details && typeof candidate.details === 'object' && !Array.isArray(candidate.details)
      ? { ...(candidate.details as Record<string, unknown>) }
      : candidate.details !== undefined
        ? { value: candidate.details }
        : {};
  const record = base as Record<string, unknown>;
  if (candidate.headers !== undefined && record.headers === undefined) {
    record.headers = candidate.headers;
  }
  if (candidate.error !== undefined && record.error === undefined) {
    record.error = candidate.error;
  }
  return record;
}

export function toSafeTraceEvent(candidate: TraceEventCandidate): SafeTraceEventInput {
  const eventType = normalizeEventType(candidate.eventType);
  const traceId = normalizeTraceId(candidate.traceId);
  const occurredAt = normalizeOccurredAt(candidate.occurredAt ?? new Date().toISOString());
  const details = redactTraceDetails(mergeCandidateDetails(candidate));

  return {
    eventType,
    occurredAt,
    actorUserId: asNullableString(candidate.actorUserId),
    projectId: asNullableString(candidate.projectId),
    traceId,
    sessionId: asNullableString(candidate.sessionId),
    routeTemplate: normalizeRouteTemplate(candidate.routeTemplate),
    httpMethod: normalizeHttpMethod(candidate.httpMethod),
    statusCode: normalizeStatusCode(candidate.statusCode),
    durationMs: normalizeDurationMs(candidate.durationMs),
    severity: asNullableString(candidate.severity),
    details,
  };
}
