/**
 * App Service MCP proxy for durable interactive turns.
 *
 * Relays actor tool calls to Apex domain MCP handlers or a frozen external
 * HTTPS MCP URL. Never imports Cursor/model.
 */
import type {
  DurableInteractiveTurnSpecification,
  FrozenInteractiveMcpDescriptor,
  FrozenInteractiveToolGrant,
} from '../../shared/types/durableInteractiveTurn';
import {
  decryptInteractiveToolGrant,
  InteractiveToolGrantError,
} from './interactiveToolGrantCrypto';
import type { InteractiveToolProxyTokenClaims } from './interactiveToolProxyToken';
import {
  CustomToolRegistryError,
  dispatchHarnessCustomTool,
  type CustomToolDescriptor,
  type CustomToolExecutionContext,
  type CustomToolProposalResult,
} from './chatHarness/customToolRegistry';

export class InteractiveToolProxyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 502 | 503 = 400,
  ) {
    super(message);
    this.name = 'InteractiveToolProxyError';
  }
}

// The MCP Streamable HTTP transport answers 406 unless the client accepts both.
const MCP_ACCEPT = 'application/json, text/event-stream';

function lastServerSentEventData(text: string): string {
  let last = '';
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data) last = data;
  }
  return last;
}

async function postMcp(
  label: 'Internal' | 'External',
  url: string,
  headers: Readonly<Record<string, string>>,
  body: unknown,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<unknown> {
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: MCP_ACCEPT,
      ...headers,
    },
    body: JSON.stringify(body ?? {}),
    signal: options.signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new InteractiveToolProxyError(
      `${label} MCP failed (${response.status})`,
      502,
    );
  }
  const payload = (response.headers.get('content-type') ?? '').includes('text/event-stream')
    ? lastServerSentEventData(text)
    : text;
  if (!payload) return {};
  try {
    return JSON.parse(payload);
  } catch {
    throw new InteractiveToolProxyError(`${label} MCP returned non-JSON`, 502);
  }
}

/** Posts one JSON-RPC message to an Apex MCP endpoint on this host. */
export function postLocalMcp(
  url: string,
  body: unknown,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<unknown> {
  return postMcp('Internal', url, {}, body, options);
}

export type InteractiveToolProxyRequest = Readonly<{
  claims: InteractiveToolProxyTokenClaims;
  specification: DurableInteractiveTurnSpecification;
  body: unknown;
  /**
   * Optional absolute deadline remaining for this tool call (ms). Callers arm
   * the abort from bootstrap `effectiveDeadlines.toolCallMs`.
   */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  resolveHeaderEnv?: (envRef: string) => string | undefined;
  /** Optional clock override for deterministic grant expiry checks in tests. */
  now?: Date;
  /**
   * Injectable internal MCP handlers (tests + production wiring).
   * Keys: ado-skills | calendar-assistant | maxview
   */
  invokeInternal?: (
    serverName: Extract<FrozenInteractiveMcpDescriptor, { kind: 'internal-proxy' }>['serverName'],
    descriptor: Extract<FrozenInteractiveMcpDescriptor, { kind: 'internal-proxy' }>,
    body: unknown,
    context: Readonly<{
      grant: FrozenInteractiveToolGrant | null;
      delegatedAdoToken: string | null;
      signal?: AbortSignal;
    }>,
  ) => Promise<unknown>;
  /**
   * Injectable custom-tool dispatcher (defaults to App Service `dispatchHarnessCustomTool`).
   */
  invokeCustomTool?: (
    context: CustomToolExecutionContext,
  ) => Promise<CustomToolProposalResult>;
}>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extractRequestedToolName(body: unknown): string | undefined {
  if (!isPlainRecord(body)) return undefined;
  if (typeof body.toolName === 'string' && body.toolName.trim().length > 0) {
    return body.toolName.trim();
  }
  if (typeof body.name === 'string' && body.name.trim().length > 0) {
    return body.name.trim();
  }
  return undefined;
}

function findDescriptor(
  specification: DurableInteractiveTurnSpecification,
  serverName: string,
  body: unknown,
): FrozenInteractiveMcpDescriptor {
  const requestedToolName = extractRequestedToolName(body);
  if (requestedToolName) {
    const exactCustom = specification.mcpServers.find(
      (entry) =>
        entry.kind === 'custom-tool' &&
        entry.serverName === serverName &&
        entry.toolName === requestedToolName,
    );
    if (exactCustom) return exactCustom;
  }

  const byServerName = specification.mcpServers.find(
    (entry) => entry.serverName === serverName,
  );
  if (byServerName) return byServerName;

  const byProxyTarget = specification.mcpServers.find(
    (entry) =>
      entry.kind === 'custom-tool' &&
      entry.proxyTarget === serverName &&
      (!requestedToolName || entry.toolName === requestedToolName),
  );
  if (byProxyTarget) return byProxyTarget;

  throw new InteractiveToolProxyError(
    `Unknown interactive MCP server: ${serverName}`,
    404,
  );
}

function customToolRequiresGrant(descriptor: CustomToolDescriptor): boolean {
  return (
    descriptor.writes ||
    descriptor.proxyTarget.startsWith('ado-skills/') ||
    descriptor.proxyTarget.startsWith('calendar-assistant/') ||
    descriptor.proxyTarget.startsWith('cab-release/')
  );
}

function validateCustomToolGrant(
  descriptor: CustomToolDescriptor,
  specification: DurableInteractiveTurnSpecification,
  now: Date,
): string | null {
  const grant = specification.toolGrant;
  if (!grant) {
    if (customToolRequiresGrant(descriptor)) {
      throw new InteractiveToolProxyError(
        'Valid frozen tool grant is required for this custom tool',
        403,
      );
    }
    return null;
  }

  if (
    grant.userId !== specification.userId ||
    grant.projectId !== specification.projectId
  ) {
    throw new InteractiveToolProxyError(
      'Frozen tool grant does not match turn user or project',
      403,
    );
  }

  const expiresAtMs = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAtMs) || now.getTime() >= expiresAtMs) {
    throw new InteractiveToolProxyError('Frozen tool grant is expired', 403);
  }

  if (grant.encryptedAdoToken === null) {
    return null;
  }

  try {
    return decryptInteractiveToolGrant(grant, {
      userId: specification.userId,
      projectId: specification.projectId,
      now,
    });
  } catch (error) {
    if (error instanceof InteractiveToolGrantError) {
      throw new InteractiveToolProxyError(
        error.message,
        error.status === 503 ? 503 : 403,
      );
    }
    throw error;
  }
}

function parseCustomToolBody(
  descriptor: CustomToolDescriptor,
  body: unknown,
): { toolName: string; args: Record<string, unknown> } {
  if (body === undefined || body === null) {
    return { toolName: descriptor.toolName, args: {} };
  }
  if (!isPlainRecord(body)) {
    throw new InteractiveToolProxyError(
      'Custom tool request body must be an object',
      400,
    );
  }
  if (typeof body.toolName === 'string') {
    const args = isPlainRecord(body.args)
      ? body.args
      : isPlainRecord(body.arguments)
        ? body.arguments
        : {};
    return { toolName: body.toolName, args };
  }
  if (
    typeof body.name === 'string' &&
    (body.args !== undefined || body.arguments !== undefined)
  ) {
    const args = isPlainRecord(body.args)
      ? body.args
      : isPlainRecord(body.arguments)
        ? body.arguments
        : {};
    return { toolName: body.name, args };
  }
  return { toolName: descriptor.toolName, args: body };
}

function resolveHeaderEnvRefs(
  headerEnvRefs: Readonly<Record<string, string>>,
  resolveHeaderEnv: (envRef: string) => string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [header, envRef] of Object.entries(headerEnvRefs)) {
    const value = resolveHeaderEnv(envRef);
    if (!value?.trim()) {
      throw new InteractiveToolProxyError(
        `Missing environment value for MCP header ${header}`,
        503,
      );
    }
    headers[header] = value;
  }
  return headers;
}

async function relayExternalHttp(
  descriptor: Extract<
    FrozenInteractiveMcpDescriptor,
    { kind: 'external-http-proxy' }
  >,
  body: unknown,
  options: {
    signal?: AbortSignal;
    fetchImpl: typeof fetch;
    resolveHeaderEnv: (envRef: string) => string | undefined;
  },
): Promise<unknown> {
  let parsed: URL;
  try {
    parsed = new URL(descriptor.url);
  } catch {
    throw new InteractiveToolProxyError('Invalid external MCP URL', 400);
  }
  if (parsed.protocol !== 'https:') {
    throw new InteractiveToolProxyError(
      'External interactive MCP proxy requires HTTPS',
      400,
    );
  }

  return postMcp(
    'External',
    descriptor.url,
    resolveHeaderEnvRefs(descriptor.headerEnvRefs, options.resolveHeaderEnv),
    body,
    options,
  );
}

function decryptNonCustomToolGrant(
  specification: DurableInteractiveTurnSpecification,
  now: Date,
): string | null {
  if (!specification.toolGrant) return null;
  try {
    return decryptInteractiveToolGrant(specification.toolGrant, {
      userId: specification.toolGrant.userId,
      projectId: specification.toolGrant.projectId,
      now,
    });
  } catch (error) {
    if (error instanceof InteractiveToolGrantError) {
      throw new InteractiveToolProxyError(error.message, error.status);
    }
    throw error;
  }
}

/**
 * Invoke an allowed MCP tool for a verified run/attempt/fence token.
 * Decrypts the run-bound ADO grant only when the matching descriptor needs it.
 */
export async function invokeInteractiveToolProxy(
  request: InteractiveToolProxyRequest,
): Promise<unknown> {
  const { claims, specification, body } = request;
  if (claims.serverName.trim().length === 0) {
    throw new InteractiveToolProxyError('serverName is required', 400);
  }

  const descriptor = findDescriptor(specification, claims.serverName, body);
  const fetchImpl = request.fetchImpl ?? fetch;
  const resolveHeaderEnv =
    request.resolveHeaderEnv ?? ((envRef) => process.env[envRef]);
  const now = request.now ?? new Date();

  switch (descriptor.kind) {
    case 'custom-tool': {
      const delegatedAdoToken = validateCustomToolGrant(
        descriptor,
        specification,
        now,
      );
      const { toolName, args } = parseCustomToolBody(descriptor, body);
      const context: CustomToolExecutionContext = {
        attempt: {
          runId: claims.runId,
          attemptId: claims.attemptId,
          dispatchMessageId: claims.dispatchMessageId,
        },
        userId: specification.userId,
        projectId: specification.projectId,
        threadId: specification.threadId,
        descriptor,
        toolGrant: specification.toolGrant,
        delegatedAdoToken,
        toolName,
        args,
      };

      try {
        return request.invokeCustomTool
          ? await request.invokeCustomTool(context)
          : await dispatchHarnessCustomTool(context);
      } catch (error) {
        if (error instanceof CustomToolRegistryError) {
          throw new InteractiveToolProxyError(error.message, error.status);
        }
        throw error;
      }
    }
    case 'internal-proxy': {
      const delegatedAdoToken = decryptNonCustomToolGrant(specification, now);
      if (!request.invokeInternal) {
        throw new InteractiveToolProxyError(
          'Internal MCP proxy handler is not configured',
          503,
        );
      }
      return request.invokeInternal(
        descriptor.serverName,
        descriptor,
        body,
        {
          grant: specification.toolGrant,
          delegatedAdoToken,
          signal: request.signal,
        },
      );
    }
    case 'external-http-proxy': {
      decryptNonCustomToolGrant(specification, now);
      return relayExternalHttp(descriptor, body, {
        signal: request.signal,
        fetchImpl,
        resolveHeaderEnv,
      });
    }
    default: {
      const unhandled: never = descriptor;
      throw new InteractiveToolProxyError(
        `Unsupported MCP descriptor: ${JSON.stringify(unhandled)}`,
        400,
      );
    }
  }
}
