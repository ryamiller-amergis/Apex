import { randomUUID } from 'node:crypto';
import {
  problemContentType,
  problemTypes,
  type ProblemDetails,
  type ProblemError,
} from '@project-scope/contracts';
import type { Response } from 'express';
import { REQUEST_ID_HEADER } from '../observability/requestId.ts';

export interface ProblemSpec {
  readonly status: number;
  readonly type: ProblemDetails['type'];
  readonly title: string;
  readonly detail: string;
}

// Fixed text only. A Problem Details body never carries a submitted value, a
// driver message, or a stack trace.
export const problems = {
  validation: {
    status: 400,
    type: problemTypes.validationError,
    title: 'The request failed validation',
    detail: 'One or more fields are invalid. Each entry in errors names one.',
  },
  malformedBody: {
    status: 400,
    type: problemTypes.malformedBody,
    title: 'The request body is malformed',
    detail: 'Send a JSON object with Content-Type: application/json.',
  },
  notFound: {
    status: 404,
    type: problemTypes.notFound,
    title: 'Not found',
    detail: 'Nothing exists at this path.',
  },
  payloadTooLarge: {
    status: 413,
    type: problemTypes.payloadTooLarge,
    title: 'The request body is too large',
    detail: 'The request body must be 16 KB or smaller.',
  },
  rateLimited: {
    status: 429,
    type: problemTypes.rateLimited,
    title: 'Too many requests',
    detail: 'Wait before sending more requests.',
  },
  internal: {
    status: 500,
    type: problemTypes.internalError,
    title: 'Unexpected server error',
    detail: 'The server could not complete the request.',
  },
  serviceUnavailable: {
    status: 503,
    type: problemTypes.serviceUnavailable,
    title: 'Service unavailable',
    detail: 'A required service is unavailable. Try again later.',
  },
  notReady: {
    status: 503,
    type: problemTypes.notReady,
    title: 'Not ready',
    detail: 'The service is not ready to accept traffic.',
  },
} as const satisfies Record<string, ProblemSpec>;

/** The X-Request-Id that requestId() set, so the body repeats the header. */
export function responseRequestId(res: Response): string {
  const header = res.getHeader(REQUEST_ID_HEADER);
  if (typeof header === 'string' && header !== '') {
    return header;
  }
  const generated = randomUUID();
  res.setHeader(REQUEST_ID_HEADER, generated);
  return generated;
}

export function sendProblem(
  res: Response,
  spec: ProblemSpec,
  errors?: ProblemError[]
): void {
  const body: ProblemDetails = {
    type: spec.type,
    title: spec.title,
    status: spec.status,
    detail: spec.detail,
    requestId: responseRequestId(res),
    ...(errors === undefined ? {} : { errors }),
  };
  res.status(spec.status).type(problemContentType).json(body);
}

/** Thrown by a handler whose input failed its contract schema. */
export class RequestValidationError extends Error {
  readonly errors: ProblemError[];

  constructor(errors: ProblemError[]) {
    super('The request failed validation');
    this.name = 'RequestValidationError';
    this.errors = errors;
  }
}
