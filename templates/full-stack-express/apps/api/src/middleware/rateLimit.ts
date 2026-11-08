import type { RequestHandler } from 'express';
import { problems, sendProblem } from '../http/problems.ts';

export interface RateLimitOptions {
  /** Requests allowed per client in one window. */
  max: number;
  windowMs: number;
  now?: () => number;
}

/**
 * The default rate-limit hook: a fixed window per client IP, held in memory.
 * Each instance counts on its own, so a project that runs several instances
 * and needs one shared limit passes its own RequestHandler to createApp as
 * `rateLimiter` instead. Counters reset together when the window ends, so
 * memory stays bounded by the clients seen in one window.
 */
export function createRateLimit(options: RateLimitOptions): RequestHandler {
  const now = options.now ?? Date.now;
  let windowStart = now();
  let counts = new Map<string, number>();

  return (req, res, next) => {
    const time = now();
    if (time - windowStart >= options.windowMs) {
      windowStart = time;
      counts = new Map();
    }
    const key = req.ip ?? 'unknown';
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > options.max) {
      const retryAfterMs = windowStart + options.windowMs - time;
      res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      sendProblem(res, problems.rateLimited);
      return;
    }
    next();
  };
}
