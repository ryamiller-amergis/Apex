import type {
  GroundingAgentRecreateEventProperties,
  GroundingBindingWriteEventProperties,
  GroundingNotificationVolume,
  GroundingTelemetryContext,
  NativeReadCapabilitySelfCheckEventProperties,
  NativeReadDeniedEventProperties,
  NativeReadEngagedEventProperties,
  NativeReadFlagEvaluatedEventProperties,
} from '../../shared/types/groundingOperations';
import { NATIVE_READ_TELEMETRY_EVENT_NAMES } from '../../shared/types/groundingOperations';
import { trackEvent } from './telemetry';

export type {
  NativeReadDeniedEventProperties,
  NativeReadEngagedEventProperties,
} from '../../shared/types/groundingOperations';

type EventEmitter = typeof trackEvent;
type MaterializationMode = 'cold' | 'warm';
type OperationOutcome = 'success' | 'failure';

export type NativeReadDefinedOnlyTelemetryEvent =
  | {
      name: typeof NATIVE_READ_TELEMETRY_EVENT_NAMES.denied;
      properties: NativeReadDeniedEventProperties;
    }
  | {
      name: typeof NATIVE_READ_TELEMETRY_EVENT_NAMES.engaged;
      properties: NativeReadEngagedEventProperties;
    };

const SAFE_PROPERTY_KEYS = new Set([
  'branch',
  'caller',
  'denialCategory',
  'flag',
  'mode',
  'outcome',
  'phase',
  'project',
  'provider',
  'reason',
  'recreateReason',
  'repoRole',
  'repository',
  'result',
  'runId',
  'runType',
  'selfCheckReason',
  'workflowClass',
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
  /** Narrow post-mirror progress markers (activate / shared / per-run). */
  phase(context: GroundingTelemetryContext, phase: string): void;
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
  recreation(
    context: GroundingTelemetryContext,
    reason: string,
    outcome: OperationOutcome
  ): void;
  bindingWrite(
    context: GroundingTelemetryContext,
    mode: GroundingBindingWriteEventProperties['mode'],
    outcome: GroundingBindingWriteEventProperties['outcome']
  ): void;
  lifecycleFlag(
    context: GroundingTelemetryContext,
    enabled: boolean,
    outcome: OperationOutcome
  ): void;
  nativeReadFlagEvaluated(
    context: GroundingTelemetryContext,
    outcome: NativeReadFlagEvaluatedEventProperties['outcome'],
    reason: string
  ): void;
  nativeReadCapabilitySelfCheck(
    context: GroundingTelemetryContext,
    outcome: NativeReadCapabilitySelfCheckEventProperties['outcome'],
    selfCheckReason: string
  ): void;
  nativeReadEngaged(context: GroundingTelemetryContext): void;
  agentRecreate(
    context: GroundingTelemetryContext,
    recreateReason: GroundingAgentRecreateEventProperties['recreateReason']
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
    phase(context, phase) {
      emit('grounding.phase', properties(context, { phase }), { phaseCount: 1 });
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
    recreation(context, reason, outcome) {
      emit(
        'grounding.binding.recreation',
        properties(context, { reason, outcome }),
        { recreationCount: 1 },
      );
    },
    bindingWrite(context, mode, outcome) {
      emit(
        NATIVE_READ_TELEMETRY_EVENT_NAMES.bindingWrite,
        properties(context, { mode, outcome }),
        { bindingWriteCount: 1 },
      );
    },
    lifecycleFlag(context, enabled, outcome) {
      emit(
        'grounding.binding.flag',
        properties(context, {
          result: enabled ? 'enabled' : 'disabled',
          outcome,
        }),
        { evaluationCount: 1 },
      );
    },
    nativeReadFlagEvaluated(context, outcome, reason) {
      emit(
        NATIVE_READ_TELEMETRY_EVENT_NAMES.flagEvaluated,
        properties(context, {
          flag: 'native-read',
          outcome,
          reason,
        }),
        { evaluationCount: 1 },
      );
    },
    nativeReadCapabilitySelfCheck(context, outcome, selfCheckReason) {
      emit(
        NATIVE_READ_TELEMETRY_EVENT_NAMES.capabilitySelfCheck,
        properties(context, { outcome, selfCheckReason }),
        { selfCheckCount: 1 },
      );
    },
    nativeReadEngaged(context) {
      emit(
        NATIVE_READ_TELEMETRY_EVENT_NAMES.engaged,
        properties(context),
        { engagementCount: 1 },
      );
    },
    agentRecreate(context, recreateReason) {
      emit(
        NATIVE_READ_TELEMETRY_EVENT_NAMES.agentRecreate,
        properties(context, { recreateReason }),
        { recreationCount: 1 },
      );
    },
  };
}

export const groundingTelemetry = createGroundingTelemetry();
