import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  PREBUILT_CONNECTORS,
  type DiscoveredMcpTool,
  type McpServerAuthMode,
  type PrebuiltProvider,
} from '../../shared/types/mcpServers';
import { McpServerError } from './mcpServerErrors';
import { assertResolvedPublicHttpsUrl } from './mcpServerOpenApi';

const PENDO_TOKEN_URL = 'https://app.pendo.io/oauth/v1/token';
const TOKEN_SCOPES = ['mcp:tools', 'read:me'];

export interface McpToolListing {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

export interface DiscoverDeps {
  fetchImpl?: typeof fetch;
  listTools?: (url: string, token: string) => Promise<McpToolListing[]>;
}

export interface StoredClientCredential {
  clientId: string;
  clientSecret: string;
}

export function parseStoredClientCredential(value: string): StoredClientCredential {
  try {
    const parsed = JSON.parse(value) as Partial<StoredClientCredential>;
    if (parsed.clientId && parsed.clientSecret) {
      return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
    }
  } catch {
    // A raw secret is not a service-account payload.
  }
  throw new McpServerError(
    400,
    'This connection has no service account',
    'CREDENTIAL_REQUIRED'
  );
}

export function encodeClientCredential(clientId: string, clientSecret: string): string {
  return JSON.stringify({ clientId, clientSecret });
}

function toDiscovered(tool: McpToolListing): DiscoveredMcpTool | null {
  if (!tool.name.trim()) return null;
  if (tool.annotations?.destructiveHint === true) return null;
  if (tool.annotations?.readOnlyHint === false) return null;
  return {
    name: tool.name,
    description: tool.description?.trim() || tool.name,
    readOnly: tool.annotations?.readOnlyHint === true,
    inputSchema: tool.inputSchema,
  };
}

async function mintPendoToken(
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch
): Promise<string> {
  await assertResolvedPublicHttpsUrl(PENDO_TOKEN_URL);
  let lastStatus = 0;
  for (const scope of TOKEN_SCOPES) {
    const response = await fetchImpl(PENDO_TOKEN_URL, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    lastStatus = response.status;
    if (!response.ok) continue;
    const body = (await response.json()) as { access_token?: unknown };
    if (typeof body.access_token === 'string' && body.access_token) {
      return body.access_token;
    }
  }
  throw new McpServerError(
    lastStatus === 401 ? 401 : 502,
    'Pendo did not accept the service account',
    'TEST_FAILED'
  );
}

async function defaultListTools(url: string, token: string): Promise<McpToolListing[]> {
  await assertResolvedPublicHttpsUrl(url);
  const client = new Client({ name: 'apex-mcp-servers', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
    },
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    return listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
      annotations: tool.annotations,
    }));
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function discoverMcpServerTools(
  input: {
    provider: PrebuiltProvider;
    clientId?: string;
    clientSecret: string;
  },
  deps: DiscoverDeps = {}
): Promise<DiscoveredMcpTool[]> {
  const connector = PREBUILT_CONNECTORS[input.provider];
  if (!connector.mcpUrl || connector.mcpAuth !== 'oauth-client') {
    const message = connector.mcpAuth === 'oauth-user'
      ? `${connector.label} lists its tools only after OAuth sign-in`
      : `${connector.label} does not publish an MCP tool list`;
    throw new McpServerError(400, message, 'TOOLS_UNAVAILABLE');
  }
  const clientId = input.clientId?.trim() ?? '';
  const clientSecret = input.clientSecret.trim();
  if (!clientId || !clientSecret) {
    throw new McpServerError(
      400,
      'A client id and client secret are required to load tools',
      'CREDENTIAL_REQUIRED'
    );
  }
  const token = await mintPendoToken(clientId, clientSecret, deps.fetchImpl ?? fetch);
  const listed = await (deps.listTools ?? defaultListTools)(connector.mcpUrl, token);
  return listed.flatMap((tool) => {
    const discovered = toDiscovered(tool);
    return discovered ? [discovered] : [];
  });
}

export async function callMcpServerTool(input: {
  mcpUrl: string;
  clientId: string;
  clientSecret: string;
  toolName: string;
  args: Record<string, unknown>;
}): Promise<string> {
  const token = await mintPendoToken(input.clientId, input.clientSecret, fetch);
  return callRemoteMcpTool({
    mcpUrl: input.mcpUrl,
    headers: { Authorization: `Bearer ${token}` },
    toolName: input.toolName,
    args: input.args,
  });
}

export interface RemoteMcpOAuthPending {
  state: string;
  codeVerifier: string;
  startedBy: string;
  createdAt: string;
}

export interface RemoteMcpOAuth {
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string[];
  returnOrigin?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  pending?: RemoteMcpOAuthPending;
}

export interface RemoteMcpCredential {
  kind: 'remote-mcp';
  headers: Record<string, string>;
  secrets: Record<string, string>;
  secretNames: string[];
  toolNames: string[];
  authMode: McpServerAuthMode;
  oauth?: RemoteMcpOAuth;
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const PLACEHOLDER = /\$\{([A-Za-z][A-Za-z0-9_]{0,40})\}/g;

export function buildRemoteMcpCredential(input: {
  headers?: Record<string, string>;
  secrets?: Array<{ name: string; value: string }>;
  toolNames?: string[];
  authMode?: McpServerAuthMode;
}): RemoteMcpCredential {
  if (
    input.headers !== undefined &&
    (typeof input.headers !== 'object' || input.headers === null || Array.isArray(input.headers))
  ) {
    throw new McpServerError(400, 'A header name or value is invalid', 'CREDENTIAL_REQUIRED');
  }
  if (input.secrets !== undefined && !Array.isArray(input.secrets)) {
    throw new McpServerError(400, 'A secret name or value is invalid', 'CREDENTIAL_REQUIRED');
  }
  if (input.toolNames !== undefined && !Array.isArray(input.toolNames)) {
    throw new McpServerError(400, 'A tool name is invalid', 'OPERATIONS_REQUIRED');
  }
  const headerEntries = Object.entries(input.headers ?? {});
  const secretEntries = input.secrets ?? [];
  const toolNames = input.toolNames ?? [];
  if (headerEntries.length > 20 || secretEntries.length > 20 || toolNames.length > 50) {
    throw new McpServerError(400, 'Too many headers, secrets, or tools', 'CREDENTIAL_REQUIRED');
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of headerEntries) {
    if (!HEADER_NAME.test(key) || typeof value !== 'string' || !value || value.length > 2000 || /[\r\n]/.test(value)) {
      throw new McpServerError(400, 'A header name or value is invalid', 'CREDENTIAL_REQUIRED');
    }
    headers[key] = value;
  }
  const secrets: Record<string, string> = {};
  const secretNames: string[] = [];
  for (const secret of secretEntries) {
    const name = secret?.name?.trim() ?? '';
    const value = secret?.value ?? '';
    if (!SECRET_NAME.test(name) || value.length > 4000 || /[\r\n]/.test(value)) {
      throw new McpServerError(400, 'A secret name or value is invalid', 'CREDENTIAL_REQUIRED');
    }
    if (secretNames.includes(name)) {
      throw new McpServerError(400, 'A secret name or value is invalid', 'CREDENTIAL_REQUIRED');
    }
    secretNames.push(name);
    if (value.trim()) secrets[name] = value.trim();
  }
  const authMode = input.authMode ?? (secretNames.length > 0 || headerEntries.length > 0 ? 'secret' : 'none');
  assertHeaderPlaceholders(headers, secretNames, authMode);
  const names = toolNames.map((name) => name.trim());
  if (names.some((name) => !name || name.length > 80 || /\s/.test(name))) {
    throw new McpServerError(400, 'A tool name is invalid', 'OPERATIONS_REQUIRED');
  }
  return { kind: 'remote-mcp', headers, secrets, secretNames, toolNames: names, authMode };
}

function assertHeaderPlaceholders(
  headers: Record<string, string>,
  secretNames: string[],
  authMode: McpServerAuthMode,
): void {
  for (const [key, value] of Object.entries(headers)) {
    if (authMode === 'oauth' && key.toLowerCase() === 'authorization') continue;
    for (const match of value.matchAll(PLACEHOLDER)) {
      if (!secretNames.includes(match[1])) {
        throw new McpServerError(400, `Missing secret ${match[1]}`, 'CREDENTIAL_REQUIRED');
      }
    }
  }
}

const SENSITIVE_HEADER = /authorization|api-key|token|secret|key/i;

export function publicRemoteHeaders(headers: Record<string, string>): Record<string, string> {
  const visible: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    visible[key] = value.includes('${') || !SENSITIVE_HEADER.test(key) ? value : '${REDACTED}';
  }
  return visible;
}

export function publicRemoteConfig(stored: RemoteMcpCredential): {
  headers: Record<string, string>;
  toolNames: string[];
  authMode: McpServerAuthMode;
  secretNames: string[];
  missingSecretNames: string[];
  oauthConnected: boolean;
} {
  return {
    headers: publicRemoteHeaders(stored.headers),
    toolNames: stored.toolNames,
    authMode: stored.authMode,
    secretNames: stored.secretNames,
    missingSecretNames: stored.secretNames.filter((name) => !stored.secrets[name]),
    oauthConnected: Boolean(stored.oauth?.accessToken || stored.oauth?.refreshToken),
  };
}

export function mergeRemoteMcpConfig(
  stored: RemoteMcpCredential,
  patch: {
    headers?: Record<string, string>;
    toolNames?: string[];
    authMode?: McpServerAuthMode;
    secrets?: Array<{ name: string; value: string }>;
    secretNames?: string[];
  },
): RemoteMcpCredential {
  const authMode = patch.authMode ?? stored.authMode;
  let secretNames = patch.secretNames
    ? patch.secretNames.map((name) => name.trim())
    : [...stored.secretNames];
  const secrets = { ...stored.secrets };
  if (patch.secrets) {
    for (const update of patch.secrets) {
      const name = update?.name?.trim() ?? '';
      const value = update?.value ?? '';
      if (!SECRET_NAME.test(name) || !value.trim() || value.length > 4000 || /[\r\n]/.test(value)) {
        throw new McpServerError(400, 'A secret name or value is invalid', 'CREDENTIAL_REQUIRED');
      }
      if (!secretNames.includes(name)) secretNames.push(name);
      secrets[name] = value.trim();
    }
  }
  secretNames = secretNames.filter((name, index) => SECRET_NAME.test(name) && secretNames.indexOf(name) === index);
  for (const name of Object.keys(secrets)) {
    if (!secretNames.includes(name)) delete secrets[name];
  }
  let headers = stored.headers;
  if (patch.headers) {
    const built = buildRemoteMcpCredential({
      headers: Object.fromEntries(Object.entries(patch.headers).map(([key, value]) => [
        key,
        value === '${REDACTED}' && stored.headers[key] ? stored.headers[key] : value,
      ])),
      secrets: secretNames.map((name) => ({ name, value: secrets[name] ?? '' })),
      authMode,
    });
    headers = built.headers;
  } else {
    assertHeaderPlaceholders(headers, secretNames, authMode);
  }
  const toolNames = patch.toolNames ?? stored.toolNames;
  if (toolNames.length > 50 || toolNames.some((name) => !name.trim() || name.length > 80 || /\s/.test(name))) {
    throw new McpServerError(400, 'A tool name is invalid', 'OPERATIONS_REQUIRED');
  }
  return {
    ...stored,
    headers,
    secrets,
    secretNames,
    toolNames: toolNames.map((name) => name.trim()),
    authMode,
    oauth: patch.authMode !== undefined && patch.authMode !== stored.authMode ? undefined : stored.oauth,
  };
}

export function applyRemoteMcpSecrets(
  stored: RemoteMcpCredential,
  updates: Array<{ name: string; value: string }>
): RemoteMcpCredential {
  const secrets = { ...stored.secrets };
  const secretNames = [...stored.secretNames];
  for (const update of updates) {
    const name = update?.name?.trim() ?? '';
    const value = update?.value ?? '';
    if (!SECRET_NAME.test(name) || !value.trim() || value.length > 4000 || /[\r\n]/.test(value)) {
      throw new McpServerError(400, 'A secret name or value is invalid', 'CREDENTIAL_REQUIRED');
    }
    if (!secretNames.includes(name)) {
      throw new McpServerError(400, `That secret is not on this server`, 'CREDENTIAL_REQUIRED');
    }
    secrets[name] = value.trim();
  }
  return { ...stored, secrets, secretNames };
}

export function encodeRemoteMcpCredential(value: RemoteMcpCredential): string {
  return JSON.stringify(value);
}

export function parseRemoteMcpCredential(value: string): RemoteMcpCredential | null {
  try {
    const parsed = JSON.parse(value) as Partial<RemoteMcpCredential>;
    if (parsed.kind !== 'remote-mcp' || !parsed.headers || !parsed.secrets) return null;
    const secretNames = Array.isArray(parsed.secretNames) && parsed.secretNames.length > 0
      ? parsed.secretNames
      : Object.keys(parsed.secrets);
    const authMode = parsed.authMode === 'none' || parsed.authMode === 'secret' || parsed.authMode === 'oauth'
      ? parsed.authMode
      : secretNames.length > 0 || Object.keys(parsed.headers).length > 0
        ? 'secret'
        : 'none';
    return {
      kind: 'remote-mcp',
      headers: parsed.headers,
      secrets: parsed.secrets,
      secretNames,
      toolNames: Array.isArray(parsed.toolNames) ? parsed.toolNames : [],
      authMode,
      oauth: parsed.oauth && typeof parsed.oauth === 'object' ? parsed.oauth : undefined,
    };
  } catch {
    return null;
  }
}

export function resolveRemoteMcpHeaders(stored: RemoteMcpCredential): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(stored.headers)) {
    if (stored.authMode === 'oauth' && key.toLowerCase() === 'authorization') continue;
    const resolved = value.replace(PLACEHOLDER, (_match, name: string) => {
      const secret = stored.secrets[name];
      if (secret === undefined) {
        throw new McpServerError(400, `Missing secret ${name}`, 'CREDENTIAL_REQUIRED');
      }
      return secret;
    });
    if (resolved.includes('${')) {
      throw new McpServerError(400, 'A header still contains an unresolved secret', 'CREDENTIAL_REQUIRED');
    }
    headers[key] = resolved;
  }
  if (stored.authMode === 'oauth') {
    if (!stored.oauth?.accessToken) {
      throw new McpServerError(400, 'Sign in with OAuth before using this server', 'OAUTH_REQUIRED');
    }
    headers.Authorization = `Bearer ${stored.oauth.accessToken}`;
  }
  return headers;
}

async function listToolsWithHeaders(
  url: string,
  headers: Record<string, string>
): Promise<McpToolListing[]> {
  await assertResolvedPublicHttpsUrl(url);
  const client = new Client({ name: 'apex-mcp-servers', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers, redirect: 'error' },
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    return listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
      annotations: tool.annotations,
    }));
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function discoverRemoteMcpTools(
  input: { url: string; headers: Record<string, string> },
  deps: { listTools?: (url: string, headers: Record<string, string>) => Promise<McpToolListing[]> } = {}
): Promise<DiscoveredMcpTool[]> {
  const listed = await (deps.listTools ?? listToolsWithHeaders)(input.url, input.headers);
  return listed.flatMap((tool) => {
    const discovered = toDiscovered(tool);
    return discovered ? [discovered] : [];
  });
}

const WARM_CLIENT_IDLE_MS = 60_000;

interface WarmMcpClientEntry {
  clientPromise: Promise<Client>;
  timer: ReturnType<typeof setTimeout>;
}

const warmMcpClients = new Map<string, WarmMcpClientEntry>();

function warmClientCacheKey(mcpUrl: string, headers: Record<string, string>): string {
  const sortedHeaders = Object.entries(headers).sort(([a], [b]) => a.localeCompare(b));
  return `${mcpUrl}::${JSON.stringify(sortedHeaders)}`;
}

function evictWarmClient(key: string): void {
  const existing = warmMcpClients.get(key);
  if (!existing) return;
  warmMcpClients.delete(key);
  clearTimeout(existing.timer);
  void existing.clientPromise
    .then((client) => client.close())
    .catch(() => undefined);
}

function scheduleWarmClientExpiry(key: string): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    evictWarmClient(key);
  }, WARM_CLIENT_IDLE_MS);
  timer.unref?.();
  return timer;
}

async function acquireWarmMcpClient(
  mcpUrl: string,
  headers: Record<string, string>,
): Promise<{ key: string; client: Client }> {
  const key = warmClientCacheKey(mcpUrl, headers);
  const cached = warmMcpClients.get(key);
  if (cached) {
    clearTimeout(cached.timer);
    cached.timer = scheduleWarmClientExpiry(key);
    try {
      return { key, client: await cached.clientPromise };
    } catch {
      evictWarmClient(key);
    }
  }
  await assertResolvedPublicHttpsUrl(mcpUrl);
  const clientPromise = (async () => {
    const client = new Client({ name: 'apex-mcp-servers', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers, redirect: 'error' },
    });
    await client.connect(transport);
    return client;
  })();
  warmMcpClients.set(key, {
    clientPromise,
    timer: scheduleWarmClientExpiry(key),
  });
  try {
    return { key, client: await clientPromise };
  } catch (err) {
    evictWarmClient(key);
    throw err;
  }
}

export async function callRemoteMcpTool(input: {
  mcpUrl: string;
  headers: Record<string, string>;
  toolName: string;
  args: Record<string, unknown>;
}): Promise<string> {
  const first = await acquireWarmMcpClient(input.mcpUrl, input.headers);
  try {
    const result = await first.client.callTool({
      name: input.toolName,
      arguments: input.args,
    });
    return JSON.stringify(result);
  } catch {
    evictWarmClient(first.key);
    const retry = await acquireWarmMcpClient(input.mcpUrl, input.headers);
    const result = await retry.client.callTool({
      name: input.toolName,
      arguments: input.args,
    });
    return JSON.stringify(result);
  }
}
