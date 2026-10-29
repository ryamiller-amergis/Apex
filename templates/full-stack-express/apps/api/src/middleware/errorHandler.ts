import type { ErrorRequestHandler } from 'express';
import {
  problems,
  RequestValidationError,
  sendProblem,
  type ProblemSpec,
} from '../http/problems.ts';
import type { Logger } from '../observability/logger.ts';
import { requestContextOf } from '../observability/requestContext.ts';
import {
  PersistenceError,
  PersistenceUnavailableError,
} from '../persistence/index.ts';
import { NotReadyError } from '../services/readinessService.ts';

interface BodyParserError {
  type: string;
  status: number;
}

// body-parser errors carry a string `type` such as entity.parse.failed and a
// 4xx `status`.
function bodyParserError(err: unknown): BodyParserError | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const { type, status } = err as Partial<BodyParserError>;
  return typeof type === 'string' &&
    typeof status === 'number' &&
    status >= 400 &&
    status < 500
    ? { type, status }
    : undefined;
}

function classify(err: unknown): { spec: ProblemSpec; logged: boolean } {
  if (err instanceof RequestValidationError) {
    return { spec: problems.validation, logged: false };
  }
  const parser = bodyParserError(err);
  if (parser) {
    if (parser.type === 'entity.too.large') {
      return { spec: problems.payloadTooLarge, logged: false };
    }
    return {
      spec: { ...problems.malformedBody, status: parser.status },
      logged: false,
    };
  }
  if (err instanceof NotReadyError) {
    return { spec: problems.notReady, logged: false };
  }
  if (err instanceof PersistenceUnavailableError) {
    return { spec: problems.serviceUnavailable, logged: true };
  }
  return { spec: problems.internal, logged: true };
}

/**
 * Mount last. Turns every error into Problem Details with fixed text. A 5xx
 * is logged once with the error class name and SQLSTATE only: messages and
 * stacks are left out because a driver or provider message can hold a
 * submitted value or an identity value.
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const { spec, logged } = classify(err);
    if (logged) {
      const fields: Record<string, unknown> = {
        event: 'request.failed',
        requestId: requestContextOf(req)?.requestId,
        status: spec.status,
        errorName: err instanceof Error ? err.name : typeof err,
      };
      if (err instanceof PersistenceError && err.sqlState !== undefined) {
        fields.sqlState = err.sqlState;
      }
      logger.error(fields, 'request failed');
    }
    sendProblem(
      res,
      spec,
      err instanceof RequestValidationError ? err.errors : undefined
    );
  };
}
