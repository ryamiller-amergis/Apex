import crypto from 'crypto';
import type { Request } from 'express';

/* ── Agent tokens ────────────────────────────────────────────────────────
   Short-lived HMAC-signed tokens that let the Cursor agent (running on the
   user's local machine) make authenticated requests to two specific
   endpoints WITHOUT a browser session cookie:

     - GET  /api/backlog/mock-html/:featureId   (scope: 'read-mock')
     - POST /api/backlog/update-figma-url       (scope: 'write-figma-url')

   Tokens are bound to a specific featureId/pbiId so a leaked token only
   grants access to that one resource. Tokens expire (default 60 min).

   Wire format: <base64url(payload)>.<base64url(hmacSig)>
   Payload:     { scope, featureId, pbiId?, exp }   (JSON; exp = unix seconds)

   The signing secret is read from BACKLOG_AGENT_SIGNING_SECRET. In dev a
   fallback secret is used (with a one-time warning) so the local flow
   still works without extra setup; production should always set the env
   var to a 256-bit random hex string.
──────────────────────────────────────────────────────────────────────────── */

export type AgentTokenScope = 'read-mock' | 'write-figma-url';

export interface AgentTokenClaims {
  scope: AgentTokenScope;
  featureId: string;
  pbiId?: string;
  exp: number;
}

const DEFAULT_TTL_SECONDS = 60 * 60;
const DEV_FALLBACK_SECRET = 'dev-insecure-agent-token-secret-do-not-use-in-prod';

let warnedAboutFallback = false;
function getSecret(): string {
  const s = process.env.BACKLOG_AGENT_SIGNING_SECRET;
  if (s && s.length >= 16) return s;
  if (!warnedAboutFallback) {
    console.warn(
      '[agent-tokens] BACKLOG_AGENT_SIGNING_SECRET is not set (or is too short). ' +
      'Using insecure dev fallback. DO NOT deploy to production without setting this ' +
      'to a 256-bit random hex string.'
    );
    warnedAboutFallback = true;
  }
  return DEV_FALLBACK_SECRET;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function unb64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export interface SignAgentTokenInput {
  scope: AgentTokenScope;
  featureId: string;
  pbiId?: string;
  /** Override the default 60-minute TTL. */
  ttlSeconds?: number;
}

export function signAgentToken(input: SignAgentTokenInput): string {
  const exp = Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const payload: AgentTokenClaims = {
    scope: input.scope,
    featureId: input.featureId,
    ...(input.pbiId ? { pbiId: input.pbiId } : {}),
    exp,
  };
  const payloadEncoded = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = crypto
    .createHmac('sha256', getSecret())
    .update(payloadEncoded)
    .digest();
  return `${payloadEncoded}.${b64url(sig)}`;
}

export function verifyAgentToken(token: string | undefined | null): AgentTokenClaims | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadEncoded, sigEncoded] = parts;
  if (!payloadEncoded || !sigEncoded) return null;

  let provided: Buffer;
  try {
    provided = unb64url(sigEncoded);
  } catch {
    return null;
  }

  const expected = crypto
    .createHmac('sha256', getSecret())
    .update(payloadEncoded)
    .digest();

  if (expected.length !== provided.length) return null;
  if (!crypto.timingSafeEqual(expected, provided)) return null;

  let payload: AgentTokenClaims;
  try {
    payload = JSON.parse(unb64url(payloadEncoded).toString('utf8')) as AgentTokenClaims;
  } catch {
    return null;
  }

  if (payload.scope !== 'read-mock' && payload.scope !== 'write-figma-url') return null;
  if (typeof payload.featureId !== 'string' || !payload.featureId) return null;
  if (payload.pbiId !== undefined && typeof payload.pbiId !== 'string') return null;
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload;
}

/** Pulls a token from the request: ?token=… query param OR X-Agent-Token header. */
export function extractAgentToken(req: Request): string | null {
  const headerToken = req.header('x-agent-token');
  if (typeof headerToken === 'string' && headerToken) return headerToken;
  const queryToken = (req.query as Record<string, unknown> | undefined)?.token;
  if (typeof queryToken === 'string' && queryToken) return queryToken;
  return null;
}

/** Maps a request path (relative to /api) to the scope that should authorize it. */
export function expectedScopeForPath(path: string): AgentTokenScope | null {
  if (path.startsWith('/backlog/mock-html')) return 'read-mock';
  if (path.startsWith('/backlog/update-figma-url')) return 'write-figma-url';
  return null;
}
