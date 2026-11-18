/**
 * Express 4 does not read the promise an async handler returns. A handler that throws after an
 * `await` therefore leaves the request open until the proxy cuts it off, and the error only shows
 * up as an unhandled rejection in the process log.
 *
 * Wrapping a router's handlers sends such an error to `next`, so the app's error middleware
 * answers the request. Handlers that already catch their own errors are unaffected.
 */
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

const VERBS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function wrap(handler: unknown): unknown {
  if (Array.isArray(handler)) return handler.map(wrap);
  // Four parameters marks an error handler, which Express identifies by arity.
  if (typeof handler !== 'function' || handler.length >= 4) return handler;
  const run = handler as Handler;
  const wrapped: RequestHandler = (req, res, next) => {
    try {
      const result = run(req, res, next);
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        (result as Promise<unknown>).catch(next);
      }
    } catch (error) {
      next(error);
    }
  };
  return wrapped;
}

export function forwardAsyncErrors<T extends Router>(router: T): T {
  const target = router as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const verb of VERBS) {
    const original = target[verb].bind(router);
    target[verb] = (path: unknown, ...handlers: unknown[]) =>
      original(path, ...handlers.map(wrap));
  }
  return router;
}
