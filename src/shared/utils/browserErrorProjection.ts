/**
 * Converts Error Boundary, window.error, and rejection values into a bounded
 * safe message/stack without serializing arbitrary objects.
 */
import { redactTraceDetails } from './traceRedaction';

const FALLBACK_MESSAGE = 'Client error';

function readErrorLike(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) {
    return {
      message: value.message || FALLBACK_MESSAGE,
      stack: typeof value.stack === 'string' ? value.stack : undefined,
    };
  }
  if (typeof value === 'string') {
    return { message: value || FALLBACK_MESSAGE };
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && 'message' in value) {
    const record = value as { message?: unknown; stack?: unknown };
    if (typeof record.message === 'string') {
      return {
        message: record.message || FALLBACK_MESSAGE,
        stack: typeof record.stack === 'string' ? record.stack : undefined,
      };
    }
  }
  return { message: FALLBACK_MESSAGE };
}

export function projectBrowserError(value: unknown): { message: string; stack?: string } {
  const projected = readErrorLike(value);
  const redacted = redactTraceDetails({
    message: projected.message,
    ...(projected.stack ? { stack: projected.stack } : {}),
  });
  const message = typeof redacted.message === 'string' && redacted.message ? redacted.message : FALLBACK_MESSAGE;
  const stack = typeof redacted.stack === 'string' && redacted.stack ? redacted.stack : undefined;
  return stack ? { message, stack } : { message };
}

export function shouldRetainBrowserEvent(type: string, samplingRate = 1): boolean {
  if (type === 'route_view' || type === 'client_error' || type === 'unhandled_rejection') {
    return true;
  }
  if (samplingRate >= 1) return true;
  if (samplingRate <= 0) return false;
  return Math.random() < samplingRate;
}
