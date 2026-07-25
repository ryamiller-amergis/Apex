/**
 * Runner callback auth for load-test ingest (FEAT-007 / A-009 / PBI-009 AC-1).
 * Human session RBAC is NOT a substitute for callback identity.
 *
 * Accepted credentials (either is enough):
 * 1. Managed-identity AAD access token (preferred in Azure)
 *    - Runner acquires token for LT_CALLBACK_TOKEN_AUDIENCE (or api://AZURE_CLIENT_ID)
 *    - Server verifies JWT via Entra JWKS and requires appid/azp ∈ LT_RUNNER_ALLOWED_CLIENT_IDS
 * 2. Static shared secret LT_RUNNER_CALLBACK_TOKEN (local/tests only; optional)
 */
import { createPublicKey, verify as cryptoVerify } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

export const LOAD_TEST_RUNNER_AUTH_HEADER = 'authorization';

type Jwk = {
  kid?: string;
  kty: string;
  n?: string;
  e?: string;
  x5c?: string[];
};

type JwksCache = {
  keys: Jwk[];
  fetchedAtMs: number;
};

const JWKS_TTL_MS = 60 * 60 * 1000;
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
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveAudienceCandidates(): string[] {
  const explicit =
    process.env.LT_CALLBACK_TOKEN_AUDIENCE?.trim() ||
    process.env.APEX_API_APP_ID_URI?.trim();
  if (explicit) {
    return [explicit.replace(/\/\.default$/i, '')];
  }
  const clientId = process.env.AZURE_CLIENT_ID?.trim();
  if (clientId) {
    return [`api://${clientId}`, clientId];
  }
  return [];
}

function resolveAllowedClientIds(): string[] {
  return csvEnv('LT_RUNNER_ALLOWED_CLIENT_IDS');
}

function authConfigured(): boolean {
  const staticToken = process.env.LT_RUNNER_CALLBACK_TOKEN?.trim();
  return Boolean(staticToken) || (resolveAudienceCandidates().length > 0 && resolveAllowedClientIds().length > 0);
}

async function fetchJwks(tenantId: string): Promise<Jwk[]> {
  const cached = jwksByTenant.get(tenantId);
  if (cached && Date.now() - cached.fetchedAtMs < JWKS_TTL_MS) {
    return cached.keys;
  }
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/discovery/v2.0/keys`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch Entra JWKS (${res.status})`);
  }
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = body.keys || [];
  jwksByTenant.set(tenantId, { keys, fetchedAtMs: Date.now() });
  return keys;
}

function verifyRs256(token: string, jwk: Jwk): boolean {
  const [headerB64, payloadB64, signatureB64] = token.split('.');
  if (!headerB64 || !payloadB64 || !signatureB64) return false;
  const keyObject = createPublicKey({ key: jwk as any, format: 'jwk' });
  return cryptoVerify(
    'RSA-SHA256',
    Buffer.from(`${headerB64}.${payloadB64}`),
    keyObject,
    base64UrlToBuffer(signatureB64),
  );
}

function audienceMatches(claimAud: unknown, allowed: string[]): boolean {
  const values = Array.isArray(claimAud)
    ? claimAud.map(String)
    : claimAud != null
      ? [String(claimAud)]
      : [];
  return values.some((aud) =>
    allowed.some(
      (a) =>
        aud === a ||
        aud === a.replace(/^api:\/\//, '') ||
        `api://${aud}` === a,
    ),
  );
}

async function verifyManagedIdentityJwt(token: string): Promise<boolean> {
  const tenantId = process.env.AZURE_TENANT_ID?.trim();
  const audiences = resolveAudienceCandidates();
  const allowedClients = resolveAllowedClientIds();
  if (!tenantId || audiences.length === 0 || allowedClients.length === 0) {
    return false;
  }

  const parts = token.split('.');
  if (parts.length !== 3) return false;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeJwtPart(parts[0]);
    payload = decodeJwtPart(parts[1]);
  } catch {
    return false;
  }

  if (header.alg !== 'RS256') return false;
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return false;

  const tid = String(payload.tid || '');
  if (tid && tid !== tenantId) return false;
  if (!audienceMatches(payload.aud, audiences)) return false;

  const appId = String(payload.appid || payload.azp || '');
  if (!appId || !allowedClients.includes(appId)) return false;

  const keys = await fetchJwks(tenantId);
  const kid = typeof header.kid === 'string' ? header.kid : undefined;
  const candidates = kid ? keys.filter((k) => k.kid === kid) : keys;
  return candidates.some((k) => {
    try {
      return verifyRs256(token, k);
    } catch {
      return false;
    }
  });
}

/**
 * Express middleware — validates runner Bearer token (MI JWT preferred, static optional).
 */
export function requireLoadTestRunnerAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  void (async () => {
    if (!authConfigured()) {
      res.status(503).json({
        error:
          'Load-test runner callback auth is not configured (set LT_CALLBACK_TOKEN_AUDIENCE + LT_RUNNER_ALLOWED_CLIENT_IDS, or LT_RUNNER_CALLBACK_TOKEN for local/tests)',
        code: 'LOAD_TEST_RUNNER_AUTH_UNCONFIGURED',
      });
      return;
    }

    const token = parseBearer(req.header(LOAD_TEST_RUNNER_AUTH_HEADER));
    if (!token) {
      res.status(401).json({
        error: 'Invalid load-test runner identity',
        code: 'LOAD_TEST_RUNNER_UNAUTHORIZED',
      });
      return;
    }

    const staticExpected = process.env.LT_RUNNER_CALLBACK_TOKEN?.trim();
    if (staticExpected && token === staticExpected) {
      next();
      return;
    }

    // Prefer MI JWT when allowed-client list is configured.
    if (resolveAllowedClientIds().length > 0 && resolveAudienceCandidates().length > 0) {
      try {
        if (await verifyManagedIdentityJwt(token)) {
          next();
          return;
        }
      } catch {
        // fall through to 401
      }
    }

    res.status(401).json({
      error: 'Invalid load-test runner identity',
      code: 'LOAD_TEST_RUNNER_UNAUTHORIZED',
    });
  })().catch(next);
}

/** Test helper — clear JWKS cache between cases. */
export function __resetLoadTestRunnerAuthJwksCacheForTests(): void {
  jwksByTenant.clear();
}
