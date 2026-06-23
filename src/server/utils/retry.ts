export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  /** Custom predicate — return true to retry, false to bail. Overrides the default status-code check. */
  shouldRetry?: (err: unknown) => boolean;
  /** Add random jitter to backoff delay (prevents thundering herd). Defaults to true. */
  jitter?: boolean;
}

function isCursorAgentError(err: unknown): err is Error & { isRetryable?: boolean } {
  if (!(err instanceof Error)) return false;
  return 'isRetryable' in err;
}

function defaultShouldRetry(err: unknown): boolean {
  const statusCode = (err as any)?.statusCode || (err as any)?.status;
  if (statusCode === 429 || (statusCode >= 500 && statusCode < 600)) return true;
  return false;
}

/**
 * Retry `fn` with exponential backoff.
 *
 * Overloads preserve backward compatibility with callers using positional args:
 *   retryWithBackoff(fn)
 *   retryWithBackoff(fn, 3, 1000)
 *   retryWithBackoff(fn, { maxRetries: 3, jitter: true, shouldRetry: ... })
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  optsOrMaxRetries?: RetryOptions | number,
  legacyInitialDelay?: number,
): Promise<T> {
  let maxRetries: number;
  let initialDelay: number;
  let shouldRetry: ((err: unknown) => boolean) | undefined;
  let jitter: boolean;

  if (typeof optsOrMaxRetries === 'object' && optsOrMaxRetries !== null) {
    maxRetries = optsOrMaxRetries.maxRetries ?? 3;
    initialDelay = optsOrMaxRetries.initialDelay ?? 1000;
    shouldRetry = optsOrMaxRetries.shouldRetry;
    jitter = optsOrMaxRetries.jitter ?? true;
  } else {
    maxRetries = (optsOrMaxRetries as number | undefined) ?? 3;
    initialDelay = legacyInitialDelay ?? 1000;
    shouldRetry = undefined;
    jitter = false; // legacy callers didn't expect jitter
  }

  let lastError: Error | null = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // CursorAgentError with explicit retryable flag takes precedence
      let forceRetry = false;
      if (isCursorAgentError(error)) {
        if (error.isRetryable === true) {
          forceRetry = true;
        } else if (error.isRetryable === false) {
          throw error; // never retry
        }
        // isRetryable is undefined — fall through to shouldRetry / default
      }

      if (!forceRetry) {
        const retryable = shouldRetry
          ? shouldRetry(error)
          : defaultShouldRetry(error);

        if (!retryable) throw error;
      }

      let delay = initialDelay * Math.pow(2, i);
      if (jitter) {
        delay = delay * (0.5 + Math.random()); // 50-150% of base delay
      }

      console.log(
        `Retry ${i + 1}/${maxRetries} after ${Math.round(delay)}ms`,
      );
      await sleep(delay);
    }
  }

  throw lastError;
}
