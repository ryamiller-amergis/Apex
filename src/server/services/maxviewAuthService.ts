import http from 'http';
import https from 'https';

/**
 * MaxView authentication service.
 *
 * The MaxView timecard-debug MCP server (`POST /mcp` on Maxim.TimeClock.Web) is
 * behind `AuthPolicy.Api` and expects a bearer token (RS256 AppToken). That token
 * is minted through the legacy UAM login flow, exactly mirroring the Postman
 * "0. Auth" folder:
 *   1. GET  /                — scrape the `__RequestVerificationToken` antiforgery
 *                              field and capture the antiforgery cookie.
 *   2. POST /                — form login with username/password + antiforgery token;
 *                              yields the `.AspNetCore.Cookies` auth cookie.
 *   3. GET  /api/auth/token  — mint the RS256 app token using the auth cookie.
 *
 * Tokens expire, so this service caches the token until shortly before its `exp`
 * claim and refreshes on demand (the proxy forces a refresh on a 401/403 from
 * upstream). A single shared service account is used for all Apex users — MaxView
 * scopes tool results to the token's data visibility, so the account must have the
 * MaxView-side `mcp-server` feature flag enabled.
 *
 * Configuration (all read from process.env):
 *   MAXVIEW_MCP_BASE_URL       — base URL of the MaxView web app (e.g. https://host)
 *   MAXVIEW_MCP_USERNAME       — service account username
 *   MAXVIEW_MCP_PASSWORD       — service account password
 *   MAXVIEW_MCP_TOKEN          — optional static bearer token (bypasses the login flow)
 *   MAXVIEW_MCP_INSECURE_TLS   — "true" to skip TLS cert validation (local dev self-signed only)
 */

const TOKEN_SAFETY_WINDOW_MS = 60_000;
const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

let cached: CachedToken | null = null;
let inflight: Promise<string> | null = null;

// ── Configuration helpers ────────────────────────────────────────────────────

/** True when enough env is present to authenticate (static token OR service creds). */
export function isMaxviewConfigured(): boolean {
  if (!process.env.MAXVIEW_MCP_BASE_URL) return false;
  if (process.env.MAXVIEW_MCP_TOKEN) return true;
  return Boolean(process.env.MAXVIEW_MCP_USERNAME && process.env.MAXVIEW_MCP_PASSWORD);
}

function baseUrl(): string {
  const b = process.env.MAXVIEW_MCP_BASE_URL;
  if (!b) throw new Error('MAXVIEW_MCP_BASE_URL is not set');
  return b.replace(/\/+$/, '');
}

/** In dev, MaxView often runs behind a self-signed cert; allow opting out of validation. */
export function maxviewRejectUnauthorized(): boolean {
  return process.env.MAXVIEW_MCP_INSECURE_TLS !== 'true';
}

// ── Pure helpers (exported for unit testing) ─────────────────────────────────

/** Scrape the ASP.NET antiforgery hidden field value from the login page HTML. */
export function extractAntiforgeryToken(html: string): string | null {
  const m = html.match(/__RequestVerificationToken[^>]*?value="([^"]+)"/);
  return m ? m[1] : null;
}

/** Parse Set-Cookie response headers into a simple name→value jar (ignores attributes). */
export function parseSetCookies(setCookie: string[] | undefined): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const cookie of setCookie ?? []) {
    const first = cookie.split(';', 1)[0] ?? '';
    const eq = first.indexOf('=');
    if (eq > 0) {
      jar[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
    }
  }
  return jar;
}

/** Serialize a cookie jar into a Cookie request header value. */
export function buildCookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/** `/api/auth/token` returns the token as a JSON-quoted string; strip the quotes. */
export function normalizeToken(raw: string): string {
  return raw.replace(/^"+|"+$/g, '').trim();
}

/** Decode a JWT's `exp` claim to epoch milliseconds, or null if it can't be read. */
export function decodeJwtExpMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// ── Low-level HTTP ───────────────────────────────────────────────────────────

interface RawResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Minimal buffered HTTP(S) request. Redirects are NOT followed automatically so
 * the login POST can capture the auth cookie from its 302 response.
 */
function rawRequest(
  url: string,
  opts: { method: string; headers?: Record<string, string>; body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method,
        headers: opts.headers,
        ...(u.protocol === 'https:' ? { rejectUnauthorized: maxviewRejectUnauthorized() } : {}),
      },
      (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c as Buffer));
        r.on('end', () =>
          resolve({
            statusCode: r.statusCode ?? 0,
            headers: r.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── Login flow ───────────────────────────────────────────────────────────────

async function login(): Promise<string> {
  const base = baseUrl();
  const username = process.env.MAXVIEW_MCP_USERNAME;
  const password = process.env.MAXVIEW_MCP_PASSWORD;
  if (!username || !password) {
    throw new Error('MAXVIEW_MCP_USERNAME / MAXVIEW_MCP_PASSWORD are not set');
  }

  // 1. GET / — capture antiforgery cookie + hidden field
  const loginPage = await rawRequest(`${base}/`, { method: 'GET' });
  const jar = parseSetCookies(loginPage.headers['set-cookie'] as string[] | undefined);
  const antiforgery = extractAntiforgeryToken(loginPage.body);
  if (!antiforgery) {
    throw new Error('MaxView login: could not scrape __RequestVerificationToken from the login page');
  }

  // 2. POST / — legacy UAM form login
  const form = new URLSearchParams({
    Username: username,
    Password: password,
    __RequestVerificationToken: antiforgery,
  }).toString();
  const loginRes = await rawRequest(`${base}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(form)),
      Cookie: buildCookieHeader(jar),
    },
    body: form,
  });
  if ([400, 401, 403].includes(loginRes.statusCode)) {
    throw new Error(`MaxView login failed with status ${loginRes.statusCode}`);
  }
  Object.assign(jar, parseSetCookies(loginRes.headers['set-cookie'] as string[] | undefined));

  // 3. GET /api/auth/token — mint the RS256 app token
  const tokenRes = await rawRequest(`${base}/api/auth/token`, {
    method: 'GET',
    headers: { Accept: 'application/json', Cookie: buildCookieHeader(jar) },
  });
  if (tokenRes.statusCode !== 200) {
    throw new Error(`MaxView token request failed with status ${tokenRes.statusCode}`);
  }

  let token: string;
  try {
    const parsed = JSON.parse(tokenRes.body);
    token = typeof parsed === 'string' ? parsed : parsed?.token;
  } catch {
    token = tokenRes.body;
  }
  token = normalizeToken(token ?? '');
  if (!token || token.length < 10) {
    throw new Error('MaxView token request returned an empty/invalid token');
  }
  return token;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Return a valid MaxView bearer token, minting/refreshing as needed.
 * A static MAXVIEW_MCP_TOKEN, when set, is returned directly (no login flow).
 * Concurrent callers share a single in-flight login to avoid a token stampede.
 */
export async function getMaxviewToken(opts?: { forceRefresh?: boolean }): Promise<string> {
  const staticToken = process.env.MAXVIEW_MCP_TOKEN;
  if (staticToken) return staticToken.trim();

  const now = Date.now();
  if (!opts?.forceRefresh && cached && cached.expiresAtMs > now + TOKEN_SAFETY_WINDOW_MS) {
    return cached.token;
  }
  if (opts?.forceRefresh) cached = null;
  if (inflight) return inflight;

  inflight = (async () => {
    const token = await login();
    const expMs = decodeJwtExpMs(token);
    cached = { token, expiresAtMs: expMs ?? Date.now() + DEFAULT_TOKEN_TTL_MS };
    return token;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Test-only: clear the cached token + in-flight login. */
export function __resetMaxviewTokenCacheForTests(): void {
  cached = null;
  inflight = null;
}
