/**
 * Public API-key authentication + per-key rate limiting (FEAT-002 / TBI-003).
 *
 * Session-free boundary: parse Bearer → apiKeyLifecycleService.verifyRawKey →
 * attach { apiKeyId, projectId } → fixed 100/min rate gate.
 * Project context comes only from the verified key (BR-010); request-supplied
 * project inputs are ignored by design (never read here or in public routes).
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { PublicApiKeyContext, ApiKeyScope } from '../../shared/types/apiKey';
import { verifyRawKey } from '../services/apiKeyLifecycleService';
import { consumePublicApiKeyRateLimit } from '../services/publicRateLimitService';

export const PUBLIC_API_KEY_UNAUTHORIZED_CODE = 'PUBLIC_API_KEY_UNAUTHORIZED';
export const PUBLIC_API_KEY_RATE_LIMITED_CODE = 'PUBLIC_API_KEY_RATE_LIMITED';

const GENERIC_401_BODY = {
  error: 'Invalid or missing API key',
  code: PUBLIC_API_KEY_UNAUTHORIZED_CODE,
} as const;

const GENERIC_429_BODY = {
  error: 'API key rate limit exceeded',
  code: PUBLIC_API_KEY_RATE_LIMITED_CODE,
} as const;

declare global {
  // Express request augmentation requires the namespace form.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      _publicApiKey?: PublicApiKeyContext;
    }
  }
}

function parseBearer(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header || '');
  return match?.[1]?.trim() || null;
}

function sendUnauthorized(res: Response): void {
  res.status(401).json(GENERIC_401_BODY);
}

/**
 * Authenticate a public request with Authorization: Bearer <apex_…>.
 * Attaches req._publicApiKey on success; never logs the raw credential.
 */
export const requirePublicApiKey: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  void (async () => {
    const rawKey = parseBearer(req.header('authorization'));
    if (!rawKey) {
      sendUnauthorized(res);
      return;
    }

    const verified = await verifyRawKey(rawKey);
    if (!verified) {
      sendUnauthorized(res);
      return;
    }

    const decision = consumePublicApiKeyRateLimit(verified.apiKeyId);
    if (!decision.allowed) {
      res.status(429).json(GENERIC_429_BODY);
      return;
    }

    req._publicApiKey = {
      apiKeyId: verified.apiKeyId,
      projectId: verified.projectId,
      scopes: verified.scopes,
    };
    next();
  })().catch(next);
};

/**
 * After requirePublicApiKey — require at least one of the listed scopes.
 * Ping remains auth-only and does not call this helper.
 */
export function requireApiKeyScope(...required: ApiKeyScope[]): RequestHandler {
  return (req, res, next) => {
    const granted = req._publicApiKey?.scopes ?? [];
    const ok = required.some((scope) => granted.includes(scope));
    if (!ok) {
      res.status(403).json({
        error: 'API key is missing required scope',
        code: 'PUBLIC_API_KEY_FORBIDDEN',
      });
      return;
    }
    next();
  };
}

/** Stable generic 401 body for tests (byte-identical across rejection classes). */
export function __publicApiKeyUnauthorizedBodyForTests(): typeof GENERIC_401_BODY {
  return GENERIC_401_BODY;
}
