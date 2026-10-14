/**
 * Visual lane concurrency control.
 *
 * Bedrock starts at two concurrent visual runs. Three and four are only tried
 * once a level has proven itself, and any throttle drops straight back to the
 * last level that was not throttled.
 */
export const VISUAL_MIN_CONCURRENCY = 2;
export const VISUAL_MAX_CONCURRENCY = 4;

/** Clean runs required at a level before trying the next one. */
export const VISUAL_PROMOTION_STREAK = 10;

export type VisualConcurrencyController = {
  current(): number;
  recordSuccess(): number;
  recordThrottle(): number;
};

export function createVisualConcurrencyController(options?: {
  initial?: number;
  promotionStreak?: number;
}): VisualConcurrencyController {
  const promotionStreak = options?.promotionStreak ?? VISUAL_PROMOTION_STREAK;
  let level = Math.min(
    VISUAL_MAX_CONCURRENCY,
    Math.max(VISUAL_MIN_CONCURRENCY, options?.initial ?? VISUAL_MIN_CONCURRENCY),
  );
  let cleanRuns = 0;

  return {
    current() {
      return level;
    },

    recordSuccess() {
      if (level >= VISUAL_MAX_CONCURRENCY) return level;
      cleanRuns += 1;
      if (cleanRuns >= promotionStreak) {
        level += 1;
        cleanRuns = 0;
      }
      return level;
    },

    recordThrottle() {
      cleanRuns = 0;
      level = Math.max(VISUAL_MIN_CONCURRENCY, level - 1);
      return level;
    },
  };
}

export function isBedrockThrottle(error: unknown): boolean {
  if (!error) return false;
  const message =
    error instanceof Error ? error.message : String(error as unknown);
  const status = (error as { statusCode?: number; status?: number }).statusCode
    ?? (error as { status?: number }).status;
  if (status === 429) return true;
  return /throttl|too many requests|rate exceeded/i.test(message);
}
