import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { integrationConnections } from '../db/schema';
import {
  PREBUILT_CONNECTORS,
  PREBUILT_PROVIDER_IDS,
  type CreateIntegrationConnectionRequest,
  type IntegrationConnectionPublic,
  type IntegrationOperation,
  type IntegrationProvider,
  type PrebuiltProvider,
  type UpdateIntegrationConnectionRequest,
} from '../../shared/types/integrations';
import {
  decryptIntegrationCredential,
  encryptIntegrationCredential,
  maskIntegrationCredential,
  type EncryptedIntegrationCredential,
} from './integrationCredentialCrypto';
import { IntegrationConnectionError } from './integrationErrors';
import { getIntegrationFetchStub } from './integrationFetchStub';
import {
  assertIntegrationBaseUrl,
  assertResolvedPublicHttpsUrl,
  assertReadOnlyOperations,
  importOpenApiOperations,
  joinIntegrationUrl,
} from './integrationOpenApi';

export interface IntegrationFetchInit {
  method: string;
  headers: Record<string, string>;
}

export interface IntegrationFetchResult {
  status: number;
  body: string;
}

export type IntegrationFetch = (
  url: string,
  init: IntegrationFetchInit
) => Promise<IntegrationFetchResult>;

interface ConnectionRow {
  id: string;
  project: string;
  name: string;
  provider: IntegrationProvider;
  status: 'untested' | 'usable';
  credentialCiphertext: string;
  credentialIv: string;
  credentialAuthTag: string;
  credentialHint: string;
  baseUrl: string | null;
  operations: IntegrationOperation[];
  allowedUserIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastTestedAt: string | null;
}

const RESPONSE_LIMIT_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 10_000;

export async function defaultIntegrationFetch(
  url: string,
  init: IntegrationFetchInit
): Promise<IntegrationFetchResult> {
  if (process.env.E2E_MODE === 'true') {
    const stub = getIntegrationFetchStub();
    if (!stub) {
      throw new IntegrationConnectionError(
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
      throw new IntegrationConnectionError(
        502,
        'Integration response is too large',
        'RESPONSE_TOO_LARGE'
      );
    }
    return { status: response.status, body };
  } catch (err) {
    if (err instanceof IntegrationConnectionError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new IntegrationConnectionError(
        504,
        'Integration request timed out',
        'REQUEST_TIMEOUT'
      );
    }
    throw new IntegrationConnectionError(
      502,
      'Integration request failed',
      'REQUEST_FAILED'
    );
  } finally {
    clearTimeout(timer);
  }
}

function isPrebuilt(provider: string): provider is PrebuiltProvider {
  return (PREBUILT_PROVIDER_IDS as readonly string[]).includes(provider);
}

function assertName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100) {
    throw new IntegrationConnectionError(
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
    throw new IntegrationConnectionError(
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
    throw new IntegrationConnectionError(
      400,
      'Allowed users must be a list of user ids',
      'ALLOWED_USERS_INVALID'
    );
  }
  return ids.map((id) => id.trim());
}

function authHeaders(
  provider: IntegrationProvider,
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
    const url = joinIntegrationUrl(
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
    throw new IntegrationConnectionError(
      400,
      'This connection cannot be tested',
      'TEST_UNSUPPORTED'
    );
  }
  const path = operation.path.replace(/\{[^}]+\}/g, 'sample');
  return joinIntegrationUrl(row.baseUrl, path).toString();
}

function toPublic(row: ConnectionRow): IntegrationConnectionPublic {
  return {
    id: row.id,
    project: row.project,
    name: row.name,
    provider: row.provider,
    status: row.status,
    credentialHint: row.credentialHint,
    baseUrl: row.baseUrl,
    operations: row.operations,
    allowedUserIds: row.allowedUserIds,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastTestedAt: row.lastTestedAt,
  };
}

function encryptedFromRow(row: ConnectionRow): EncryptedIntegrationCredential {
  return {
    algorithm: 'aes-256-gcm',
    iv: row.credentialIv,
    ciphertext: row.credentialCiphertext,
    authTag: row.credentialAuthTag,
  };
}

async function findRow(
  project: string,
  id: string
): Promise<ConnectionRow | null> {
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.id, id),
        eq(integrationConnections.project, project)
      )
    );
  return (rows[0] as ConnectionRow | undefined) ?? null;
}

export async function createIntegrationConnection(
  input: CreateIntegrationConnectionRequest & {
    project: string;
    createdBy: string;
  }
): Promise<IntegrationConnectionPublic> {
  const name = assertName(input.name);
  const credential = assertCredential(input.credential);
  const allowedUserIds = assertUserIds(input.allowedUserIds ?? []);
  const id = randomUUID();
  const now = new Date().toISOString();
  let baseUrl: string;
  let operations: IntegrationOperation[];
  if (isPrebuilt(input.provider)) {
    const connector = PREBUILT_CONNECTORS[input.provider];
    baseUrl = connector.baseUrl;
    operations = connector.operations.map((operation) => ({ ...operation }));
  } else if (input.provider === 'custom') {
    baseUrl = assertIntegrationBaseUrl(input.baseUrl ?? '');
    operations = input.openApiDocument
      ? importOpenApiOperations(input.openApiDocument, baseUrl)
      : assertReadOnlyOperations(input.operations);
  } else {
    throw new IntegrationConnectionError(
      400,
      'A custom connector needs an operation definition',
      'OPERATIONS_REQUIRED'
    );
  }
  const encrypted = encryptIntegrationCredential(credential, {
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
    credentialHint: maskIntegrationCredential(credential),
    baseUrl,
    operations,
    allowedUserIds,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    lastTestedAt: null,
  };
  const inserted = await db
    .insert(integrationConnections)
    .values(row)
    .returning();
  return toPublic(inserted[0] as ConnectionRow);
}

export async function listIntegrationConnections(
  project: string
): Promise<IntegrationConnectionPublic[]> {
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.project, project));
  return (rows as ConnectionRow[]).map(toPublic);
}

export async function updateIntegrationConnection(
  project: string,
  id: string,
  patch: UpdateIntegrationConnectionRequest
): Promise<IntegrationConnectionPublic> {
  const existing = await findRow(project, id);
  if (!existing) {
    throw new IntegrationConnectionError(
      404,
      'Connection not found',
      'NOT_FOUND'
    );
  }
  const next: Partial<ConnectionRow> = { updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) next.name = assertName(patch.name);
  if (patch.allowedUserIds !== undefined)
    next.allowedUserIds = assertUserIds(patch.allowedUserIds);
  if (patch.credential !== undefined) {
    const credential = assertCredential(patch.credential);
    const encrypted = encryptIntegrationCredential(credential, {
      project,
      connectionId: id,
    });
    next.credentialCiphertext = encrypted.ciphertext;
    next.credentialIv = encrypted.iv;
    next.credentialAuthTag = encrypted.authTag;
    next.credentialHint = maskIntegrationCredential(credential);
    next.status = 'untested';
    next.lastTestedAt = null;
  }
  const updated = await db
    .update(integrationConnections)
    .set(next)
    .where(
      and(
        eq(integrationConnections.id, id),
        eq(integrationConnections.project, project)
      )
    )
    .returning();
  return toPublic(updated[0] as ConnectionRow);
}

export async function deleteIntegrationConnection(
  project: string,
  id: string
): Promise<void> {
  const existing = await findRow(project, id);
  if (!existing) {
    throw new IntegrationConnectionError(
      404,
      'Connection not found',
      'NOT_FOUND'
    );
  }
  await db
    .delete(integrationConnections)
    .where(
      and(
        eq(integrationConnections.id, id),
        eq(integrationConnections.project, project)
      )
    );
}

export async function testIntegrationConnection(
  project: string,
  id: string,
  fetchImpl: IntegrationFetch = defaultIntegrationFetch
): Promise<IntegrationConnectionPublic> {
  const existing = await findRow(project, id);
  if (!existing) {
    throw new IntegrationConnectionError(
      404,
      'Connection not found',
      'NOT_FOUND'
    );
  }
  const credential = decryptIntegrationCredential(encryptedFromRow(existing), {
    project: existing.project,
    connectionId: existing.id,
  });
  const result = await fetchImpl(testUrl(existing), {
    method: 'GET',
    headers: authHeaders(existing.provider, credential),
  });
  if (result.status < 200 || result.status >= 300) {
    throw new IntegrationConnectionError(
      502,
      'Connection test failed',
      'TEST_FAILED'
    );
  }
  const testedAt = new Date().toISOString();
  const updated = await db
    .update(integrationConnections)
    .set({ status: 'usable', lastTestedAt: testedAt, updatedAt: testedAt })
    .where(
      and(
        eq(integrationConnections.id, id),
        eq(integrationConnections.project, project)
      )
    )
    .returning();
  return toPublic(updated[0] as ConnectionRow);
}

export { IntegrationConnectionError };
