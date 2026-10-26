import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { mcpServers } from '../db/schema';
import {
  PREBUILT_CONNECTORS,
  PREBUILT_PROVIDER_IDS,
  type CreateMcpServerRequest,
  type DiscoveredMcpTool,
  type McpServerConnectionPublic,
  type McpServerOperation,
  type McpServerProvider,
  type PrebuiltProvider,
  type UpdateMcpServerRequest,
  toolInputsFromSchema,
} from '../../shared/types/mcpServers';
import {
  decryptMcpServerCredential,
  encryptMcpServerCredential,
  maskMcpServerCredential,
  type EncryptedMcpServerCredential,
} from './mcpServerCredentialCrypto';
import { McpServerError } from './mcpServerErrors';
import {
  buildRemoteMcpCredential,
  discoverMcpServerTools,
  discoverRemoteMcpTools,
  encodeClientCredential,
  encodeRemoteMcpCredential,
  mergeRemoteMcpConfig,
  parseRemoteMcpCredential,
  parseStoredClientCredential,
  publicRemoteConfig,
  resolveRemoteMcpHeaders,
  type RemoteMcpCredential,
} from './mcpServerDiscovery';
import {
  assertOAuthPending,
  buildOAuthAuthorizationUrl,
  createPkcePair,
  discoverMcpOAuth,
  ensureFreshOAuthCredential,
  exchangeAuthorizationCode,
  registerOAuthClient,
  type OAuthFetch,
} from './mcpServerOAuth';
import { getMcpServerFetchStub } from './mcpServerFetchStub';
import {
  assertMcpServerBaseUrl,
  assertResolvedPublicHttpsUrl,
  assertReadOnlyOperations,
  importOpenApiOperations,
  joinMcpServerUrl,
} from './mcpServerOpenApi';

export interface McpServerFetchInit {
  method: string;
  headers: Record<string, string>;
}

export interface McpServerFetchResult {
  status: number;
  body: string;
}

export type McpServerFetch = (
  url: string,
  init: McpServerFetchInit
) => Promise<McpServerFetchResult>;

interface ConnectionRow {
  id: string;
  project: string;
  name: string;
  provider: McpServerProvider;
  status: 'untested' | 'usable';
  credentialCiphertext: string;
  credentialIv: string;
  credentialAuthTag: string;
  credentialHint: string;
  baseUrl: string | null;
  operations: McpServerOperation[];
  allowedUserIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastTestedAt: string | null;
}

const RESPONSE_LIMIT_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 10_000;

export async function defaultMcpServerFetch(
  url: string,
  init: McpServerFetchInit
): Promise<McpServerFetchResult> {
  if (process.env.E2E_MODE === 'true') {
    const stub = getMcpServerFetchStub();
    if (!stub) {
      throw new McpServerError(
        502,
        'Integration provider stub is not configured',
        'STUB_REQUIRED'
      );
    }
    return stub(url, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    await assertResolvedPublicHttpsUrl(url);
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
    });
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > RESPONSE_LIMIT_BYTES) {
      throw new McpServerError(
        502,
        'Integration response is too large',
        'RESPONSE_TOO_LARGE'
      );
    }
    return { status: response.status, body };
  } catch (err) {
    if (err instanceof McpServerError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new McpServerError(
        504,
        'Integration request timed out',
        'REQUEST_TIMEOUT'
      );
    }
    throw new McpServerError(
      502,
      'Integration request failed',
      'REQUEST_FAILED'
    );
  } finally {
    clearTimeout(timer);
  }
}

function selectPrebuiltOperations(
  connector: (typeof PREBUILT_CONNECTORS)[PrebuiltProvider],
  requested: McpServerOperation[] | undefined
): McpServerOperation[] {
  const catalog = connector.operations.map((operation) => ({ ...operation }));
  if (requested === undefined) return catalog;
  const allowed = new Map(catalog.map((operation) => [operation.id, operation]));
  const selected = [
    ...new Map(
      requested
        .filter(
          (operation) =>
            operation.method === 'GET' &&
            operation.readOnly === true &&
            allowed.has(operation.id)
        )
        .map((operation) => [operation.id, allowed.get(operation.id)!])
    ).values(),
  ];
  if (selected.length === 0) {
    throw new McpServerError(
      400,
      'Choose at least one tool',
      'OPERATIONS_REQUIRED'
    );
  }
  return selected;
}

function isPrebuilt(provider: string): provider is PrebuiltProvider {
  return (PREBUILT_PROVIDER_IDS as readonly string[]).includes(provider);
}

function assertName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100) {
    throw new McpServerError(
      400,
      'Connection name is required',
      'NAME_REQUIRED'
    );
  }
  return trimmed;
}

function assertCredential(credential: string): string {
  const trimmed = credential.trim();
  if (!trimmed) {
    throw new McpServerError(
      400,
      'Credential is required',
      'CREDENTIAL_REQUIRED'
    );
  }
  return trimmed;
}

function assertUserIds(ids: string[]): string[] {
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== 'string' || !id.trim())
  ) {
    throw new McpServerError(
      400,
      'Allowed users must be a list of user ids',
      'ALLOWED_USERS_INVALID'
    );
  }
  return ids.map((id) => id.trim());
}

function authHeaders(
  provider: McpServerProvider,
  credential: string
): Record<string, string> {
  if (
    provider !== 'custom' &&
    PREBUILT_CONNECTORS[provider].auth === 'pendo-integration-key'
  ) {
    return { 'x-pendo-integration-key': credential };
  }
  return { Authorization: `Bearer ${credential}` };
}

function testUrl(
  row: Pick<ConnectionRow, 'provider' | 'baseUrl' | 'operations'>
): string {
  if (isPrebuilt(row.provider)) {
    const connector = PREBUILT_CONNECTORS[row.provider];
    const url = joinMcpServerUrl(
      connector.baseUrl,
      connector.testRequest.path
    );
    for (const [key, value] of Object.entries(
      connector.testRequest.query ?? {}
    )) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }
  const operation = row.operations[0];
  if (!row.baseUrl || !operation) {
    throw new McpServerError(
      400,
      'This connection cannot be tested',
      'TEST_UNSUPPORTED'
    );
  }
  const path = operation.path.replace(/\{[^}]+\}/g, 'sample');
  return joinMcpServerUrl(row.baseUrl, path).toString();
}

const EMPTY_REMOTE_PUBLIC = {
  secretNames: [] as string[],
  missingSecretNames: [] as string[],
  headers: {} as Record<string, string>,
  toolNames: [] as string[],
  authMode: 'none' as const,
  oauthConnected: false,
};

function remotePublicState(row: ConnectionRow) {
  try {
    const credential = decryptMcpServerCredential(encryptedFromRow(row), {
      project: row.project,
      connectionId: row.id,
    });
    const remote = parseRemoteMcpCredential(credential);
    if (!remote) return EMPTY_REMOTE_PUBLIC;
    return publicRemoteConfig(remote);
  } catch {
    return EMPTY_REMOTE_PUBLIC;
  }
}

function toPublic(row: ConnectionRow): McpServerConnectionPublic {
  return {
    id: row.id,
    project: row.project,
    name: row.name,
    provider: row.provider,
    status: row.status,
    credentialHint: row.credentialHint,
    baseUrl: row.baseUrl,
    operations: row.operations.map(({ inputSchema, ...operation }) => {
      const inputs = toolInputsFromSchema(inputSchema);
      return inputs.length > 0 ? { ...operation, inputs } : operation;
    }),
    allowedUserIds: row.allowedUserIds,
    ...remotePublicState(row),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastTestedAt: row.lastTestedAt,
  };
}

function mcpToolsToReadOnlyOperations(tools: DiscoveredMcpTool[]): McpServerOperation[] {
  return tools
    .filter((tool) => tool.readOnly)
    .map((tool) => ({
      id: tool.name,
      method: 'GET' as const,
      path: '/mcp-tool',
      summary: tool.description,
      readOnly: true as const,
      source: 'mcp' as const,
      inputSchema: tool.inputSchema,
    }));
}

function encryptedFromRow(row: ConnectionRow): EncryptedMcpServerCredential {
  return {
    algorithm: 'aes-256-gcm',
    iv: row.credentialIv,
    ciphertext: row.credentialCiphertext,
    authTag: row.credentialAuthTag,
  };
}

function saveRemoteCredential(
  next: Partial<ConnectionRow>,
  project: string,
  id: string,
  remote: RemoteMcpCredential,
): void {
  const encrypted = encryptMcpServerCredential(encodeRemoteMcpCredential(remote), {
    project,
    connectionId: id,
  });
  next.credentialCiphertext = encrypted.ciphertext;
  next.credentialIv = encrypted.iv;
  next.credentialAuthTag = encrypted.authTag;
  next.credentialHint = maskMcpServerCredential(Object.values(remote.secrets)[0] ?? 'none');
}

async function loadFreshRemote(
  row: ConnectionRow,
  fetchImpl?: OAuthFetch,
): Promise<RemoteMcpCredential | null> {
  const credential = decryptMcpServerCredential(encryptedFromRow(row), {
    project: row.project,
    connectionId: row.id,
  });
  const remote = parseRemoteMcpCredential(credential);
  if (!remote) return null;
  const fresh = await ensureFreshOAuthCredential(remote, fetchImpl);
  if (fresh !== remote) {
    const next: Partial<ConnectionRow> = { updatedAt: new Date().toISOString() };
    saveRemoteCredential(next, row.project, row.id, fresh);
    await db.update(mcpServers).set(next).where(and(eq(mcpServers.id, row.id), eq(mcpServers.project, row.project)));
  }
  return fresh;
}

export async function headersForRemoteMcpServer(row: ConnectionRow): Promise<Record<string, string>> {
  const fresh = await loadFreshRemote(row);
  if (!fresh) {
    throw new McpServerError(400, 'This connection cannot be tested', 'TEST_UNSUPPORTED');
  }
  return resolveRemoteMcpHeaders(fresh);
}

async function findRow(
  project: string,
  id: string
): Promise<ConnectionRow | null> {
  const rows = await db
    .select()
    .from(mcpServers)
    .where(
      and(
        eq(mcpServers.id, id),
        eq(mcpServers.project, project)
      )
    );
  return (rows[0] as ConnectionRow | undefined) ?? null;
}

export async function createMcpServer(
  input: CreateMcpServerRequest & {
    project: string;
    createdBy: string;
  }
): Promise<McpServerConnectionPublic> {
  const name = assertName(input.name);
  const allowedUserIds = assertUserIds(input.allowedUserIds ?? []);
  const id = randomUUID();
  const now = new Date().toISOString();
  const remote = input.provider === 'custom' && input.mcpUrl
    ? buildRemoteMcpCredential({
      headers: input.headers,
      secrets: input.secrets,
      toolNames: input.toolNames,
      authMode: input.authMode,
    })
    : null;
  const credential = remote ? encodeRemoteMcpCredential(remote) : assertCredential(input.credential);
  let baseUrl: string;
  let operations: McpServerOperation[];
  if (remote && input.mcpUrl) {
    baseUrl = assertMcpServerBaseUrl(input.mcpUrl);
    operations = [];
  } else if (isPrebuilt(input.provider)) {
    const connector = PREBUILT_CONNECTORS[input.provider];
    baseUrl = connector.mcpUrl ?? connector.baseUrl;
    if (input.toolNames) {
      const discovered = await discoverMcpServerTools({
        provider: input.provider,
        clientId: input.clientId,
        clientSecret: credential,
      });
      const wanted = new Set(input.toolNames);
      operations = mcpToolsToReadOnlyOperations(
        discovered.filter((tool) => wanted.has(tool.name))
      );
      if (operations.length === 0) {
        throw new McpServerError(
          400,
          'Choose at least one tool from the MCP server',
          'OPERATIONS_REQUIRED'
        );
      }
    } else {
      baseUrl = connector.baseUrl;
      operations = selectPrebuiltOperations(connector, input.operations);
    }
  } else if (input.provider === 'custom') {
    baseUrl = assertMcpServerBaseUrl(input.baseUrl ?? '');
    operations = input.openApiDocument
      ? importOpenApiOperations(input.openApiDocument, baseUrl)
      : assertReadOnlyOperations(input.operations);
  } else {
    throw new McpServerError(
      400,
      'A custom connector needs an operation definition',
      'OPERATIONS_REQUIRED'
    );
  }
  const storedCredential = remote
    ? credential
    : input.clientId
      ? encodeClientCredential(input.clientId.trim(), credential)
      : credential;
  const encrypted = encryptMcpServerCredential(storedCredential, {
    project: input.project,
    connectionId: id,
  });
  const row: ConnectionRow = {
    id,
    project: input.project,
    name,
    provider: input.provider,
    status: 'untested',
    credentialCiphertext: encrypted.ciphertext,
    credentialIv: encrypted.iv,
    credentialAuthTag: encrypted.authTag,
    credentialHint: remote
      ? maskMcpServerCredential(Object.values(remote.secrets)[0] ?? 'none')
      : maskMcpServerCredential(credential),
    baseUrl,
    operations,
    allowedUserIds,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    lastTestedAt: null,
  };
  const inserted = await db
    .insert(mcpServers)
    .values(row)
    .returning();
  return toPublic(inserted[0] as ConnectionRow);
}

export async function listMcpServers(
  project: string
): Promise<McpServerConnectionPublic[]> {
  const rows = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.project, project));
  return (rows as ConnectionRow[]).map(toPublic);
}

export async function updateMcpServer(
  project: string,
  id: string,
  patch: UpdateMcpServerRequest
): Promise<McpServerConnectionPublic> {
  const existing = await findRow(project, id);
  if (!existing) {
    throw new McpServerError(
      404,
      'Connection not found',
      'NOT_FOUND'
    );
  }
  const next: Partial<ConnectionRow> = { updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) next.name = assertName(patch.name);
  if (patch.allowedUserIds !== undefined)
    next.allowedUserIds = assertUserIds(patch.allowedUserIds);
  const reconnectPatch = patch.secrets !== undefined
    || patch.secretNames !== undefined
    || patch.headers !== undefined
    || patch.authMode !== undefined
    || patch.mcpUrl !== undefined;
  const policyPatch = patch.toolNames !== undefined;
  if (reconnectPatch || policyPatch) {
    const stored = decryptMcpServerCredential(encryptedFromRow(existing), {
      project,
      connectionId: id,
    });
    let remote = parseRemoteMcpCredential(stored);
    if (!remote) {
      throw new McpServerError(400, 'This server has no editable configuration', 'CREDENTIAL_REQUIRED');
    }
    if (patch.mcpUrl !== undefined) {
      const nextUrl = assertMcpServerBaseUrl(patch.mcpUrl);
      if (nextUrl !== existing.baseUrl) {
        remote = { ...remote, oauth: undefined };
        next.baseUrl = nextUrl;
        next.operations = [];
      }
    }
    const nextRemote = mergeRemoteMcpConfig(remote, patch);
    saveRemoteCredential(next, project, id, nextRemote);
    if (reconnectPatch) {
      next.status = 'untested';
      next.lastTestedAt = null;
    }
  } else if (patch.credential !== undefined) {
    const credential = assertCredential(patch.credential);
    const encrypted = encryptMcpServerCredential(credential, {
      project,
      connectionId: id,
    });
    next.credentialCiphertext = encrypted.ciphertext;
    next.credentialIv = encrypted.iv;
    next.credentialAuthTag = encrypted.authTag;
    next.credentialHint = maskMcpServerCredential(credential);
    next.status = 'untested';
    next.lastTestedAt = null;
  }
  const updated = await db
    .update(mcpServers)
    .set(next)
    .where(
      and(
        eq(mcpServers.id, id),
        eq(mcpServers.project, project)
      )
    )
    .returning();
  return toPublic(updated[0] as ConnectionRow);
}

export async function beginMcpServerOAuth(input: {
  project: string;
  id: string;
  userId: string;
  redirectUri: string;
  returnOrigin?: string;
  fetchImpl?: OAuthFetch;
}): Promise<string> {
  const existing = await findRow(input.project, input.id);
  if (!existing) throw new McpServerError(404, 'Connection not found', 'NOT_FOUND');
  if (!existing.baseUrl) {
    throw new McpServerError(400, 'Save a public https MCP URL before signing in.', 'OAUTH_REQUIRED');
  }
  const credential = decryptMcpServerCredential(encryptedFromRow(existing), {
    project: existing.project,
    connectionId: existing.id,
  });
  const remote = parseRemoteMcpCredential(credential);
  if (!remote) {
    throw new McpServerError(400, 'This server has no editable configuration', 'CREDENTIAL_REQUIRED');
  }
  const discovered = await discoverMcpOAuth(existing.baseUrl, input.fetchImpl);
  const reusable = remote.oauth
    && remote.oauth.redirectUri === input.redirectUri
    && remote.oauth.resource === discovered.resource
    && remote.oauth.tokenEndpoint === discovered.tokenEndpoint;
  const client = reusable
    ? { clientId: remote.oauth!.clientId, clientSecret: remote.oauth!.clientSecret }
    : await registerOAuthClient(discovered, input.redirectUri, input.fetchImpl);
  const pkce = createPkcePair();
  const state = randomUUID();
  const nextRemote: RemoteMcpCredential = {
    ...remote,
    authMode: 'oauth',
    oauth: {
      resource: discovered.resource,
      authorizationEndpoint: discovered.authorizationEndpoint,
      tokenEndpoint: discovered.tokenEndpoint,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: input.redirectUri,
      scopes: discovered.scopes,
      returnOrigin: input.returnOrigin,
      pending: {
        state,
        codeVerifier: pkce.verifier,
        startedBy: input.userId,
        createdAt: new Date().toISOString(),
      },
    },
  };
  const next: Partial<ConnectionRow> = { updatedAt: new Date().toISOString() };
  saveRemoteCredential(next, input.project, input.id, nextRemote);
  await db.update(mcpServers).set(next).where(and(eq(mcpServers.id, input.id), eq(mcpServers.project, input.project)));
  return buildOAuthAuthorizationUrl({
    authorizationEndpoint: discovered.authorizationEndpoint,
    clientId: client.clientId,
    redirectUri: input.redirectUri,
    scopes: discovered.scopes,
    resource: discovered.resource,
    state,
    codeChallenge: pkce.challenge,
  });
}

export async function completeMcpServerOAuth(input: {
  project: string;
  id: string;
  userId: string;
  code: string;
  state: string;
  fetchImpl?: OAuthFetch;
}): Promise<string | null> {
  const existing = await findRow(input.project, input.id);
  if (!existing) throw new McpServerError(404, 'Connection not found', 'NOT_FOUND');
  const credential = decryptMcpServerCredential(encryptedFromRow(existing), {
    project: existing.project,
    connectionId: existing.id,
  });
  const remote = parseRemoteMcpCredential(credential);
  if (!remote?.oauth) {
    throw new McpServerError(400, 'This sign-in has expired. Start it again.', 'OAUTH_REQUIRED');
  }
  const returnOrigin = remote.oauth.returnOrigin ?? null;
  const pending = assertOAuthPending(remote.oauth, { state: input.state, userId: input.userId });
  if (!input.code || input.code.length > 2048) {
    throw new McpServerError(400, 'This sign-in could not be verified.', 'OAUTH_REQUIRED');
  }
  const tokens = await exchangeAuthorizationCode(remote.oauth, input.code, pending.codeVerifier, input.fetchImpl);
  const nextRemote: RemoteMcpCredential = {
    ...remote,
    authMode: 'oauth',
    oauth: { ...remote.oauth, ...tokens, returnOrigin: returnOrigin ?? undefined, pending: undefined },
  };
  const next: Partial<ConnectionRow> = { updatedAt: new Date().toISOString() };
  saveRemoteCredential(next, input.project, input.id, nextRemote);
  await db.update(mcpServers).set(next).where(and(eq(mcpServers.id, input.id), eq(mcpServers.project, input.project)));
  return returnOrigin;
}

export async function deleteMcpServer(
  project: string,
  id: string
): Promise<void> {
  const existing = await findRow(project, id);
  if (!existing) {
    throw new McpServerError(
      404,
      'Connection not found',
      'NOT_FOUND'
    );
  }
  await db
    .delete(mcpServers)
    .where(
      and(
        eq(mcpServers.id, id),
        eq(mcpServers.project, project)
      )
    );
}

export async function testMcpServer(
  project: string,
  id: string,
  fetchImpl: McpServerFetch = defaultMcpServerFetch
): Promise<McpServerConnectionPublic> {
  const existing = await findRow(project, id);
  if (!existing) {
    throw new McpServerError(
      404,
      'Connection not found',
      'NOT_FOUND'
    );
  }
  const remote = await loadFreshRemote(existing);
  if (remote) {
    if (!existing.baseUrl) {
      throw new McpServerError(400, 'This connection cannot be tested', 'TEST_UNSUPPORTED');
    }
    const discovered = await discoverRemoteMcpTools({
      url: existing.baseUrl,
      headers: resolveRemoteMcpHeaders(remote),
    });
    const operations = mcpToolsToReadOnlyOperations(discovered);
    if (operations.length === 0) {
      throw new McpServerError(
        400,
        'This server did not publish a read-only tool',
        'OPERATIONS_REQUIRED'
      );
    }
    const testedAt = new Date().toISOString();
    const updated = await db
      .update(mcpServers)
      .set({ status: 'usable', operations, lastTestedAt: testedAt, updatedAt: testedAt })
      .where(
        and(
          eq(mcpServers.id, id),
          eq(mcpServers.project, project)
        )
      )
      .returning();
    return toPublic(updated[0] as ConnectionRow);
  }
  const credential = decryptMcpServerCredential(encryptedFromRow(existing), {
    project: existing.project,
    connectionId: existing.id,
  });
  if (existing.operations.some((operation) => operation.source === 'mcp')) {
    if (!isPrebuilt(existing.provider)) {
      throw new McpServerError(400, 'This connection cannot be tested', 'TEST_UNSUPPORTED');
    }
    const stored = parseStoredClientCredential(credential);
    await discoverMcpServerTools({
      provider: existing.provider,
      clientId: stored.clientId,
      clientSecret: stored.clientSecret,
    });
    const testedAt = new Date().toISOString();
    const updated = await db
      .update(mcpServers)
      .set({ status: 'usable', lastTestedAt: testedAt, updatedAt: testedAt })
      .where(
        and(
          eq(mcpServers.id, id),
          eq(mcpServers.project, project)
        )
      )
      .returning();
    return toPublic(updated[0] as ConnectionRow);
  }
  const result = await fetchImpl(testUrl(existing), {
    method: 'GET',
    headers: authHeaders(existing.provider, credential),
  });
  if (result.status < 200 || result.status >= 300) {
    throw new McpServerError(
      502,
      'Connection test failed',
      'TEST_FAILED'
    );
  }
  const testedAt = new Date().toISOString();
  const updated = await db
    .update(mcpServers)
    .set({ status: 'usable', lastTestedAt: testedAt, updatedAt: testedAt })
    .where(
      and(
        eq(mcpServers.id, id),
        eq(mcpServers.project, project)
      )
    )
    .returning();
  return toPublic(updated[0] as ConnectionRow);
}

export { McpServerError };
