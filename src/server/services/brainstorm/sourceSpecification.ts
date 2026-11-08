import {
  BRAINSTORM_SOURCE_BASE_INSTRUCTIONS,
  type BrainstormTurnSources,
} from '../../../shared/types/brainstormSources';
import type { FrozenBrainstormTurn } from '../../../shared/types/durableInteractiveTurn';
import type { GatewayTool } from './mcpReadGateway';
import { sourceWorkspacePath, type SourceRecord } from './sourceWorkspaceStore';

export function buildBrainstormTurnSources(input: {
  ready: SourceRecord[];
  unavailable: SourceRecord[];
  mcpTools: GatewayTool[];
  limits: FrozenBrainstormTurn['sourceLimits'];
  dataRoot: string;
}): BrainstormTurnSources {
  const readRoots = input.ready
    .filter((row) => row.kind !== 'mcp-server' && row.commitSha && row.groundingProvider && row.groundingRepository)
    .map((row) => ({
      sourceId: row.id,
      kind: row.kind as 'project-repository' | 'temporary-repository',
      displayName: row.displayName,
      workspacePath: row.workspacePath || sourceWorkspacePath(input.dataRoot, row.sessionId, row.id),
      commitSha: row.commitSha!,
      provider: row.groundingProvider!,
      project: row.groundingProject || row.project,
      repository: row.groundingRepository!,
    }));
  const unavailableSources = input.unavailable
    .filter((row) => row.kind !== 'mcp-server')
    .map((row) => ({
      sourceId: row.id,
      displayName: row.displayName,
      reason: row.reasonText || 'This source is not loaded.',
    }));
  const byConnection = new Map<string, BrainstormTurnSources['mcpServers'][number]>();
  for (const tool of input.mcpTools) {
    const current = byConnection.get(tool.connectionId) ?? {
      connectionId: tool.connectionId,
      displayName: tool.displayName,
      toolPrefix: tool.toolPrefix,
      tools: [],
    };
    current.tools = [...current.tools, {
      toolName: tool.toolName,
      toolId: tool.toolId,
      ...(tool.summary ? { summary: tool.summary } : {}),
    }];
    byConnection.set(tool.connectionId, current);
  }
  const lines = [BRAINSTORM_SOURCE_BASE_INSTRUCTIONS];
  for (const source of unavailableSources) {
    lines.push(`The source "${source.displayName}" was not searched. Do not claim that you read it.`);
  }
  lines.push(`Workspace limit: ${input.limits.workspaceMaxBytes} bytes. Inactivity: ${input.limits.inactivityMs} ms.`);
  return {
    readRoots,
    unavailableSources,
    mcpServers: [...byConnection.values()],
    instructions: lines.join('\n'),
  };
}
