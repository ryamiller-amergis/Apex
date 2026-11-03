/**
 * FEAT-003 PBI-011 — the collaborator's artifact tool, answered on App Service.
 *
 * The interactive tool proxy verifies the run token, the active attempt and the
 * dispatch fence, then hands this module the attempt's frozen specification. The
 * session, the base version and the turn intent come from that specification;
 * the model supplies only the new Markdown.
 */
import type { DurableInteractiveTurnSpecification } from '../../shared/types/durableInteractiveTurn';
import {
  BRAINSTORM_ARTIFACT_FAILURE_SUMMARIES,
  BRAINSTORM_ARTIFACT_MAX_BYTES,
  BRAINSTORM_ARTIFACT_MCP_SERVER,
  BRAINSTORM_UPDATE_ARTIFACT_TOOL,
  type BrainstormArtifactFailureCode,
  type BrainstormVersionSummaryDto,
} from '../../shared/types/brainstormArtifact';
import { BrainstormArtifactError, type ArtifactVersionStore } from './brainstormArtifactVersionStore';

export interface BrainstormArtifactMcpDeps {
  store: Pick<ArtifactVersionStore, 'applyAiChange' | 'applyTypeSwitch' | 'getArtifact'>;
  findSession: (threadId: string) => Promise<{ id: string; project: string; creatorId: string; state: string } | null>;
  recordFailure: (runId: string, code: BrainstormArtifactFailureCode) => Promise<void>;
  clearFailure: (runId: string) => Promise<void>;
  listMcpTools?: (connectionId: string) => Promise<Array<{ id: string; summary?: string; inputSchema?: Record<string, unknown> }>>;
  callMcpTool?: (input: { connectionId: string; userId: string; toolId: string; args: Record<string, unknown> }) => Promise<string>;
}

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOL = {
  name: BRAINSTORM_UPDATE_ARTIFACT_TOOL,
  description:
    'Replace the Brainstorm artifact with the complete revised Markdown. The change applies at once and is saved as a new version. '
    + 'Send the whole document, not a fragment. Raw HTML is removed.',
  inputSchema: {
    type: 'object',
    properties: {
      markdown: {
        type: 'string',
        description: `The complete artifact Markdown (at most ${BRAINSTORM_ARTIFACT_MAX_BYTES} bytes).`,
      },
    },
    required: ['markdown'],
    additionalProperties: false,
  },
} as const;

function reply(id: JsonRpcId | undefined, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: JsonRpcId | undefined, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolText(payload: Record<string, unknown>, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) };
}

function failureCodeFor(err: unknown): BrainstormArtifactFailureCode {
  if (err instanceof BrainstormArtifactError) {
    if (err.code === 'ARTIFACT_VERSION_CONFLICT') return 'ARTIFACT_VERSION_CONFLICT';
    if (err.code === 'ARTIFACT_TOO_LARGE') return 'ARTIFACT_TOO_LARGE';
    if (err.code === 'SESSION_NOT_ACTIVE') return 'SESSION_NOT_ACTIVE';
  }
  return 'INVALID_ARTIFACT_CHANGE';
}

export function createBrainstormArtifactMcp(deps: BrainstormArtifactMcpDeps) {
  async function applyChange(
    runId: string,
    specification: DurableInteractiveTurnSpecification,
    args: Record<string, unknown>,
  ): Promise<BrainstormVersionSummaryDto> {
    const frozen = specification.brainstorm;
    const session = frozen ? await deps.findSession(specification.threadId) : null;
    if (
      !frozen
      || !session
      || session.id !== frozen.sessionId
      || session.creatorId !== specification.userId
    ) {
      throw new BrainstormArtifactError('INVALID_REQUEST', 403);
    }
    if (typeof args.markdown !== 'string') throw new BrainstormArtifactError('INVALID_REQUEST', 400);
    const ctx = { sessionId: session.id, project: session.project, authorId: specification.userId };
    const { intent, artifact } = frozen;
    if (intent.kind === 'type_switch') {
      const current = await deps.store.getArtifact(session.id, session.project);
      if (current.type !== intent.targetType) {
        return deps.store.applyTypeSwitch({
          ...ctx,
          runId,
          baseVersion: artifact.version,
          newType: intent.targetType,
          markdown: args.markdown,
        });
      }
    }
    return deps.store.applyAiChange({ ...ctx, runId, baseVersion: artifact.version, markdown: args.markdown });
  }

  return {
    /** Answers one MCP JSON-RPC message for the run's frozen specification. */
    async handle(input: { runId: string; specification: DurableInteractiveTurnSpecification; body: unknown }): Promise<unknown> {
      const request = (input.body ?? {}) as JsonRpcRequest;
      const method = request.method ?? '';
      if (method.startsWith('notifications/')) return {};
      switch (method) {
        case 'initialize':
          return reply(request.id, {
            protocolVersion: typeof request.params?.protocolVersion === 'string'
              ? request.params.protocolVersion
              : '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: BRAINSTORM_ARTIFACT_MCP_SERVER, version: '1.0.0' },
          });
        case 'ping':
          return reply(request.id, {});
        case 'tools/list': {
          const attachedServers = input.specification.brainstorm?.sources?.mcpServers ?? [];
          const extraTools: Array<{
            name: string;
            description: string;
            inputSchema: Record<string, unknown>;
          }> = [];
          for (const server of attachedServers) {
            const ops = deps.listMcpTools
              ? await deps.listMcpTools(server.connectionId).catch(() => [])
              : [];
            const opsById = new Map(ops.map((op) => [op.id, op]));
            for (const tool of server.tools) {
              const op = opsById.get(tool.toolId);
              extraTools.push({
                name: tool.toolName,
                description:
                  tool.summary ||
                  op?.summary ||
                  `Read-only tool ${tool.toolId} on ${server.displayName}`,
                inputSchema: op?.inputSchema ?? {
                  type: 'object',
                  additionalProperties: true,
                },
              });
            }
          }
          return reply(request.id, { tools: [TOOL, ...extraTools] });
        }
        case 'tools/call': {
          const params = request.params ?? {};
          const requestedName = typeof params.name === 'string' ? params.name : '';
          if (requestedName !== BRAINSTORM_UPDATE_ARTIFACT_TOOL) {
            const attachedServers = input.specification.brainstorm?.sources?.mcpServers ?? [];
            for (const server of attachedServers) {
              const matched = server.tools.find(
                (tool) => tool.toolName === requestedName || tool.toolId === requestedName,
              );
              if (!matched || !deps.callMcpTool) continue;
              const args = (params.arguments ?? {}) as Record<string, unknown>;
              try {
                const raw = await deps.callMcpTool({
                  connectionId: server.connectionId,
                  userId: input.specification.userId,
                  toolId: matched.toolId,
                  args,
                });
                return reply(request.id, {
                  content: [{ type: 'text', text: raw }],
                });
              } catch (err) {
                return reply(
                  request.id,
                  toolText(
                    {
                      ok: false,
                      error: err instanceof Error ? err.message : 'MCP tool failed',
                    },
                    true,
                  ),
                );
              }
            }
            return rpcError(request.id, -32602, `Unknown tool: ${String(params.name)}`);
          }
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          try {
            const version = await applyChange(input.runId, input.specification, args);
            await deps.clearFailure(input.runId).catch(() => {});
            return reply(request.id, toolText({ ok: true, version: version.sequence }));
          } catch (err) {
            const code = failureCodeFor(err);
            await deps.recordFailure(input.runId, code).catch(() => {});
            const currentVersion = err instanceof BrainstormArtifactError ? err.details.currentVersion : undefined;
            return reply(request.id, toolText({
              ok: false,
              code,
              error: BRAINSTORM_ARTIFACT_FAILURE_SUMMARIES[code],
              ...(typeof currentVersion === 'number' ? { currentVersion } : {}),
            }, true));
          }
        }
        default:
          return rpcError(request.id, -32601, `Method not found: ${method}`);
      }
    },
  };
}

let defaultMcp: ReturnType<typeof createBrainstormArtifactMcp> | null = null;

/** Production wiring; loaded lazily so the tool proxy route does not pull the store at import. */
export async function handleBrainstormArtifactMcp(input: {
  runId: string;
  specification: DurableInteractiveTurnSpecification;
  body: unknown;
}): Promise<unknown> {
  if (!defaultMcp) {
    const store = await import('./brainstormArtifactVersionStore');
    const { findBrainstormSessionForThread } = await import('./brainstormThread');
    const { executeMountedMcpTool, listMountedMcpTools } = await import('./mcpServerReadService');
    const { readOnlyOperations } = await import('./brainstorm/mcpReadGateway');
    defaultMcp = createBrainstormArtifactMcp({
      store: store.brainstormArtifactStore,
      findSession: findBrainstormSessionForThread,
      recordFailure: store.recordArtifactFailure,
      clearFailure: store.clearArtifactFailure,
      listMcpTools: async (connectionId) =>
        readOnlyOperations(await listMountedMcpTools(connectionId)),
      callMcpTool: ({ connectionId, userId, toolId, args }) =>
        executeMountedMcpTool(connectionId, userId, toolId, args),
    });
  }
  return defaultMcp.handle(input);
}
