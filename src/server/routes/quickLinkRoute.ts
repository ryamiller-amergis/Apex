import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  ProjectQuickLinkError,
  type ProjectQuickLinkErrorCode,
} from '../../shared/types/projectQuickLinks';

function statusForCode(code: ProjectQuickLinkErrorCode): number {
  switch (code) {
    case 'VALIDATION':
      return 422;
    case 'NOT_FOUND':
      return 404;
    case 'DUPLICATE':
    case 'LIMIT_REACHED':
      return 409;
    default: {
      const unhandled: never = code;
      return unhandled;
    }
  }
}

/** Wraps a Quick Links handler so service errors become `{ error, code }` responses. */
export function quickLinkRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof ProjectQuickLinkError) {
        res.status(statusForCode(err.code)).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  };
}
