import type {
  GroundingNotificationVolume,
  GroundingTelemetryContext,
} from '../../shared/types/groundingOperations';
import { trackEvent } from './telemetry';

type EventEmitter = typeof trackEvent;
type MaterializationMode = 'cold' | 'warm';
type OperationOutcome = 'success' | 'failure';

const SAFE_PROPERTY_KEYS = new Set([
  'branch',
  'caller',
  'mode',
  'outcome',
  'project',
  'provider',
  'reason',
  'repoRole',
  'repository',
  'result',
  'runId',
  'runType',
]);

function isLocalPath(value: string): boolean {
  return (
    /^[a-z]:[\\/]/i.test(value) ||
    /^\\\\/.test(value) ||
    /^\/(?:home|users?|tmp|var|opt|mnt)\//i.test(value)
  );
}

function sanitizeRepository(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return isLocalPath(value) ? null : value;
  }
}

function sanitizeValue(key: string, value: unknown): string | null {
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean'
  ) {
    return null;
  }
  const text = String(value);
  if (!text || isLocalPath(text)) return null;
  if (
    /(?:password|passwd|token|secret|credential|api[_-]?key)\s*[=:]/i.test(
      text
    ) ||
    /\bBearer\s+\S+/i.test(text)
  ) {
    return null;
  }
  return key === 'repository' ? sanitizeRepository(text) : text;
}

export function sanitizeGroundingTelemetryProperties(
  properties: Record<string, unknown>
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!SAFE_PROPERTY_KEYS.has(key)) continue;
    const sanitized = sanitizeValue(key, value);
    if (sanitized !== null) safe[key] = sanitized;
  }
  return safe;
}

function properties(
  context: GroundingTelemetryContext,
  extra: Record<string, unknown> = {}
): Record<string, string> {
  return sanitizeGroundingTelemetryProperties({ ...context, ...extra });
}

export interface GroundingTelemetry {
  materialization(
    context: GroundingTelemetryContext,
    mode: MaterializationMode,
    durationMs: number,
    outcome: OperationOutcome
  ): void;
  mirror(context: GroundingTelemetryContext, hit: boolean): void;
  bundle(context: GroundingTelemetryContext, hit: boolean): void;
  localRead(context: GroundingTelemetryContext, durationMs: number): void;
  fallback(context: GroundingTelemetryContext, reason: string): void;
  drift(context: GroundingTelemetryContext): void;
  staleness(
    context: GroundingTelemetryContext,
    measurements?: Record<string, number>
  ): void;
  failure(context: GroundingTelemetryContext, reason: string): void;
  notification(
    context: GroundingTelemetryContext,
    volume: GroundingNotificationVolume
  ): void;
}

export function createGroundingTelemetry(
  emit: EventEmitter = trackEvent
): GroundingTelemetry {
  return {
    materialization(context, mode, durationMs, outcome) {
      emit('grounding.materialize', properties(context, { mode, outcome }), {
        durationMs,
      });
    },
    mirror(context, hit) {
      emit(
        'grounding.mirror',
        properties(context, { result: hit ? 'hit' : 'miss' }),
        { hit: hit ? 1 : 0 }
      );
    },
    bundle(context, hit) {
      emit(
        'grounding.bundle',
        properties(context, { result: hit ? 'hit' : 'miss' }),
        { hit: hit ? 1 : 0 }
      );
    },
    localRead(context, durationMs) {
      emit('grounding.read.latency', properties(context), { durationMs });
    },
    fallback(context, reason) {
      emit('grounding.fallback', properties(context, { reason }), {
        fallbackCount: 1,
      });
    },
    drift(context) {
      emit('grounding.drift', properties(context), { breachCount: 1 });
    },
    staleness(context, measurements) {
      emit('grounding.staleness', properties(context), {
        breachCount: 1,
        ...measurements,
      });
    },
    failure(context, reason) {
      emit('grounding.failure', properties(context, { reason }), {
        failureCount: 1,
      });
    },
    notification(context, volume) {
      emit('grounding.notification', properties(context), { ...volume });
    },
  };
}

export const groundingTelemetry = createGroundingTelemetry();
