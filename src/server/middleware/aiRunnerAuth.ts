/**
 * Session-free AI runner callback authentication (FEAT-004 / TBI-005).
 *
 * Azure callers must present a verified managed-identity JWT whose client ID is
 * allowlisted and whose application roles include AiRun.Runner. An explicitly
 * configured static bearer token is supported only for local development/tests.
 */
import {
  createPublicKey,
  timingSafeEqual,
  verify as cryptoVerify,
} from 'crypto';
import type { JsonWebKey as CryptoJsonWebKey } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { resolveStaticAiRunnerCallbackToken } from '../services/aiRunnerCallbackAuthConfig';

export const AI_RUNNER_AUTH_HEADER = 'authorization';
const REQUIRED_ROLE = 'AiRun.Runner';
const JWKS_TTL_MS = 60 * 60 * 1000;

type Jwk = CryptoJsonWebKey & {
  kid?: string;
  kty: string;
};

type JwksCache = {
  keys: Jwk[];
  fetchedAtMs: number;
};

type ManagedIdentityResult = 'authorized' | 'forbidden' | 'invalid';
type ManagedIdentityReason =
  | 'authorized'
  | 'config_missing'
  | 'jwt_format_invalid'
  | 'jwt_decode_failed'
  | 'jwt_alg_invalid'
  | 'jwt_expired'
  | 'tenant_mismatch'
  | 'audience_mismatch'
  | 'client_not_allowlisted'
  | 'jwks_fetch_failed'
  | 'jwks_key_missing'
  | 'signature_invalid'
  | 'role_missing';
type ManagedIdentityEvaluation = {
  result: ManagedIdentityResult;
  reason: ManagedIdentityReason;
  transient: boolean;
};

const jwksByTenant = new Map<string, JwksCache>();

function parseBearer(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header || '');
  return match?.[1]?.trim() || null;
}

function base64UrlToBuffer(input: string): Buffer {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(base64UrlToBuffer(part).toString('utf8')) as Record<string, unknown>;
}

function csvEnv(name: string): string[] {
  return (process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function resolveAudienceCandidates(): string[] {
  const explicit = process.env.AI_RUNS_CALLBACK_TOKEN_AUDIENCE?.trim();
  if (explicit) return [explicit.replace(/\/\.default$/i, '')];

  const clientId = process.env.AZURE_CLIENT_ID?.trim();
  return clientId ? [`api://${clientId}`, clientId] : [];
}

function resolveAllowedClientIds(): string[] {
  return csvEnv('AI_RUNS_RUNNER_ALLOWED_CLIENT_IDS');
}

function resolveStaticToken(): string | undefined {
  return resolveStaticAiRunnerCallbackToken();
}

function authConfigured(): boolean {
  return Boolean(resolveStaticToken())
    || (
      resolveAudienceCandidates().length > 0
      && resolveAllowedClientIds().length > 0
    );
}

function staticTokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

async function fetchJwks(tenantId: string, forceRefresh = false): Promise<Jwk[]> {
  const cached = jwksByTenant.get(tenantId);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAtMs < JWKS_TTL_MS) {
    return cached.keys;
  }

  const url =
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/discovery/v2.0/keys`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch Entra JWKS (${response.status})`);
  }
  const body = await response.json() as { keys?: Jwk[] };
  const keys = body.keys || [];
  jwksByTenant.set(tenantId, { keys, fetchedAtMs: Date.now() });
  return keys;
}

function verifyRs256(token: string, jwk: Jwk): boolean {
  const [headerB64, payloadB64, signatureB64] = token.split('.');
  if (!headerB64 || !payloadB64 || !signatureB64) return false;
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  return cryptoVerify(
    'RSA-SHA256',
    Buffer.from(`${headerB64}.${payloadB64}`),
    key,
    base64UrlToBuffer(signatureB64),
  );
}

function audienceMatches(claim: unknown, allowed: string[]): boolean {
  const values = Array.isArray(claim)
    ? claim.map(String)
    : claim == null
      ? []
      : [String(claim)];
  return values.some((audience) =>
    allowed.some((candidate) =>
      audience === candidate
      || audience === candidate.replace(/^api:\/\//, '')
      || `api://${audience}` === candidate,
    ),
  );
}

function hasRequiredRole(claim: unknown): boolean {
  const roles = Array.isArray(claim)
    ? claim.map(String)
    : typeof claim === 'string'
      ? [claim]
      : [];
  return roles.includes(REQUIRED_ROLE);
}

function isTransientJwksFetchError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = Number(
    (error as { status?: unknown; statusCode?: unknown }).statusCode
      ?? (error as { status?: unknown; statusCode?: unknown }).status,
  );
  if (Number.isFinite(status)) {
    if (status === 408 || status === 429) return true;
    if (status >= 500) return true;
  }
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('timeout')
    || message.includes('temporarily unavailable')
    || message.includes('network')
  );
}

async function verifyManagedIdentityJwt(
  token: string,
): Promise<ManagedIdentityEvaluation> {
  const tenantId = process.env.AZURE_TENANT_ID?.trim();
  const audiences = resolveAudienceCandidates();
  const allowedClients = resolveAllowedClientIds();
  if (!tenantId || audiences.length === 0 || allowedClients.length === 0) {
    return { result: 'invalid', reason: 'config_missing', transient: false };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { result: 'invalid', reason: 'jwt_format_invalid', transient: false };
  }

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeJwtPart(parts[0]);
    payload = decodeJwtPart(parts[1]);
  } catch {
    return { result: 'invalid', reason: 'jwt_decode_failed', transient: false };
  }

  if (header.alg !== 'RS256') {
    return { result: 'invalid', reason: 'jwt_alg_invalid', transient: false };
  }
  const expiresAt = Number(payload.exp);
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 <= Date.now()) {
    return { result: 'invalid', reason: 'jwt_expired', transient: false };
  }
  const tokenTenant = String(payload.tid || '');
  if (tokenTenant && tokenTenant !== tenantId) {
    return { result: 'invalid', reason: 'tenant_mismatch', transient: false };
  }
  if (!audienceMatches(payload.aud, audiences)) {
    return { result: 'invalid', reason: 'audience_mismatch', transient: false };
  }

  const appId = String(payload.appid || payload.azp || '');
  if (!appId || !allowedClients.includes(appId)) {
    return {
      result: 'invalid',
      reason: 'client_not_allowlisted',
      transient: false,
    };
  }

  const kid = typeof header.kid === 'string' ? header.kid : undefined;
  const evaluateSignature = (keys: Jwk[]): ManagedIdentityEvaluation | null => {
    const candidates = kid ? keys.filter((key) => key.kid === kid) : keys;
    if (candidates.length === 0) {
      return { result: 'invalid', reason: 'jwks_key_missing', transient: true };
    }
    const signatureValid = candidates.some((key) => {
      try {
        return verifyRs256(token, key);
      } catch {
        return false;
      }
    });
    if (!signatureValid) {
      return { result: 'invalid', reason: 'signature_invalid', transient: true };
    }
    if (!hasRequiredRole(payload.roles)) {
      return { result: 'forbidden', reason: 'role_missing', transient: false };
    }
    return { result: 'authorized', reason: 'authorized', transient: false };
  };

  let keys: Jwk[];
  try {
    keys = await fetchJwks(tenantId);
  } catch (error) {
    return {
      result: 'invalid',
      reason: 'jwks_fetch_failed',
      transient: isTransientJwksFetchError(error),
    };
  }

  let evaluation = evaluateSignature(keys);
  if (evaluation && evaluation.result === 'authorized') return evaluation;
  if (evaluation && !evaluation.transient) return evaluation;

  try {
    const refreshedKeys = await fetchJwks(tenantId, true);
    evaluation = evaluateSignature(refreshedKeys);
  } catch (error) {
    return {
      result: 'invalid',
      reason: 'jwks_fetch_failed',
      transient: isTransientJwksFetchError(error),
    };
  }
  if (evaluation) return evaluation;
  return { result: 'invalid', reason: 'signature_invalid', transient: true };
}

async function delay(ms: number): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function logAiRunnerAuthRejection(details: {
  reason: string;
  transient?: boolean;
}): void {
  console.warn(JSON.stringify({
    event: 'AiRunnerAuthRejected',
    reason: details.reason,
    transient: details.transient === true,
  }));
}

export function requireAiRunnerAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  void (async () => {
    if (!authConfigured()) {
      res.status(503).json({
        error:
          'AI runner callback auth is not configured (set AI_RUNS_CALLBACK_TOKEN_AUDIENCE + AI_RUNS_RUNNER_ALLOWED_CLIENT_IDS, or AI_RUNS_RUNNER_CALLBACK_TOKEN for local/tests)',
        code: 'AI_RUNNER_AUTH_UNCONFIGURED',
      });
      return;
    }

    const token = parseBearer(req.header(AI_RUNNER_AUTH_HEADER));
    if (!token) {
      logAiRunnerAuthRejection({ reason: 'missing_bearer' });
      res.status(401).json({
        error: 'Invalid AI runner identity',
        code: 'AI_RUNNER_UNAUTHORIZED',
      });
      return;
    }

    const staticExpected = resolveStaticToken();
    if (staticExpected && staticTokenMatches(token, staticExpected)) {
      next();
      return;
    }
    if (staticExpected) {
      logAiRunnerAuthRejection({ reason: 'static_token_mismatch' });
    }

    try {
      let evaluation = await verifyManagedIdentityJwt(token);
      if (
        evaluation.result === 'invalid'
        && evaluation.transient
        && evaluation.reason === 'jwks_fetch_failed'
      ) {
        await delay(75);
        evaluation = await verifyManagedIdentityJwt(token);
      }
      if (evaluation.result === 'authorized') {
        next();
        return;
      }
      if (evaluation.result === 'forbidden') {
        logAiRunnerAuthRejection({ reason: evaluation.reason });
        res.status(403).json({
          error: `AI runner identity lacks ${REQUIRED_ROLE}`,
          code: 'AI_RUNNER_FORBIDDEN',
        });
        return;
      }
      logAiRunnerAuthRejection({
        reason: evaluation.reason,
        transient: evaluation.transient,
      });
    } catch {
      // Authentication failures intentionally collapse to the same 401 response.
      logAiRunnerAuthRejection({ reason: 'verification_exception', transient: true });
    }

    res.status(401).json({
      error: 'Invalid AI runner identity',
      code: 'AI_RUNNER_UNAUTHORIZED',
    });
  })().catch(next);
}

export function __resetAiRunnerAuthJwksCacheForTests(): void {
  jwksByTenant.clear();
}
