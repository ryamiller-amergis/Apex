import type { Request, RequestHandler, Response } from 'express';
import { requestContextOf } from '../observability/requestContext.ts';

export interface InFlightEntry {
  requestId: string;
  method: string;
  route: string;
  ageMs: number;
}

export interface InFlightTracker {
  size(): number;
  snapshot(): InFlightEntry[];
  /** Sends Connection: close on every response that has not started yet. */
  markDraining(): void;
  onIdle(listener: () => void): () => void;
}

export interface InFlightRegistry extends InFlightTracker {
  /** Mount after requestId() and request logging, before the routes. */
  middleware: RequestHandler;
}

interface OpenRequest {
  req: Request;
  res: Response;
  requestId: string;
  startedAt: number;
}

// The route template, never the raw path, which can carry identifiers.
function routeOf(req: Request): string {
  const path = req.route?.path;
  return path === undefined
    ? '(unmatched)'
    : `${req.baseUrl ?? ''}${String(path)}`;
}

export function createInFlightRegistry(
  options: { now?: () => number } = {}
): InFlightRegistry {
  const now = options.now ?? Date.now;
  const open = new Set<OpenRequest>();
  const idleListeners = new Set<() => void>();
  let draining = false;

  const closeOnDrain = (res: Response) => {
    if (!res.headersSent) {
      res.setHeader('Connection', 'close');
    }
  };

  return {
    middleware(req, res, next) {
      const entry: OpenRequest = {
        req,
        res,
        requestId: requestContextOf(req)?.requestId ?? 'unknown',
        startedAt: now(),
      };
      open.add(entry);
      if (draining) {
        closeOnDrain(res);
      }
      const done = () => {
        if (open.delete(entry) && open.size === 0) {
          for (const listener of idleListeners) {
            listener();
          }
        }
      };
      res.once('finish', done);
      res.once('close', done);
      next();
    },
    size: () => open.size,
    snapshot() {
      const time = now();
      return [...open].map((entry) => ({
        requestId: entry.requestId,
        method: entry.req.method,
        route: routeOf(entry.req),
        ageMs: time - entry.startedAt,
      }));
    },
    markDraining() {
      draining = true;
      for (const entry of open) {
        closeOnDrain(entry.res);
      }
    },
    onIdle(listener) {
      idleListeners.add(listener);
      return () => idleListeners.delete(listener);
    },
  };
}
