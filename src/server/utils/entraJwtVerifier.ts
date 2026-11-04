/**
 * Shared Entra ID managed-identity JWT verification utility (FEAT-013, S2).
 * Extracted from `loadTestRunnerAuth.ts` so internal callback middlewares share one implementation.
 */
import { createPublicKey, verify as cryptoVerify } from 'crypto';

export type Jwk = {
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

export function parseBearerToken(header: string | undefined): string | null {
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

export async function verifyEntraManagedIdentityJwt(
  token: string,
  options: {
    tenantId?: string;
    audiences: string[];
    allowedClientIds: string[];
  },
): Promise<boolean> {
  const tenantId = options.tenantId?.trim() || process.env.AZURE_TENANT_ID?.trim();
  const { audiences, allowedClientIds } = options;
  if (!tenantId || audiences.length === 0 || allowedClientIds.length === 0) {
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
  if (!appId || !allowedClientIds.includes(appId)) return false;

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

export function clearEntraJwksCache(): void {
  jwksByTenant.clear();
}
