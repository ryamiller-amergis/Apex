import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { McpServerError } from './mcpServerErrors';
import type { RemoteMcpCredential, RemoteMcpOAuth } from './mcpServerDiscovery';
import { assertResolvedPublicHttpsUrl } from './mcpServerOpenApi';

const SCOPE_NAME = /^[A-Za-z0-9_.:-]{1,80}$/;
const PENDING_MS = 10 * 60 * 1000;

export interface OAuthResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type OAuthFetch = (url: string, init?: RequestInit) => Promise<OAuthResponse>;

export interface DiscoveredMcpOAuth {
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopes: string[];
  usePublicClient: boolean;
}

export function safeAppOrigin(value: string | null | undefined, allowedHost?: string): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== value || url.username || url.password) return null;
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return url.origin;
  }
  const host = allowedHost?.split(',')[0].trim();
  if (url.protocol === 'https:' && host && url.host === host) return url.origin;
  return null;
}

export function devAppOrigin(host: string | undefined): string | null {
  if (process.env.NODE_ENV === 'production') return null;
  const apiPort = String(process.env.PORT || 3001);
  const match = /^(localhost|127\.0\.0\.1):(\d+)$/.exec(host ?? '');
  if (!match || match[2] !== apiPort) return null;
  return `http://${match[1]}:3000`;
}

export function parseResourceMetadataUrl(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/resource_metadata=(?:"([^"]+)"|([^\s,]+))/i);
  const value = match?.[1] ?? match?.[2];
  if (!value || !value.startsWith('https://')) return null;
  return value;
}

export function wellKnownResourceMetadataUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
}

export function authorizationServerMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, '');
  return `${url.origin}/.well-known/oauth-authorization-server${path}`;
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildOAuthAuthorizationUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  resource: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  url.searchParams.set('resource', input.resource);
  if (input.scopes.length > 0) url.searchParams.set('scope', input.scopes.join(' '));
  return url.toString();
}

export function assertOAuthPending(
  oauth: RemoteMcpOAuth | undefined,
  input: { state: string; userId: string; now?: Date },
): { codeVerifier: string } {
  const pending = oauth?.pending;
  if (!pending) {
    throw new McpServerError(400, 'This sign-in has expired. Start it again.', 'OAUTH_REQUIRED');
  }
  if (pending.startedBy !== input.userId) {
    throw new McpServerError(403, 'This sign-in was started by someone else.', 'NOT_ALLOWED');
  }
  const age = (input.now ?? new Date()).getTime() - Date.parse(pending.createdAt);
  if (!Number.isFinite(age) || age > PENDING_MS || age < -60_000) {
    throw new McpServerError(400, 'This sign-in has expired. Start it again.', 'OAUTH_REQUIRED');
  }
  const expected = Buffer.from(pending.state);
  const received = Buffer.from(input.state);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new McpServerError(400, 'This sign-in could not be verified.', 'OAUTH_REQUIRED');
  }
  return { codeVerifier: pending.codeVerifier };
}

export function oauthAccessExpired(oauth: RemoteMcpOAuth, now = Date.now()): boolean {
  if (!oauth.expiresAt) return false;
  const expires = Date.parse(oauth.expiresAt);
  return !Number.isFinite(expires) || expires - now < 60_000;
}

export async function discoverMcpOAuth(
  mcpUrl: string,
  fetchImpl: OAuthFetch = fetch,
): Promise<DiscoveredMcpOAuth> {
  await assertResolvedPublicHttpsUrl(mcpUrl);
  const probe = await fetchImpl(mcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    redirect: 'error',
  });
  const metadataUrl = parseResourceMetadataUrl(probe.headers.get('www-authenticate'))
    ?? wellKnownResourceMetadataUrl(mcpUrl);
  const metadata = await readJsonRecord(metadataUrl, fetchImpl);
  const resource = stringField(metadata, 'resource') ?? mcpUrl;
  const authorizationServers = Array.isArray(metadata.authorization_servers)
    ? metadata.authorization_servers.filter((item): item is string => typeof item === 'string' && item.startsWith('https://'))
    : [];
  if (authorizationServers.length === 0) {
    throw new McpServerError(502, 'This server did not offer OAuth sign-in.', 'OAUTH_REQUIRED');
  }
  const server = await readJsonRecord(authorizationServerMetadataUrl(authorizationServers[0]), fetchImpl);
  const authorizationEndpoint = stringField(server, 'authorization_endpoint');
  const tokenEndpoint = stringField(server, 'token_endpoint');
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new McpServerError(502, 'This server did not offer OAuth sign-in.', 'OAUTH_REQUIRED');
  }
  const methods = Array.isArray(server.code_challenge_methods_supported)
    ? server.code_challenge_methods_supported
    : [];
  if (methods.length > 0 && !methods.includes('S256')) {
    throw new McpServerError(502, 'This server does not support the required OAuth challenge.', 'OAUTH_REQUIRED');
  }
  const authMethods = Array.isArray(server.token_endpoint_auth_methods_supported)
    ? server.token_endpoint_auth_methods_supported.filter((item): item is string => typeof item === 'string')
    : ['none'];
  await assertResolvedPublicHttpsUrl(authorizationEndpoint);
  await assertResolvedPublicHttpsUrl(tokenEndpoint);
  const registrationEndpoint = stringField(server, 'registration_endpoint');
  if (registrationEndpoint) await assertResolvedPublicHttpsUrl(registrationEndpoint);
  return {
    resource,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint,
    scopes: readScopes(metadata.scopes_supported),
    usePublicClient: authMethods.includes('none'),
  };
}

export async function registerOAuthClient(
  discovered: DiscoveredMcpOAuth,
  redirectUri: string,
  fetchImpl: OAuthFetch = fetch,
): Promise<{ clientId: string; clientSecret?: string }> {
  if (!discovered.registrationEndpoint) {
    throw new McpServerError(502, 'This server does not let Apex register an OAuth client.', 'OAUTH_REQUIRED');
  }
  const response = await fetchImpl(discovered.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Apex',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: discovered.usePublicClient ? 'none' : 'client_secret_post',
      scope: discovered.scopes.join(' '),
    }),
    redirect: 'error',
  });
  const body = await parseJson(response);
  const record = asRecord(body);
  const clientId = record ? stringField(record, 'client_id') : undefined;
  if (!clientId || response.status < 200 || response.status >= 300) {
    throw new McpServerError(502, 'Apex could not register with this OAuth server.', 'OAUTH_REQUIRED');
  }
  const clientSecret = record ? stringField(record, 'client_secret') : undefined;
  return { clientId, clientSecret };
}

export async function exchangeAuthorizationCode(
  oauth: RemoteMcpOAuth,
  code: string,
  codeVerifier: string,
  fetchImpl: OAuthFetch = fetch,
): Promise<Pick<RemoteMcpOAuth, 'accessToken' | 'refreshToken' | 'expiresAt'>> {
  return requestToken(oauth, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: oauth.redirectUri,
    code_verifier: codeVerifier,
    client_id: oauth.clientId,
    resource: oauth.resource,
  }, fetchImpl);
}

export async function refreshOAuthTokens(
  oauth: RemoteMcpOAuth,
  fetchImpl: OAuthFetch = fetch,
): Promise<Pick<RemoteMcpOAuth, 'accessToken' | 'refreshToken' | 'expiresAt'>> {
  if (!oauth.refreshToken) {
    throw new McpServerError(400, 'Sign in with OAuth again.', 'OAUTH_REQUIRED');
  }
  return requestToken(oauth, {
    grant_type: 'refresh_token',
    refresh_token: oauth.refreshToken,
    client_id: oauth.clientId,
    resource: oauth.resource,
  }, fetchImpl);
}

export async function ensureFreshOAuthCredential(
  stored: RemoteMcpCredential,
  fetchImpl: OAuthFetch = fetch,
): Promise<RemoteMcpCredential> {
  if (stored.authMode !== 'oauth' || !stored.oauth) return stored;
  if (!oauthAccessExpired(stored.oauth)) return stored;
  const tokens = await refreshOAuthTokens(stored.oauth, fetchImpl);
  return {
    ...stored,
    oauth: {
      ...stored.oauth,
      ...tokens,
      pending: undefined,
    },
  };
}

async function requestToken(
  oauth: RemoteMcpOAuth,
  fields: Record<string, string>,
  fetchImpl: OAuthFetch,
): Promise<Pick<RemoteMcpOAuth, 'accessToken' | 'refreshToken' | 'expiresAt'>> {
  await assertResolvedPublicHttpsUrl(oauth.tokenEndpoint);
  const body = new URLSearchParams(fields);
  if (oauth.clientSecret) body.set('client_secret', oauth.clientSecret);
  const response = await fetchImpl(oauth.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
    redirect: 'error',
  });
  const parsed = asRecord(await parseJson(response));
  const accessToken = parsed ? stringField(parsed, 'access_token') : undefined;
  if (!accessToken || response.status < 200 || response.status >= 300) {
    throw new McpServerError(502, 'The OAuth token request failed.', 'OAUTH_REQUIRED');
  }
  const refreshToken = parsed ? stringField(parsed, 'refresh_token') : oauth.refreshToken;
  const expiresIn = parsed && typeof parsed.expires_in === 'number' ? parsed.expires_in : undefined;
  return {
    accessToken,
    refreshToken,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
  };
}

async function readJsonRecord(url: string, fetchImpl: OAuthFetch): Promise<Record<string, unknown>> {
  await assertResolvedPublicHttpsUrl(url);
  const response = await fetchImpl(url, { method: 'GET', redirect: 'error' });
  const record = asRecord(await parseJson(response));
  if (!record || response.status < 200 || response.status >= 300) {
    throw new McpServerError(502, 'This server did not offer OAuth sign-in.', 'OAUTH_REQUIRED');
  }
  return record;
}

async function parseJson(response: OAuthResponse): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && SCOPE_NAME.test(item)).slice(0, 20);
}
