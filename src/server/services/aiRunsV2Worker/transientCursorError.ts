/**
 * Whether a Cursor run failed because its connection to Cursor dropped, so a
 * fresh attempt can be expected to succeed. The SDK does not always wrap the
 * drop: production reports a bare `ConnectError: [unknown] Premature close`,
 * with no status, network code, or retryable flag.
 *
 * Authentication and configuration failures are never transient.
 */
const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ECONNREFUSED',
]);

const NON_TRANSIENT_ERROR_NAMES: ReadonlySet<string> = new Set([
  'AuthenticationError',
  'ConfigurationError',
  'AgentNotFoundError',
  'AbortError',
]);

const DROPPED_CONNECTION_MESSAGE = /premature close|socket hang up/i;

const MAX_CAUSE_DEPTH = 5;

type ErrorLike = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  isRetryable?: unknown;
  cause?: unknown;
};

export function isTransientCursorConnectionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth += 1) {
    if (typeof current === 'string') {
      return DROPPED_CONNECTION_MESSAGE.test(current);
    }
    if (typeof current !== 'object') return false;

    const record = current as ErrorLike;
    const status =
      typeof record.statusCode === 'number' ? record.statusCode : record.status;
    if (status === 401 || status === 403) return false;
    if (
      typeof record.name === 'string' &&
      NON_TRANSIENT_ERROR_NAMES.has(record.name)
    ) {
      return false;
    }
    if (record.name === 'NetworkError' || record.isRetryable === true)
      return true;
    if (
      typeof record.code === 'string' &&
      TRANSIENT_NETWORK_CODES.has(record.code)
    ) {
      return true;
    }
    if (
      typeof record.message === 'string' &&
      DROPPED_CONNECTION_MESSAGE.test(record.message)
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}
