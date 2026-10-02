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

export class InteractiveToolProxyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 502 | 503 = 400,
  ) {
    super(message);
    this.name = 'InteractiveToolProxyError';
  }
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
  /**
   * Injectable internal MCP handlers (tests + production wiring).
   * Keys: ado-skills | calendar-assistant | maxview
   */
  invokeInternal?: (
    serverName: 'ado-skills' | 'calendar-assistant' | 'maxview',
    descriptor: Extract<FrozenInteractiveMcpDescriptor, { kind: 'internal-proxy' }>,
    body: unknown,
    context: Readonly<{
      grant: FrozenInteractiveToolGrant | null;
      delegatedAdoToken: string | null;
      signal?: AbortSignal;
    }>,
  ) => Promise<unknown>;
}>;

function findDescriptor(
  specification: DurableInteractiveTurnSpecification,
  serverName: string,
): FrozenInteractiveMcpDescriptor {
  const descriptor = specification.mcpServers.find(
    (entry) => entry.serverName === serverName,
  );
  if (!descriptor) {
    throw new InteractiveToolProxyError(
      `Unknown interactive MCP server: ${serverName}`,
      404,
    );
  }
  return descriptor;
}

function resolveHeaderEnvRefs(
  headerEnvRefs: Readonly<Record<string, string>>,
  resolveHeaderEnv: (envRef: string) => string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
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

  const response = await options.fetchImpl(descriptor.url, {
    method: 'POST',
    headers: resolveHeaderEnvRefs(
      descriptor.headerEnvRefs,
      options.resolveHeaderEnv,
    ),
    body: JSON.stringify(body ?? {}),
    signal: options.signal,
  });
  const text = await response.text();
  let parsedBody: unknown = {};
  if (text) {
    try {
      parsedBody = JSON.parse(text);
    } catch {
      throw new InteractiveToolProxyError(
        'External MCP returned non-JSON',
        502,
      );
    }
  }
  if (!response.ok) {
    throw new InteractiveToolProxyError(
      `External MCP failed (${response.status})`,
      502,
    );
  }
  return parsedBody;
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

  const descriptor = findDescriptor(specification, claims.serverName);
  const fetchImpl = request.fetchImpl ?? fetch;
  const resolveHeaderEnv =
    request.resolveHeaderEnv ?? ((envRef) => process.env[envRef]);

  let delegatedAdoToken: string | null = null;
  if (specification.toolGrant) {
    try {
      delegatedAdoToken = decryptInteractiveToolGrant(specification.toolGrant, {
        userId: specification.toolGrant.userId,
        projectId: specification.toolGrant.projectId,
      });
    } catch (error) {
      if (error instanceof InteractiveToolGrantError) {
        throw new InteractiveToolProxyError(error.message, error.status);
      }
      throw error;
    }
  }

  switch (descriptor.kind) {
    case 'internal-proxy': {
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
