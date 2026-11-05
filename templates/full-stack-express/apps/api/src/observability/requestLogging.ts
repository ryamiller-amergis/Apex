import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import type { Logger } from './logger.ts';
import {
  requestPath,
  serializeError,
  serializeRequest,
  serializeResponse,
} from './redaction.ts';
import { requestContextOf } from './requestContext.ts';

export const PROBE_PATHS: ReadonlySet<string> = new Set([
  '/health/live',
  '/health/ready',
]);

export function isProbeRequest(req: IncomingMessage): boolean {
  return PROBE_PATHS.has(requestPath(req));
}

/**
 * Mount after requestId(). Writes one "request completed" line per request
 * with method, path without query string, status, and duration. Bodies,
 * headers, and cookies are never logged.
 */
export function requestLogging(logger: Logger): RequestHandler {
  const middleware = pinoHttp({
    logger,
    quietReqLogger: true,
    wrapSerializers: false,
    genReqId: (req) => requestContextOf(req)?.requestId ?? randomUUID(),
    customAttributeKeys: { reqId: 'requestId', responseTime: 'durationMs' },
    serializers: {
      req: serializeRequest,
      res: serializeResponse,
      err: serializeError,
    },
    customProps: (req) => ({
      correlationId: requestContextOf(req)?.correlationId,
    }),
    customLogLevel: (req, res, error) => {
      if (error || res.statusCode >= 500) {
        return 'error';
      }
      return isProbeRequest(req) ? 'debug' : 'info';
    },
    customSuccessMessage: () => 'request completed',
    customErrorMessage: () => 'request completed',
  });
  return (req, res, next) => middleware(req, res, next);
}
