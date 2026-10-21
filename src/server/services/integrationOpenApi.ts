import type { IntegrationOperation } from '../../shared/types/integrations';
import { IntegrationConnectionError } from './integrationErrors';

interface OpenApiDocument {
  servers?: Array<{ url?: string }>;
  paths?: Record<string, Partial<Record<string, { operationId?: string; summary?: string }>>>;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '0.0.0.0' || host === '::1' || host === 'metadata.google.internal') return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

export function assertIntegrationBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new IntegrationConnectionError(400, 'Base URL is invalid', 'URL_RESTRICTED');
  }
  if (url.protocol !== 'https:' || url.username || url.password || isPrivateHost(url.hostname)) {
    throw new IntegrationConnectionError(400, 'Base URL must be a public https host', 'URL_RESTRICTED');
  }
  const path = url.pathname.replace(/\/$/, '');
  return `${url.origin}${path}`;
}

export function assertReadOnlyOperations(operations: IntegrationOperation[] | undefined): IntegrationOperation[] {
  if (!operations || operations.length === 0) {
    throw new IntegrationConnectionError(
      400,
      'A custom connector needs an operation definition',
      'OPERATIONS_REQUIRED',
    );
  }
  const ids = new Set<string>();
  return operations.map((operation) => {
    if (operation.method !== 'GET' || operation.readOnly !== true) {
      throw new IntegrationConnectionError(400, 'Each operation must be a read-only GET', 'READ_ONLY_REQUIRED');
    }
    const id = operation.id?.trim();
    if (!id || ids.has(id)) {
      throw new IntegrationConnectionError(400, 'Each operation needs a unique id', 'OPERATIONS_REQUIRED');
    }
    ids.add(id);
    if (!operation.path?.startsWith('/') || operation.path.includes('..') || operation.path.includes('://')) {
      throw new IntegrationConnectionError(400, 'Operation path is not allowed', 'URL_RESTRICTED');
    }
    return {
      id,
      method: 'GET',
      path: operation.path,
      summary: operation.summary?.trim() || id,
      readOnly: true,
    };
  });
}

export function importOpenApiOperations(document: unknown, baseUrl: string): IntegrationOperation[] {
  if (!document || typeof document !== 'object') {
    throw new IntegrationConnectionError(400, 'OpenAPI document is required', 'OPERATIONS_REQUIRED');
  }
  const doc = document as OpenApiDocument;
  const declared = doc.servers?.find((server) => server.url)?.url;
  if (declared) {
    const server = new URL(declared);
    const base = new URL(baseUrl);
    if (server.origin !== base.origin) {
      throw new IntegrationConnectionError(
        400,
        'OpenAPI server URL does not match the connection URL',
        'URL_RESTRICTED',
      );
    }
  }
  const operations: IntegrationOperation[] = [];
  for (const [path, methods] of Object.entries(doc.paths ?? {})) {
    const get = methods?.get;
    if (!get) continue;
    const id = get.operationId?.trim() || `get_${path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
    operations.push({
      id,
      method: 'GET',
      path,
      summary: get.summary?.trim() || id,
      readOnly: true,
    });
  }
  return assertReadOnlyOperations(operations);
}
