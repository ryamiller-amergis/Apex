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

async function fetchJwks(tenantId: string): Promise<Jwk[]> {
  const cached = jwksByTenant.get(tenantId);
  if (cached && Date.now() - cached.fetchedAtMs < JWKS_TTL_MS) {
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

async function verifyManagedIdentityJwt(token: string): Promise<ManagedIdentityResult> {
  const tenantId = process.env.AZURE_TENANT_ID?.trim();
  const audiences = resolveAudienceCandidates();
  const allowedClients = resolveAllowedClientIds();
  if (!tenantId || audiences.length === 0 || allowedClients.length === 0) {
    return 'invalid';
  }

  const parts = token.split('.');
  if (parts.length !== 3) return 'invalid';

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeJwtPart(parts[0]);
    payload = decodeJwtPart(parts[1]);
  } catch {
    return 'invalid';
  }

  if (header.alg !== 'RS256') return 'invalid';
  const expiresAt = Number(payload.exp);
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 <= Date.now()) return 'invalid';
  const tokenTenant = String(payload.tid || '');
  if (tokenTenant && tokenTenant !== tenantId) return 'invalid';
  if (!audienceMatches(payload.aud, audiences)) return 'invalid';

  const appId = String(payload.appid || payload.azp || '');
  if (!appId || !allowedClients.includes(appId)) return 'invalid';

  const keys = await fetchJwks(tenantId);
  const kid = typeof header.kid === 'string' ? header.kid : undefined;
  const candidates = kid ? keys.filter((key) => key.kid === kid) : keys;
  const signatureValid = candidates.some((key) => {
    try {
      return verifyRs256(token, key);
    } catch {
      return false;
    }
  });
  if (!signatureValid) return 'invalid';
  return hasRequiredRole(payload.roles) ? 'authorized' : 'forbidden';
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

    try {
      const result = await verifyManagedIdentityJwt(token);
      if (result === 'authorized') {
        next();
        return;
      }
      if (result === 'forbidden') {
        res.status(403).json({
          error: `AI runner identity lacks ${REQUIRED_ROLE}`,
          code: 'AI_RUNNER_FORBIDDEN',
        });
        return;
      }
    } catch {
      // Authentication failures intentionally collapse to the same 401 response.
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
