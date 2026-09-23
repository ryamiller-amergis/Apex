/**
 * Domain-separated HMAC tokens for interactive actor → App Service MCP proxy
 * calls. Bound to run / attempt / fence / server name / expiry.
 *
 * Key derivation (HKDF-SHA256):
 *   salt: apex-interactive-tool-proxy-v1
 *   info: run-bound-mcp
 *   IKM:  SESSION_SECRET (required; no fallback)
 */
import {
  createHmac,
  hkdfSync,
  timingSafeEqual,
} from 'node:crypto';

const HKDF_SALT = 'apex-interactive-tool-proxy-v1';
const HKDF_INFO = 'run-bound-mcp';

export type InteractiveToolProxyTokenClaims = Readonly<{
  runId: string;
  attemptId: string;
  dispatchMessageId: string;
  serverName: string;
  expiresAt: string;
}>;

export class InteractiveToolProxyTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InteractiveToolProxyTokenError';
  }
}

function requireSecret(secret: string | undefined): string {
  if (!secret?.trim()) {
    throw new InteractiveToolProxyTokenError(
      'SESSION_SECRET is required for interactive tool proxy tokens',
    );
  }
  return secret;
}

function deriveHmacKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from(HKDF_SALT, 'utf8'),
      Buffer.from(HKDF_INFO, 'utf8'),
      32,
    ),
  );
}

function canonicalJson(claims: InteractiveToolProxyTokenClaims): string {
  return JSON.stringify({
    attemptId: claims.attemptId,
    dispatchMessageId: claims.dispatchMessageId,
    expiresAt: claims.expiresAt,
    runId: claims.runId,
    serverName: claims.serverName,
  });
}

function toBase64Url(value: Buffer | string): string {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(value: string): Buffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (padded.length % 4)) % 4;
  return Buffer.from(`${padded}${'='.repeat(padLength)}`, 'base64');
}

export function issueInteractiveToolProxyToken(
  claims: InteractiveToolProxyTokenClaims,
  secret: string,
): string {
  const key = deriveHmacKey(requireSecret(secret));
  const payload = toBase64Url(canonicalJson(claims));
  const signature = createHmac('sha256', key)
    .update(payload)
    .digest();
  return `${payload}.${toBase64Url(signature)}`;
}

export function verifyInteractiveToolProxyToken(
  token: string,
  secret: string,
  now: Date | number = new Date(),
): InteractiveToolProxyTokenClaims {
  const key = deriveHmacKey(requireSecret(secret));
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new InteractiveToolProxyTokenError(
      'Invalid interactive tool proxy signature',
    );
  }
  const [payload, signaturePart] = parts;
  const expected = createHmac('sha256', key).update(payload).digest();
  let provided: Buffer;
  try {
    provided = fromBase64Url(signaturePart);
  } catch {
    throw new InteractiveToolProxyTokenError(
      'Invalid interactive tool proxy signature',
    );
  }
  if (
    provided.byteLength !== expected.byteLength ||
    !timingSafeEqual(provided, expected)
  ) {
    throw new InteractiveToolProxyTokenError(
      'Invalid interactive tool proxy signature',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(payload).toString('utf8'));
  } catch {
    throw new InteractiveToolProxyTokenError(
      'Invalid interactive tool proxy signature',
    );
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as InteractiveToolProxyTokenClaims).runId !== 'string' ||
    typeof (parsed as InteractiveToolProxyTokenClaims).attemptId !== 'string' ||
    typeof (parsed as InteractiveToolProxyTokenClaims).dispatchMessageId !==
      'string' ||
    typeof (parsed as InteractiveToolProxyTokenClaims).serverName !== 'string' ||
    typeof (parsed as InteractiveToolProxyTokenClaims).expiresAt !== 'string'
  ) {
    throw new InteractiveToolProxyTokenError(
      'Invalid interactive tool proxy signature',
    );
  }

  const claims = parsed as InteractiveToolProxyTokenClaims;
  // Re-encode and compare to reject key-order / extra-field tampering that
  // still verifies the HMAC of a non-canonical payload.
  const reissuedPayload = toBase64Url(canonicalJson(claims));
  if (reissuedPayload !== payload) {
    throw new InteractiveToolProxyTokenError(
      'Invalid interactive tool proxy signature',
    );
  }

  const expiresAtMs = Date.parse(claims.expiresAt);
  const nowMs = typeof now === 'number' ? now : now.getTime();
  if (!Number.isFinite(expiresAtMs) || nowMs >= expiresAtMs) {
    throw new InteractiveToolProxyTokenError(
      'Interactive tool proxy token expired',
    );
  }

  return claims;
}
