import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { mcpServers } from '../db/schema';
import {
  PREBUILT_CONNECTORS,
  selectEnabledMcpOperations,
  type McpServerOperation,
  type McpServerProvider,
  type PrebuiltProvider,
} from '../../shared/types/mcpServers';
import { decryptMcpServerCredential } from './mcpServerCredentialCrypto';
import {
  callMcpServerTool,
  callRemoteMcpTool,
  parseRemoteMcpCredential,
  parseStoredClientCredential,
} from './mcpServerDiscovery';
import {
  defaultMcpServerFetch,
  headersForRemoteMcpServer,
  type McpServerFetch,
} from './mcpServerConnectionService';
import { McpServerError } from './mcpServerErrors';
import { joinMcpServerUrl } from './mcpServerOpenApi';

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

export interface McpServerReadInput {
  project: string;
  connectionId: string;
  userId: string;
  operationId: string;
  params?: Record<string, string>;
  fetchImpl?: McpServerFetch;
}

export interface McpServerReadResult {
  operationId: string;
  status: number;
  body: string;
}

function authHeaders(
  provider: McpServerProvider,
  credential: string
): Record<string, string> {
  if (
    provider === 'pendo' ||
    (provider !== 'custom' &&
      PREBUILT_CONNECTORS[provider as PrebuiltProvider]?.auth ===
        'pendo-integration-key')
  ) {
    return { 'x-pendo-integration-key': credential };
  }
  return { Authorization: `Bearer ${credential}` };
}

export function buildMcpServerReadUrl(
  baseUrl: string,
  pathTemplate: string,
  params: Record<string, string>
): string {
  let path = pathTemplate;
  const query = { ...params };
  for (const placeholder of pathTemplate.match(/\{([^}]+)\}/g) ?? []) {
    const key = placeholder.slice(1, -1);
    const value = query[key];
    if (
      value === undefined ||
      value.includes('..') ||
      value.includes('/') ||
      value.includes('\\')
    ) {
      throw new McpServerError(
        400,
        'Invalid operation parameter',
        'OPERATION_PARAMS'
      );
    }
    path = path.replace(placeholder, encodeURIComponent(value));
    delete query[key];
  }
  const url = joinMcpServerUrl(baseUrl, path);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function loadRow(
  project: string,
  connectionId: string
): Promise<ConnectionRow | null> {
  const rows = await db
    .select()
    .from(mcpServers)
    .where(
      and(
        eq(mcpServers.id, connectionId),
        eq(mcpServers.project, project)
      )
    );
  return (rows[0] as ConnectionRow | undefined) ?? null;
}

async function loadRowById(
  connectionId: string
): Promise<ConnectionRow | null> {
  const rows = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, connectionId));
  return (rows[0] as ConnectionRow | undefined) ?? null;
}

function operationOrThrow(
  row: ConnectionRow,
  operationId: string
): McpServerOperation {
  const operation = (row.operations ?? []).find(
    (item) => item.id === operationId
  );
  if (!operation || operation.method !== 'GET' || operation.readOnly !== true) {
    throw new McpServerError(
      403,
      'That operation is not allowed for this connection',
      'OPERATION_NOT_ALLOWED'
    );
  }
  return operation;
}

async function callOperation(
  row: ConnectionRow,
  operation: McpServerOperation,
  params: Record<string, string>,
  fetchImpl: McpServerFetch
): Promise<McpServerReadResult> {
  if (!row.baseUrl) {
    throw new McpServerError(
      400,
      'Connection URL is missing',
      'OPERATION_NOT_ALLOWED'
    );
  }
  const credential = decryptMcpServerCredential(
    {
      algorithm: 'aes-256-gcm',
      iv: row.credentialIv,
      ciphertext: row.credentialCiphertext,
      authTag: row.credentialAuthTag,
    },
    { project: row.project, connectionId: row.id }
  );
  const result = await fetchImpl(
    buildMcpServerReadUrl(row.baseUrl, operation.path, params),
    {
      method: 'GET',
      headers: authHeaders(row.provider, credential),
    }
  );
  if (result.status < 200 || result.status >= 300) {
    throw new McpServerError(
      502,
      'Integration read failed',
      'REQUEST_FAILED'
    );
  }
  return {
    operationId: operation.id,
    status: result.status,
    body: result.body,
  };
}

function assertCallerAllowed(_row: ConnectionRow, userId: string): void {
  if (!userId) {
    throw new McpServerError(
      403,
      'You cannot use this connection',
      'NOT_ALLOWED'
    );
  }
}

export async function assertCallerCanUseMcpServer(input: {
  project: string;
  connectionId: string;
  userId: string;
}): Promise<void> {
  const row = await loadRow(input.project, input.connectionId);
  if (!row) {
    throw new McpServerError(
      404,
      'Connection not found',
      'NOT_FOUND'
    );
  }
  assertCallerAllowed(row, input.userId);
}

export async function executeMcpServerRead(
  input: McpServerReadInput
): Promise<McpServerReadResult> {
  const row = await loadRow(input.project, input.connectionId);
  if (!row) {
    throw new McpServerError(
      404,
      'Connection not found',
      'NOT_FOUND'
    );
  }
  assertCallerAllowed(row, input.userId);
  const operation = operationOrThrow(row, input.operationId);
  return callOperation(
    row,
    operation,
    input.params ?? {},
    input.fetchImpl ?? defaultMcpServerFetch
  );
}

/** Tool-server entry. Bound to one connection and the calling user from the mount URL. */
export async function executeMountedMcpServerRead(
  connectionId: string,
  userId: string,
  operationId: string,
  params: Record<string, string> = {},
  fetchImpl: McpServerFetch = defaultMcpServerFetch
): Promise<McpServerReadResult> {
  const row = await loadRowById(connectionId);
  if (!row) {
    throw new McpServerError(
      404,
      'Connection not found',
      'NOT_FOUND'
    );
  }
  assertCallerAllowed(row, userId);
  const operation = operationOrThrow(row, operationId);
  return callOperation(row, operation, params, fetchImpl);
}

function enabledOperations(row: ConnectionRow): McpServerOperation[] {
  const credential = decryptMcpServerCredential(
    {
      algorithm: 'aes-256-gcm',
      iv: row.credentialIv,
      ciphertext: row.credentialCiphertext,
      authTag: row.credentialAuthTag,
    },
    { project: row.project, connectionId: row.id },
  );
  const remote = parseRemoteMcpCredential(credential);
  return selectEnabledMcpOperations(row.operations ?? [], remote?.toolNames ?? []).filter(
    (operation) => operation.id !== 'get_more_tools',
  );
}

export function supportsTimestampBoundarySearch(operation: McpServerOperation): boolean {
  const props = operation.inputSchema?.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return false;
  const record = props as Record<string, unknown>;
  return (
    Object.prototype.hasOwnProperty.call(record, 'offset') &&
    Object.prototype.hasOwnProperty.call(record, 'limit') &&
    Object.prototype.hasOwnProperty.call(record, 'order_by')
  );
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isFinite(num)) {
        return num > 0 && num < 1e11 ? Math.round(num * 1000) : Math.round(num);
      }
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

interface ExtractedBoundaryFilter {
  sinceMs: number | null;
  untilMs: number | null;
  field: string;
  cleanArgs: Record<string, unknown>;
}

function extractBoundaryFilter(
  operation: McpServerOperation,
  rawArgs: Record<string, unknown>,
): ExtractedBoundaryFilter | null {
  if (!supportsTimestampBoundarySearch(operation)) return null;
  const schemaProps =
    operation.inputSchema?.properties &&
    typeof operation.inputSchema.properties === 'object' &&
    !Array.isArray(operation.inputSchema.properties)
      ? (operation.inputSchema.properties as Record<string, unknown>)
      : {};

  const cleanArgs: Record<string, unknown> = {};
  let sinceMs = parseTimestampMs(rawArgs.since_timestamp_ms);
  let untilMs = parseTimestampMs(rawArgs.until_timestamp_ms);
  let inferredField: string | null = null;

  for (const [key, value] of Object.entries(rawArgs)) {
    if (key === 'since_timestamp_ms' || key === 'until_timestamp_ms') {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(schemaProps, key)) {
      const afterMatch = key.match(/^([a-z0-9_]+)_(?:after|since|gte|from)$/i);
      if (afterMatch) {
        const parsed = parseTimestampMs(value);
        if (parsed !== null) {
          sinceMs ??= parsed;
          inferredField ??= afterMatch[1];
        }
        continue;
      }
      const beforeMatch = key.match(/^([a-z0-9_]+)_(?:before|until|lt|lte|to)$/i);
      if (beforeMatch) {
        const parsed = parseTimestampMs(value);
        if (parsed !== null) {
          untilMs ??= parsed;
          inferredField ??= beforeMatch[1];
        }
        continue;
      }
    }
    cleanArgs[key] = value;
  }

  if (sinceMs === null && untilMs === null) return null;

  const rawOrderBy = typeof cleanArgs.order_by === 'string' ? cleanArgs.order_by.trim() : '';
  const orderField = rawOrderBy.replace(/^[-+]/, '').trim();
  const field = orderField || inferredField || 'last_sign_in_at';
  cleanArgs.order_by = `-${field}`;

  return { sinceMs, untilMs, field, cleanArgs };
}

interface ParsedPagePayload {
  data: Array<Record<string, unknown>>;
  totalCount: number;
  conversationId?: string;
}

function parseMcpPagePayload(rawToolOutput: string): ParsedPagePayload | null {
  try {
    const outer = JSON.parse(rawToolOutput) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    if (outer?.isError) return null;
    const content = Array.isArray(outer?.content) ? outer.content : [];
    let data: Array<Record<string, unknown>> | null = null;
    let totalCount: number | null = null;
    let conversationId: string | undefined;
    for (const block of content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      try {
        const parsed = JSON.parse(block.text) as Record<string, unknown>;
        if (typeof parsed.conversation_id === 'string') {
          conversationId = parsed.conversation_id;
        }
        if (Array.isArray(parsed.data)) {
          data = parsed.data as Array<Record<string, unknown>>;
          totalCount =
            typeof parsed.total_count === 'number'
              ? parsed.total_count
              : data.length;
        }
      } catch {
        // Ignore non-JSON text blocks.
      }
    }
    if (!data || totalCount === null) return null;
    return { data, totalCount, conversationId };
  } catch {
    return null;
  }
}

function compactRecordForChat(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'image_url' || key === 'profile_image_url' || key === 'object') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      if (key === 'email_addresses') {
        out.email_addresses = value.map((entry) =>
          entry && typeof entry === 'object' && 'email_address' in entry
            ? (entry as { email_address?: unknown }).email_address
            : entry,
        );
        continue;
      }
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      if (Object.keys(value as Record<string, unknown>).length === 0) continue;
    }
    out[key] = value;
  }
  return out;
}

function compactOversizedMcpResult(rawToolOutput: string): string {
  if (rawToolOutput.length <= 24_000) return rawToolOutput;
  try {
    const outer = JSON.parse(rawToolOutput) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    if (!Array.isArray(outer?.content)) return rawToolOutput;
    let modified = false;
    const nextContent = outer.content.map((block) => {
      if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length <= 20_000) {
        return block;
      }
      try {
        const parsed = JSON.parse(block.text) as Record<string, unknown>;
        if (!Array.isArray(parsed.data)) return block;
        modified = true;
        const compactedData = (parsed.data as Array<Record<string, unknown>>).map((item) =>
          item && typeof item === 'object' ? compactRecordForChat(item) : item,
        );
        return {
          ...block,
          text: JSON.stringify({ ...parsed, data: compactedData }),
        };
      } catch {
        return block;
      }
    });
    return modified ? JSON.stringify({ ...outer, content: nextContent }) : rawToolOutput;
  } catch {
    return rawToolOutput;
  }
}

async function countRecordsAtOrAfterCutoff(input: {
  invoke: (args: Record<string, unknown>) => Promise<string>;
  baseArgs: Record<string, unknown>;
  field: string;
  cutoffMs: number;
  initialPage: ParsedPagePayload;
  initialLimit: number;
}): Promise<{ count: number; conversationId?: string }> {
  const { invoke, baseArgs, field, cutoffMs, initialPage, initialLimit } = input;
  let conversationId = initialPage.conversationId;
  const totalCount = initialPage.totalCount;
  const firstData = initialPage.data;
  if (totalCount === 0 || firstData.length === 0) {
    return { count: 0, conversationId };
  }

  const recordTimestampMs = (item: Record<string, unknown> | undefined): number | null =>
    item ? parseTimestampMs(item[field]) : null;

  const firstMs = recordTimestampMs(firstData[0]);
  if (firstMs === null || firstMs < cutoffMs) {
    return { count: 0, conversationId };
  }

  const lastInFirstMs = recordTimestampMs(firstData[firstData.length - 1]);
  if (lastInFirstMs === null || lastInFirstMs < cutoffMs || firstData.length < initialLimit || totalCount <= firstData.length) {
    const count = firstData.filter((item) => {
      const ms = recordTimestampMs(item);
      return ms !== null && ms >= cutoffMs;
    }).length;
    return { count, conversationId };
  }

  const probe = async (offset: number, limit: number): Promise<ParsedPagePayload | null> => {
    const raw = await invoke({
      ...baseArgs,
      offset,
      limit,
      ...(conversationId ? { conversation_id: conversationId } : {}),
    });
    const parsed = parseMcpPagePayload(raw);
    if (parsed?.conversationId) conversationId = parsed.conversationId;
    return parsed;
  };

  let low = firstData.length;
  let high = totalCount;
  const maxProbesPerRound = 6;
  const terminalSpan = 250;

  for (let round = 0; round < 4 && high - low > terminalSpan; round += 1) {
    const offsets: number[] = [];
    for (let idx = 1; idx <= maxProbesPerRound; idx += 1) {
      const candidate = Math.floor(low + ((high - low) * idx) / (maxProbesPerRound + 1));
      if (candidate > low && candidate < high && !offsets.includes(candidate)) {
        offsets.push(candidate);
      }
    }
    if (offsets.length === 0) break;
    const probeResults = await Promise.all(offsets.map((offset) => probe(offset, 1)));
    for (let idx = 0; idx < offsets.length; idx += 1) {
      const page = probeResults[idx];
      const ms = recordTimestampMs(page?.data?.[0]);
      if (ms !== null && ms >= cutoffMs) {
        low = offsets[idx] + 1;
      } else {
        high = offsets[idx];
        break;
      }
    }
  }

  while (high - low > 0) {
    const fetchLimit = Math.min(terminalSpan, high - low);
    const page = await probe(low, fetchLimit);
    if (!page || page.data.length === 0) break;
    let matchedInPage = 0;
    let crossedCutoff = false;
    for (const item of page.data) {
      const ms = recordTimestampMs(item);
      if (ms !== null && ms >= cutoffMs) {
        matchedInPage += 1;
      } else {
        crossedCutoff = true;
        break;
      }
    }
    low += matchedInPage;
    if (crossedCutoff || page.data.length < fetchLimit) {
      break;
    }
  }

  return { count: low, conversationId };
}

async function executeTimestampBoundaryCount(input: {
  invoke: (args: Record<string, unknown>) => Promise<string>;
  filter: ExtractedBoundaryFilter;
}): Promise<string> {
  const { invoke, filter } = input;
  const initialLimit = 50;
  const firstRaw = await invoke({
    ...filter.cleanArgs,
    offset: 0,
    limit: initialLimit,
  });
  const firstPage = parseMcpPagePayload(firstRaw);
  if (!firstPage) {
    return compactOversizedMcpResult(firstRaw);
  }

  let conversationId = firstPage.conversationId;
  const baseArgs = {
    ...filter.cleanArgs,
    ...(conversationId ? { conversation_id: conversationId } : {}),
  };

  let sinceCount = firstPage.totalCount;
  if (filter.sinceMs !== null) {
    const res = await countRecordsAtOrAfterCutoff({
      invoke,
      baseArgs,
      field: filter.field,
      cutoffMs: filter.sinceMs,
      initialPage: firstPage,
      initialLimit,
    });
    sinceCount = res.count;
    if (res.conversationId) conversationId = res.conversationId;
  }

  let untilCount = 0;
  if (filter.untilMs !== null) {
    const res = await countRecordsAtOrAfterCutoff({
      invoke,
      baseArgs: {
        ...baseArgs,
        ...(conversationId ? { conversation_id: conversationId } : {}),
      },
      field: filter.field,
      cutoffMs: filter.untilMs,
      initialPage: firstPage,
      initialLimit,
    });
    untilCount = res.count;
    if (res.conversationId) conversationId = res.conversationId;
  }

  const matchingCount = Math.max(0, sinceCount - untilCount);
  const sampleRecords = firstPage.data
    .filter((item) => {
      const ms = parseTimestampMs(item[filter.field]);
      if (ms === null) return false;
      if (filter.sinceMs !== null && ms < filter.sinceMs) return false;
      if (filter.untilMs !== null && ms >= filter.untilMs) return false;
      return true;
    })
    .slice(0, 5)
    .map((item) => compactRecordForChat(item));

  const summaryPayload = {
    matching_count: matchingCount,
    total_count: firstPage.totalCount,
    timestamp_field: filter.field,
    ...(filter.sinceMs !== null
      ? {
          since_timestamp_ms: filter.sinceMs,
          since_iso: new Date(filter.sinceMs).toISOString(),
        }
      : {}),
    ...(filter.untilMs !== null
      ? {
          until_timestamp_ms: filter.untilMs,
          until_iso: new Date(filter.untilMs).toISOString(),
        }
      : {}),
    sample_records: sampleRecords,
  };

  const content: Array<{ type: 'text'; text: string }> = [
    { type: 'text', text: JSON.stringify(summaryPayload) },
  ];
  if (conversationId) {
    content.push({
      type: 'text',
      text: JSON.stringify({ conversation_id: conversationId }),
    });
  }
  return JSON.stringify({ content });
}

export async function listMountedMcpTools(
  connectionId: string
): Promise<McpServerOperation[]> {
  const row = await loadRowById(connectionId);
  if (!row) return [];
  return enabledOperations(row);
}

function withDefaultContextArg(
  operation: McpServerOperation,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const props = operation.inputSchema?.properties;
  if (
    props &&
    typeof props === 'object' &&
    !Array.isArray(props) &&
    Object.prototype.hasOwnProperty.call(props, 'context') &&
    (typeof args.context !== 'string' || !args.context.trim())
  ) {
    return { ...args, context: 'Answer user question in Apex' };
  }
  return args;
}

export async function executeMountedMcpTool(
  connectionId: string,
  userId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  const row = await loadRowById(connectionId);
  if (!row) {
    throw new McpServerError(404, 'Connection not found', 'NOT_FOUND');
  }
  assertCallerAllowed(row, userId);
  const operation = enabledOperations(row).find((item) => item.id === toolName);
  if (!operation) {
    throw new McpServerError(403, 'That tool is not allowed for this connection', 'OPERATION_NOT_ALLOWED');
  }
  const credential = decryptMcpServerCredential(
    {
      algorithm: 'aes-256-gcm',
      iv: row.credentialIv,
      ciphertext: row.credentialCiphertext,
      authTag: row.credentialAuthTag,
    },
    { project: row.project, connectionId: row.id }
  );
  const normalizedArgs = withDefaultContextArg(operation, args ?? {});
  const boundaryFilter = extractBoundaryFilter(operation, normalizedArgs);

  if (parseRemoteMcpCredential(credential)) {
    if (!row.baseUrl) {
      throw new McpServerError(400, 'This connection has no MCP server', 'TOOLS_UNAVAILABLE');
    }
    const headers = await headersForRemoteMcpServer(row);
    const invoke = (callArgs: Record<string, unknown>) =>
      callRemoteMcpTool({
        mcpUrl: row.baseUrl!,
        headers,
        toolName,
        args: withDefaultContextArg(operation, callArgs),
      });
    if (boundaryFilter) {
      return executeTimestampBoundaryCount({ invoke, filter: boundaryFilter });
    }
    return compactOversizedMcpResult(await invoke(normalizedArgs));
  }
  if (!isPrebuiltProvider(row.provider)) {
    throw new McpServerError(403, 'That tool is not allowed for this connection', 'OPERATION_NOT_ALLOWED');
  }
  const connector = PREBUILT_CONNECTORS[row.provider];
  if (!connector.mcpUrl) {
    throw new McpServerError(400, 'This connection has no MCP server', 'TOOLS_UNAVAILABLE');
  }
  const stored = parseStoredClientCredential(credential);
  const invoke = (callArgs: Record<string, unknown>) =>
    callMcpServerTool({
      mcpUrl: connector.mcpUrl!,
      clientId: stored.clientId,
      clientSecret: stored.clientSecret,
      toolName,
      args: withDefaultContextArg(operation, callArgs),
    });
  if (boundaryFilter) {
    return executeTimestampBoundaryCount({ invoke, filter: boundaryFilter });
  }
  return compactOversizedMcpResult(await invoke(normalizedArgs));
}

function isPrebuiltProvider(provider: McpServerProvider): provider is PrebuiltProvider {
  return provider !== 'custom';
}
