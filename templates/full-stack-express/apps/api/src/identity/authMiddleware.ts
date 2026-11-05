import { randomUUID } from 'node:crypto';
import {
  problemContentType,
  problemTypes,
  type ProblemDetails,
} from '@project-scope/contracts';
import type { RequestHandler, Response } from 'express';
import { REQUEST_ID_HEADER } from '../observability/requestId.ts';
import { requestContextOf } from '../observability/requestContext.ts';
import type { IdentityLogger, IdentityProviderAdapter } from './adapter.ts';
import { principalSchema, type Principal } from './principal.ts';

export const AUTHENTICATION_REQUIRED_DETAIL = 'Authentication is required.';
export const DEFAULT_CHALLENGE = 'Bearer';

export type AuthRejectionReason =
  'no_principal' | 'adapter_error' | 'invalid_principal';

export interface AuthMiddlewareOptions {
  adapter: IdentityProviderAdapter;
  logger: IdentityLogger;
}

/** Thrown by getPrincipal on a route that is not behind the middleware. */
export class PrincipalMissingError extends Error {
  constructor() {
    super('No authenticated principal on this response');
    this.name = 'PrincipalMissingError';
  }
}

interface PrincipalLocals {
  principal?: Principal;
}

/**
 * Mount once in front of the protected router, after requestId():
 * `app.use('/api/v1', authenticate, v1Router)`. Every outcome other than a
 * valid principal returns a 401, including an adapter that throws. Logs carry
 * a reason code and, for adapter errors, the error class name only, because
 * provider error messages can hold token fragments.
 */
export function createAuthMiddleware(
  options: AuthMiddlewareOptions
): RequestHandler {
  const { adapter, logger } = options;
  const challenge = adapter.challenge ?? DEFAULT_CHALLENGE;

  function reject(
    req: Parameters<RequestHandler>[0],
    res: Response,
    reason: AuthRejectionReason,
    errorName?: string
  ): void {
    logger.warn(
      errorName === undefined
        ? { event: 'auth.rejected', reason }
        : { event: 'auth.rejected', reason, errorName },
      'request rejected: authentication required'
    );
    let requestId = requestContextOf(req)?.requestId;
    if (requestId === undefined) {
      requestId = randomUUID();
      res.setHeader(REQUEST_ID_HEADER, requestId);
    }
    const body: ProblemDetails = {
      type: problemTypes.authenticationRequired,
      title: 'Authentication is required',
      status: 401,
      detail: AUTHENTICATION_REQUIRED_DETAIL,
      requestId,
    };
    res
      .status(401)
      .setHeader('WWW-Authenticate', challenge)
      .type(problemContentType)
      .json(body);
  }

  return async (req, res, next) => {
    let result: unknown;
    try {
      result = await adapter.authenticate({ headers: req.headers });
    } catch (error) {
      reject(
        req,
        res,
        'adapter_error',
        error instanceof Error ? error.name : typeof error
      );
      return;
    }
    if (result === null || result === undefined) {
      reject(req, res, 'no_principal');
      return;
    }
    const parsed = principalSchema.safeParse(result);
    if (!parsed.success) {
      reject(req, res, 'invalid_principal');
      return;
    }
    (res.locals as PrincipalLocals).principal = Object.freeze(parsed.data);
    next();
  };
}

/**
 * The only way a handler learns who is calling. Throws when the route is not
 * behind the middleware, so a mis-mounted route fails loudly as a 500 instead
 * of running anonymously.
 */
export function getPrincipal(res: Response): Principal {
  const principal = (res.locals as PrincipalLocals).principal;
  if (principal === undefined) {
    throw new PrincipalMissingError();
  }
  return principal;
}
