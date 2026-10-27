import type { ErrorRequestHandler } from 'express';
import type { Logger } from './logger.ts';
import { requestContextOf } from './requestContext.ts';

/**
 * Mount after the routes and before the Problem Details handler. Logs the
 * error through the typed err serializer, never the request body, then
 * passes the error on.
 */
export function errorLogging(logger: Logger): ErrorRequestHandler {
  return (err, req, _res, next) => {
    const context = requestContextOf(req);
    logger.error(
      {
        requestId: context?.requestId,
        correlationId: context?.correlationId,
        err,
      },
      'request failed'
    );
    next(err);
  };
}
