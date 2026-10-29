import { isSpanContextValid, trace } from '@opentelemetry/api';
import { pino, type DestinationStream } from 'pino';
import type { Env } from '../config/env.ts';
import { REDACT_PATHS, REDACTED, serializeError } from './redaction.ts';
import { getRequestContext } from './requestContext.ts';

export type Logger = pino.Logger;

/**
 * Single-line JSON to stdout through an asynchronous destination. The mixin
 * adds requestId, correlationId, trace_id, and span_id from the active
 * request and span, so code deep in the call stack needs no logger plumbing.
 */
export function createLogger(
  env: Pick<Env, 'LOG_LEVEL'>,
  destination: DestinationStream = pino.destination({ dest: 1, sync: false })
): Logger {
  return pino(
    {
      level: env.LOG_LEVEL,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
      },
      redact: { paths: REDACT_PATHS, censor: REDACTED },
      serializers: { err: serializeError, error: serializeError },
      mixin(mergeObject, _level, logger) {
        const fields: Record<string, string> = {};
        const context = getRequestContext();
        if (
          context &&
          !('requestId' in mergeObject) &&
          logger.bindings().requestId === undefined
        ) {
          fields.requestId = context.requestId;
          fields.correlationId = context.correlationId;
        }
        const spanContext = trace.getActiveSpan()?.spanContext();
        if (spanContext && isSpanContextValid(spanContext)) {
          fields.trace_id = spanContext.traceId;
          fields.span_id = spanContext.spanId;
        }
        return fields;
      },
    },
    destination
  );
}
