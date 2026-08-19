/**
 * Authenticated browser ingest: whole-batch validation, server-derived actor,
 * route normalization, re-redaction, and capture delegation.
 */
import {
  BROWSER_TRACE_EVENT_TYPES,
  INGEST_CLOCK_SKEW_FUTURE_MS,
  INGEST_CLOCK_SKEW_PAST_MS,
  INGEST_MAX_BYTES,
  INGEST_MAX_EVENTS,
  INGEST_RATE_LIMIT_PER_MINUTE,
  OBSERVABILITY_CAPTURE_FLAG,
  UNKNOWN_ROUTE_TEMPLATE,
  type BrowserTraceEventCandidate,
  type BrowserTraceEventType,
  type CaptureDisposition,
  type ServerTraceCandidate,
} from '../../shared/types/observability';
import { isValidSpanId, isValidTraceId } from '../../shared/utils/w3cTrace';
import { normalizeApexRouteTemplate } from '../../shared/utils/observabilityRouteRegistry';
import { isFeatureEnabled } from './featureFlagService';
import { getObservabilityCaptureService } from './observabilityCaptureService';
import { trackEvent } from './telemetry';
import { db } from '../db/drizzle';
import { userProjectAssignments } from '../db/schema';
import { and, eq } from 'drizzle-orm';

export type IngestRejectCode =
  | 'PAYLOAD_TOO_LARGE'
  | 'INVALID_SCHEMA'
  | 'INVALID_EVENT_COUNT'
  | 'INVALID_PROJECT'
  | 'FLAG_DISABLED'
  | 'RATE_LIMITED';

export type IngestResult =
  | { ok: true; accepted: number }
  | { ok: false; status: 400 | 404 | 429; error: string; code: IngestRejectCode; retryAfterSec?: number };

export interface IngestBrowserBatchInput {
  actorUserId: string;
  rawBodyBytes: number;
  body: unknown;
  isSuperAdmin?: boolean;
}

export interface ObservabilityIngestServiceDeps {
  capture?: (candidate: ServerTraceCandidate) => CaptureDisposition;
  isCaptureEnabled?: (userId: string, project: string) => Promise<boolean>;
  hasProjectAccess?: (userId: string, project: string) => Promise<boolean>;
  now?: () => number;
  emitMetric?: (name: string, measurements?: Record<string, number>) => void;
}

const RATE_WINDOW_MS = 60_000;
const BROWSER_TYPE_SET = new Set<string>(BROWSER_TRACE_EVENT_TYPES);

function emitSafeMetric(
  emitMetric: (name: string, measurements?: Record<string, number>) => void,
  name: string,
  measurements?: Record<string, number>,
): void {
  try {
    emitMetric(name, measurements);
  } catch {
    // Metrics must never affect ingest.
  }
}

async function defaultHasProjectAccess(userId: string, project: string): Promise<boolean> {
  const rows = await db
    .select({ userId: userProjectAssignments.userId })
    .from(userProjectAssignments)
    .where(and(eq(userProjectAssignments.userId, userId), eq(userProjectAssignments.project, project)))
    .limit(1);
  return rows.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTimestampInWindow(value: unknown, nowMs: number): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const delta = parsed.getTime() - nowMs;
  return delta >= -INGEST_CLOCK_SKEW_PAST_MS && delta <= INGEST_CLOCK_SKEW_FUTURE_MS;
}

function isBrowserEventType(value: unknown): value is BrowserTraceEventType {
  return typeof value === 'string' && BROWSER_TYPE_SET.has(value);
}

function validateEvent(event: unknown, nowMs: number): event is BrowserTraceEventCandidate {
  if (!isRecord(event) || !isBrowserEventType(event.type)) return false;
  if (!isTimestampInWindow(event.occurredAt, nowMs)) return false;
  if (!isValidTraceId(event.traceId) || !isValidSpanId(event.spanId)) return false;
  if (typeof event.routeTemplate !== 'string' || !event.routeTemplate.trim()) return false;
  if (event.type === 'route_view') return true;
  if (event.severity !== 'error') return false;
  if (!isRecord(event.details) || typeof event.details.message !== 'string') return false;
  if (event.details.stack !== undefined && typeof event.details.stack !== 'string') return false;
  return true;
}

function toServerCandidate(
  event: BrowserTraceEventCandidate,
  actorUserId: string,
  projectId: string,
): ServerTraceCandidate {
  const routeTemplate = normalizeApexRouteTemplate(event.routeTemplate);
  const common = {
    occurredAt: event.occurredAt,
    actorUserId,
    projectId,
    traceId: event.traceId,
    routeTemplate,
    details: {
      browserEventType: event.type,
      spanId: event.spanId,
    },
  };
  if (event.type === 'route_view') {
    return {
      ...common,
      eventType: 'ui_action',
      severity: 'info',
    };
  }
  return {
    ...common,
    eventType: 'error',
    severity: 'error',
    error: {
      message: event.details.message,
      stack: event.details.stack,
    },
    details: {
      ...common.details,
    },
  };
}

export function createObservabilityIngestService(deps: ObservabilityIngestServiceDeps = {}) {
  const capture = deps.capture ?? ((candidate) => getObservabilityCaptureService().capture(candidate));
  const isCaptureEnabled =
    deps.isCaptureEnabled ??
    ((userId: string, project: string) => isFeatureEnabled(OBSERVABILITY_CAPTURE_FLAG, { userId, project }));
  const hasProjectAccess = deps.hasProjectAccess ?? defaultHasProjectAccess;
  const now = deps.now ?? Date.now;
  const emitMetric = deps.emitMetric ?? ((name, measurements) => trackEvent(name, undefined, measurements));

  const actorWindows = new Map<string, number[]>();

  function prune(actorUserId: string, nowMs: number): number[] {
    const next = (actorWindows.get(actorUserId) ?? []).filter((stamp) => nowMs - stamp < RATE_WINDOW_MS);
    actorWindows.set(actorUserId, next);
    return next;
  }

  function rateLimit(actorUserId: string, nowMs: number): { allowed: boolean; retryAfterSec: number } {
    const stamps = prune(actorUserId, nowMs);
    if (stamps.length >= INGEST_RATE_LIMIT_PER_MINUTE) {
      const oldest = stamps[0] ?? nowMs;
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - nowMs) / 1000)) };
    }
    stamps.push(nowMs);
    actorWindows.set(actorUserId, stamps);
    return { allowed: true, retryAfterSec: 0 };
  }

  async function ingest(input: IngestBrowserBatchInput): Promise<IngestResult> {
    const nowMs = now();
    const encodedBytes = input.rawBodyBytes;

    if (!Number.isFinite(encodedBytes) || encodedBytes > INGEST_MAX_BYTES) {
      emitSafeMetric(emitMetric, 'observability.browser_batch.rejected_size', { bytes: encodedBytes, count: 0 });
      return { ok: false, status: 400, error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' };
    }

    if (!isRecord(input.body) || typeof input.body.project !== 'string' || !input.body.project.trim()) {
      emitSafeMetric(emitMetric, 'observability.browser_batch.rejected_schema', { bytes: encodedBytes, count: 0 });
      return { ok: false, status: 400, error: 'Invalid project context', code: 'INVALID_PROJECT' };
    }

    const project = input.body.project.trim();
    if (!Array.isArray(input.body.events)) {
      emitSafeMetric(emitMetric, 'observability.browser_batch.rejected_schema', { bytes: encodedBytes, count: 0 });
      return { ok: false, status: 400, error: 'Invalid batch schema', code: 'INVALID_SCHEMA' };
    }

    const events = input.body.events;
    if (events.length < 1 || events.length > INGEST_MAX_EVENTS) {
      emitSafeMetric(emitMetric, 'observability.browser_batch.rejected_schema', {
        bytes: encodedBytes,
        count: events.length,
      });
      return { ok: false, status: 400, error: 'Invalid event count', code: 'INVALID_EVENT_COUNT' };
    }

    const allowedProject = input.isSuperAdmin || (await hasProjectAccess(input.actorUserId, project));
    if (!allowedProject) {
      emitSafeMetric(emitMetric, 'observability.browser_batch.rejected_schema', { bytes: encodedBytes, count: events.length });
      return { ok: false, status: 400, error: 'Invalid project context', code: 'INVALID_PROJECT' };
    }

    const enabled = await isCaptureEnabled(input.actorUserId, project);
    if (!enabled) {
      return { ok: false, status: 404, error: 'Not found', code: 'FLAG_DISABLED' };
    }

    for (const event of events) {
      if (!validateEvent(event, nowMs)) {
        emitSafeMetric(emitMetric, 'observability.browser_batch.rejected_schema', {
          bytes: encodedBytes,
          count: events.length,
        });
        return { ok: false, status: 400, error: 'Invalid batch schema', code: 'INVALID_SCHEMA' };
      }
    }

    const rate = rateLimit(input.actorUserId, nowMs);
    if (!rate.allowed) {
      emitSafeMetric(emitMetric, 'observability.browser_batch.rate_limited', {
        bytes: encodedBytes,
        count: events.length,
      });
      return {
        ok: false,
        status: 429,
        error: 'Too many requests',
        code: 'RATE_LIMITED',
        retryAfterSec: rate.retryAfterSec,
      };
    }

    let spoofAttempts = 0;
    let unknownRoutes = 0;
    const typedEvents = events as BrowserTraceEventCandidate[];
    for (const event of typedEvents) {
      if (event.actor !== undefined) spoofAttempts += 1;
      const normalized = normalizeApexRouteTemplate(event.routeTemplate);
      if (normalized === UNKNOWN_ROUTE_TEMPLATE) unknownRoutes += 1;
    }
    if (spoofAttempts > 0) {
      emitSafeMetric(emitMetric, 'observability.browser_batch.actor_spoof_ignored', { count: spoofAttempts });
    }
    if (unknownRoutes > 0) {
      emitSafeMetric(emitMetric, 'observability.browser_batch.route_unknown', { count: unknownRoutes });
    }

    for (const event of typedEvents) {
      capture(toServerCandidate(event, input.actorUserId, project));
    }

    emitSafeMetric(emitMetric, 'observability.browser_batch.accepted', {
      bytes: encodedBytes,
      count: typedEvents.length,
    });
    return { ok: true, accepted: typedEvents.length };
  }

  function resetRateLimitForTests(): void {
    actorWindows.clear();
  }

  return { ingest, resetRateLimitForTests };
}

let singleton: ReturnType<typeof createObservabilityIngestService> | null = null;

export function getObservabilityIngestService(): ReturnType<typeof createObservabilityIngestService> {
  singleton ??= createObservabilityIngestService();
  return singleton;
}

export function resetObservabilityIngestServiceForTests(): void {
  singleton = null;
}

export function setObservabilityIngestServiceForTests(
  service: ReturnType<typeof createObservabilityIngestService> | null,
): void {
  singleton = service;
}
