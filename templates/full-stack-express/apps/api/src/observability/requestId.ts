import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { runWithRequestContext } from './requestContext.ts';

export const REQUEST_ID_HEADER = 'X-Request-Id';
export const CORRELATION_ID_HEADER = 'X-Correlation-Id';

const VALID_ID = /^[A-Za-z0-9._-]{1,64}$/;

function validId(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && VALID_ID.test(value) ? value : undefined;
}

/**
 * Mount first. Reuses a caller X-Request-Id that matches
 * ^[A-Za-z0-9._-]{1,64}$ and generates a UUID otherwise. The header is set
 * before next(), so error and not-found responses carry it too.
 */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const id = validId(req.headers['x-request-id']) ?? randomUUID();
    const correlationId = validId(req.headers['x-correlation-id']) ?? id;
    res.setHeader(REQUEST_ID_HEADER, id);
    runWithRequestContext(
      { requestId: id, correlationId, startedAt: Date.now() },
      req,
      next
    );
  };
}
