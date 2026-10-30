/**
 * Lists and calls project MCP tools for a Brainstorm session.
 * Write-capable tools are refused before any outbound call.
 * `allowedUserIds` is not consulted: connector chat ignores it, and Brainstorm matches that.
 */
import { selectEnabledMcpOperations, type McpServerOperation } from '../../../shared/types/mcpServers';

export interface GatewayConnection {
  id: string;
  project: string;
  displayName: string;
  operations: McpServerOperation[];
  secret?: string;
  credentialHint?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export interface McpGatewayDeps {
  loadConnection(project: string, connectionId: string): Promise<GatewayConnection | null>;
  callOperation(input: { project: string; connectionId: string; operationId: string; userId: string }): Promise<{ body: unknown }>;
  isAttached(sessionId: string, connectionId: string): Promise<boolean>;
  track?: (name: string, properties: Record<string, string>) => void;
}

export interface GatewayTool {
  toolName: string;
  toolId: string;
  connectionId: string;
  displayName: string;
  toolPrefix: string;
  summary?: string;
}

const CALLS = new Map<string, Array<{ connectionId: string; toolId: string }>>();

export function resetMcpCallLog(): void {
  CALLS.clear();
}

export function mcpCallsFor(sessionId: string, runId: string): Array<{ connectionId: string; toolId: string }> {
  return CALLS.get(`${sessionId}::${runId}`) ?? [];
}

export function toolPrefixFor(displayName: string, connectionId: string): string {
  const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mcp';
  return `${slug}-${connectionId.replace(/-/g, '').slice(0, 4)}`;
}

export function createMcpReadGateway(deps: McpGatewayDeps) {
  const track = deps.track ?? (() => {});

  function listTools(connection: GatewayConnection): GatewayTool[] {
    const prefix = toolPrefixFor(connection.displayName, connection.id);
    return selectEnabledMcpOperations(connection.operations, []).map((operation) => ({
      toolName: `${prefix}__${operation.id}`,
      toolId: operation.id,
      connectionId: connection.id,
      displayName: connection.displayName,
      toolPrefix: prefix,
      ...(operation.summary?.trim() ? { summary: operation.summary.trim().slice(0, 160) } : {}),
    }));
  }

  return {
    listTools,

    async listForProject(project: string, connectionIds: string[]): Promise<GatewayTool[]> {
      const tools: GatewayTool[] = [];
      for (const connectionId of connectionIds) {
        const connection = await deps.loadConnection(project, connectionId);
        if (!connection || connection.project !== project) continue;
        tools.push(...listTools(connection));
      }
      return tools;
    },

    async invoke(input: {
      project: string;
      sessionId: string;
      runId: string;
      userId: string;
      connectionId: string;
      toolName: string;
      allowedToolNames: ReadonlyArray<string>;
    }): Promise<{ ok: true; body: unknown; connectionId: string; toolId: string } | { ok: false; error: string; reason: string }> {
      const connection = await deps.loadConnection(input.project, input.connectionId);
      if (!connection || connection.project !== input.project) {
        track('brainstorm.mcp.refused_tool', { reason: 'other-project' });
        return { ok: false, error: 'The server was not found.', reason: 'other-project' };
      }
      if (!(await deps.isAttached(input.sessionId, input.connectionId))) {
        track('brainstorm.mcp.refused_tool', { reason: 'not-attached' });
        return { ok: false, error: 'That server is not attached to this session.', reason: 'not-attached' };
      }
      const known = listTools(connection);
      const match = known.find((tool) => tool.toolName === input.toolName || tool.toolId === input.toolName);
      if (!match || !input.allowedToolNames.includes(match.toolName)) {
        track('brainstorm.mcp.refused_tool', { reason: 'not-read-only' });
        return { ok: false, error: 'That tool is not available.', reason: 'not-read-only' };
      }
      try {
        const result = await deps.callOperation({
          project: input.project,
          connectionId: input.connectionId,
          operationId: match.toolId,
          userId: input.userId,
        });
        const key = `${input.sessionId}::${input.runId}`;
        const log = CALLS.get(key) ?? [];
        log.push({ connectionId: input.connectionId, toolId: match.toolId });
        CALLS.set(key, log);
        return { ok: true, body: result.body, connectionId: input.connectionId, toolId: match.toolId };
      } catch {
        return { ok: false, error: 'The lookup failed.', reason: 'unreachable' };
      }
    },
  };
}

export function readOnlyOperations(operations: McpServerOperation[]): McpServerOperation[] {
  return selectEnabledMcpOperations(operations, []);
}
