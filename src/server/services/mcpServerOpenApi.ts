import dns from 'node:dns';
import { BlockList, isIP } from 'node:net';
import type { McpServerOperation } from '../../shared/types/mcpServers';
import { McpServerError } from './mcpServerErrors';

interface OpenApiDocument {
  servers?: Array<{ url?: string }>;
  paths?: Record<
    string,
    Partial<Record<string, { operationId?: string; summary?: string }>>
  >;
}

const PRIVATE_NETS = new BlockList();
PRIVATE_NETS.addAddress('::', 'ipv6');
PRIVATE_NETS.addAddress('::1', 'ipv6');
PRIVATE_NETS.addSubnet('fc00::', 7, 'ipv6');
PRIVATE_NETS.addSubnet('fe80::', 10, 'ipv6');
PRIVATE_NETS.addSubnet('0.0.0.0', 8, 'ipv4');
PRIVATE_NETS.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE_NETS.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE_NETS.addSubnet('169.254.0.0', 16, 'ipv4');
PRIVATE_NETS.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE_NETS.addSubnet('192.168.0.0', 16, 'ipv4');

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.svc') ||
    host.endsWith('.cluster.local')
  )
    return true;
  if (host === 'metadata.google.internal') return true;
  const kind = isIP(host);
  if (kind === 4) return PRIVATE_NETS.check(host, 'ipv4');
  if (kind === 6) return PRIVATE_NETS.check(host, 'ipv6');
  return false;
}

function throwUrlRestricted(): never {
  throw new McpServerError(
    400,
    'Base URL must be a public https host',
    'URL_RESTRICTED'
  );
}

export function assertPublicHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpServerError(
      400,
      'Base URL is invalid',
      'URL_RESTRICTED'
    );
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    isPrivateHost(url.hostname)
  ) {
    throwUrlRestricted();
  }
  return url;
}

export async function assertResolvedPublicHttpsUrl(
  value: string
): Promise<URL> {
  const url = assertPublicHttpsUrl(value);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(host)) return url;
  const resolved = await dns.promises.lookup(host, {
    all: true,
    verbatim: true,
  });
  const addresses = Array.isArray(resolved) ? resolved : [resolved];
  if (
    addresses.length === 0 ||
    addresses.some((entry) => isPrivateHost(entry.address))
  ) {
    throwUrlRestricted();
  }
  return url;
}

export function joinMcpServerUrl(baseUrl: string, path: string): URL {
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('..') ||
    path.includes('://')
  ) {
    throw new McpServerError(
      400,
      'Invalid operation path',
      'OPERATION_NOT_ALLOWED'
    );
  }
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new McpServerError(
      400,
      'Connection URL is invalid',
      'OPERATION_NOT_ALLOWED'
    );
  }
  const url = new URL(base.toString());
  url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
  if (url.origin !== base.origin || url.protocol !== 'https:') {
    throw new McpServerError(
      400,
      'Operation URL is outside the connection host',
      'OPERATION_NOT_ALLOWED'
    );
  }
  return url;
}

export function assertMcpServerBaseUrl(baseUrl: string): string {
  const url = assertPublicHttpsUrl(baseUrl);
  const path = url.pathname.replace(/\/$/, '');
  return `${url.origin}${path}`;
}

export function assertReadOnlyOperations(
  operations: McpServerOperation[] | undefined
): McpServerOperation[] {
  if (!operations || operations.length === 0) {
    throw new McpServerError(
      400,
      'A custom connector needs an operation definition',
      'OPERATIONS_REQUIRED'
    );
  }
  const ids = new Set<string>();
  return operations.map((operation) => {
    if (operation.method !== 'GET' || operation.readOnly !== true) {
      throw new McpServerError(
        400,
        'Each operation must be a read-only GET',
        'READ_ONLY_REQUIRED'
      );
    }
    const id = operation.id?.trim();
    if (!id || ids.has(id)) {
      throw new McpServerError(
        400,
        'Each operation needs a unique id',
        'OPERATIONS_REQUIRED'
      );
    }
    ids.add(id);
    if (
      !operation.path?.startsWith('/') ||
      operation.path.startsWith('//') ||
      operation.path.includes('..') ||
      operation.path.includes('://')
    ) {
      throw new McpServerError(
        400,
        'Operation path is not allowed',
        'URL_RESTRICTED'
      );
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

export function importOpenApiOperations(
  document: unknown,
  baseUrl: string
): McpServerOperation[] {
  if (!document || typeof document !== 'object') {
    throw new McpServerError(
      400,
      'OpenAPI document is required',
      'OPERATIONS_REQUIRED'
    );
  }
  const doc = document as OpenApiDocument;
  const declared = doc.servers?.find((server) => server.url)?.url;
  if (declared) {
    let server: URL;
    try {
      server = new URL(declared, baseUrl);
    } catch {
      throw new McpServerError(
        400,
        'OpenAPI server URL does not match the connection URL',
        'URL_RESTRICTED'
      );
    }
    const base = new URL(baseUrl);
    if (server.origin !== base.origin) {
      throw new McpServerError(
        400,
        'OpenAPI server URL does not match the connection URL',
        'URL_RESTRICTED'
      );
    }
  }
  const operations: McpServerOperation[] = [];
  for (const [path, methods] of Object.entries(doc.paths ?? {})) {
    const get = methods?.get;
    if (!get) continue;
    const id =
      get.operationId?.trim() ||
      `get_${path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
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
