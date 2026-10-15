/**
 * A dropped or stalled Cursor connection, worth one fresh attempt. Matched by
 * name and code because the error can cross the actor-host transport, where the
 * class identity is lost. Rate limits and a busy agent also report retryable,
 * but sending again at once would hit the same limit or the same live run.
 */
export function isRetryableCursorConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, name, isRetryable } = error as {
    code?: unknown;
    name?: unknown;
    isRetryable?: unknown;
  };
  if (name === 'RateLimitError' || name === 'AgentBusyError') return false;
  return (
    code === 'connection_stalled' ||
    (name === 'NetworkError' && isRetryable === true)
  );
}
