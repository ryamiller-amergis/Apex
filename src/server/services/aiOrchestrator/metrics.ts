/**
 * Control-plane metrics via Application Insights trackEvent (sanitized props).
 */
import type { OrchestratorMetrics } from './ports';

type TrackEventFn = (
  name: string,
  properties?: Record<string, string>,
  measurements?: Record<string, number>,
) => void;

let trackEventImpl: TrackEventFn | null = null;

export function setOrchestratorTrackEvent(fn: TrackEventFn | null): void {
  trackEventImpl = fn;
}

function emit(
  name: string,
  properties?: Record<string, string>,
  measurements?: Record<string, number>,
): void {
  if (!trackEventImpl) return;
  try {
    trackEventImpl(name, properties, measurements);
  } catch {
    /* never break the control plane for telemetry */
  }
}

export function createOrchestratorMetrics(): OrchestratorMetrics {
  return {
    increment(name, tags) {
      emit(name, tags, { count: 1 });
    },
    gauge(name, value, tags) {
      emit(name, tags, { value });
    },
    timing(name, ms, tags) {
      emit(name, tags, { ms });
    },
  };
}
