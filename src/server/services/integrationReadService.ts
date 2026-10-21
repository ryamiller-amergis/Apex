import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { integrationConnections } from '../db/schema';
import {
  PREBUILT_CONNECTORS,
  type IntegrationOperation,
  type IntegrationProvider,
  type PrebuiltProvider,
} from '../../shared/types/integrations';
import { decryptIntegrationCredential } from './integrationCredentialCrypto';
import {
  defaultIntegrationFetch,
  type IntegrationFetch,
} from './integrationConnectionService';
import { IntegrationConnectionError } from './integrationErrors';

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

export interface IntegrationReadInput {
  project: string;
  connectionId: string;
  userId: string;
  operationId: string;
  params?: Record<string, string>;
  fetchImpl?: IntegrationFetch;
}

export interface IntegrationReadResult {
  operationId: string;
  status: number;
  body: string;
}

function authHeaders(provider: IntegrationProvider, credential: string): Record<string, string> {
  if (provider === 'pendo' || (provider !== 'custom' && PREBUILT_CONNECTORS[provider as PrebuiltProvider]?.auth === 'pendo-integration-key')) {
    return { 'x-pendo-integration-key': credential };
  }
  return { Authorization: `Bearer ${credential}` };
}

export function buildIntegrationReadUrl(
  baseUrl: string,
  pathTemplate: string,
  params: Record<string, string>,
): string {
  let path = pathTemplate;
  const query = { ...params };
  for (const placeholder of pathTemplate.match(/\{([^}]+)\}/g) ?? []) {
    const key = placeholder.slice(1, -1);
    const value = query[key];
    if (value === undefined || value.includes('..') || value.includes('/') || value.includes('\\')) {
      throw new IntegrationConnectionError(400, 'Invalid operation parameter', 'OPERATION_PARAMS');
    }
    path = path.replace(placeholder, encodeURIComponent(value));
    delete query[key];
  }
  if (path.includes('..') || path.startsWith('//')) {
    throw new IntegrationConnectionError(400, 'Invalid operation path', 'OPERATION_NOT_ALLOWED');
  }
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new IntegrationConnectionError(400, 'Connection URL is invalid', 'OPERATION_NOT_ALLOWED');
  }
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (url.origin !== base.origin || url.protocol !== 'https:') {
    throw new IntegrationConnectionError(400, 'Operation URL is outside the connection host', 'OPERATION_NOT_ALLOWED');
  }
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function loadRow(project: string, connectionId: string): Promise<ConnectionRow | null> {
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(and(
      eq(integrationConnections.id, connectionId),
      eq(integrationConnections.project, project),
    ));
  return (rows[0] as ConnectionRow | undefined) ?? null;
}

async function loadRowById(connectionId: string): Promise<ConnectionRow | null> {
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));
  return (rows[0] as ConnectionRow | undefined) ?? null;
}

function operationOrThrow(row: ConnectionRow, operationId: string): IntegrationOperation {
  const operation = (row.operations ?? []).find((item) => item.id === operationId);
  if (!operation || operation.method !== 'GET' || operation.readOnly !== true) {
    throw new IntegrationConnectionError(
      403,
      'That operation is not allowed for this connection',
      'OPERATION_NOT_ALLOWED',
    );
  }
  return operation;
}

async function callOperation(
  row: ConnectionRow,
  operation: IntegrationOperation,
  params: Record<string, string>,
  fetchImpl: IntegrationFetch,
): Promise<IntegrationReadResult> {
  if (!row.baseUrl) {
    throw new IntegrationConnectionError(400, 'Connection URL is missing', 'OPERATION_NOT_ALLOWED');
  }
  const credential = decryptIntegrationCredential(
    {
      algorithm: 'aes-256-gcm',
      iv: row.credentialIv,
      ciphertext: row.credentialCiphertext,
      authTag: row.credentialAuthTag,
    },
    { project: row.project, connectionId: row.id },
  );
  const result = await fetchImpl(buildIntegrationReadUrl(row.baseUrl, operation.path, params), {
    method: 'GET',
    headers: authHeaders(row.provider, credential),
  });
  if (result.status < 200 || result.status >= 300) {
    throw new IntegrationConnectionError(502, 'Integration read failed', 'REQUEST_FAILED');
  }
  return { operationId: operation.id, status: result.status, body: result.body };
}

export async function executeIntegrationRead(input: IntegrationReadInput): Promise<IntegrationReadResult> {
  const row = await loadRow(input.project, input.connectionId);
  if (!row) {
    throw new IntegrationConnectionError(404, 'Connection not found', 'NOT_FOUND');
  }
  if (!row.allowedUserIds.includes(input.userId)) {
    throw new IntegrationConnectionError(403, 'You cannot use this connection', 'NOT_ALLOWED');
  }
  const operation = operationOrThrow(row, input.operationId);
  return callOperation(row, operation, input.params ?? {}, input.fetchImpl ?? defaultIntegrationFetch);
}

/** Tool-server entry. The connection id in the mount URL is the only target. */
export async function executeMountedIntegrationRead(
  connectionId: string,
  operationId: string,
  params: Record<string, string> = {},
  fetchImpl: IntegrationFetch = defaultIntegrationFetch,
): Promise<IntegrationReadResult> {
  const row = await loadRowById(connectionId);
  if (!row) {
    throw new IntegrationConnectionError(404, 'Connection not found', 'NOT_FOUND');
  }
  const operation = operationOrThrow(row, operationId);
  return callOperation(row, operation, params, fetchImpl);
}
