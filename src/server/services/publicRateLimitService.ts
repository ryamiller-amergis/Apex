/**
 * In-process fixed-window rate limiter for public API-key auth (FEAT-002 / BR-011).
 * Accurate per process instance; multi-replica deployments may undercount until a shared store is adopted.
 */

export const PUBLIC_API_KEY_RATE_LIMIT = 100;
export const PUBLIC_API_KEY_RATE_WINDOW_MS = 60_000;

type WindowState = {
  count: number;
  windowStartMs: number;
};

const windows = new Map<string, WindowState>();

export type RateLimitDecision = {
  allowed: boolean;
};

/**
 * Consume one request against the fixed 100/min window for `apiKeyId`.
 * Pass `nowMs` in tests to advance the clock without waiting.
 */
export function consumePublicApiKeyRateLimit(
  apiKeyId: string,
  nowMs: number = Date.now(),
): RateLimitDecision {
  const existing = windows.get(apiKeyId);
  if (!existing || nowMs - existing.windowStartMs >= PUBLIC_API_KEY_RATE_WINDOW_MS) {
    windows.set(apiKeyId, { count: 1, windowStartMs: nowMs });
    return { allowed: true };
  }
  if (existing.count >= PUBLIC_API_KEY_RATE_LIMIT) {
    return { allowed: false };
  }
  existing.count += 1;
  return { allowed: true };
}

/** Test helper — clear the in-process store between cases. */
export function __resetPublicRateLimitForTests(): void {
  windows.clear();
}
