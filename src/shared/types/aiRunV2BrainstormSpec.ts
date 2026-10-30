/**
 * Type guards for the Brainstorm sections of a V2 execution specification.
 * A missing field refuses the run. The worker does not fill one in.
 */
import type { BrainstormTurnSources } from './brainstormSources';
import {
  isBrainstormArtifactType,
  type BrainstormTurnIntent,
  type FrozenBrainstormArtifact,
} from './brainstormArtifact';

const SHA_40 = /^[a-f0-9]{40}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReadRoot(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.sourceId === 'string' && UUID.test(value.sourceId)
    && (value.kind === 'project-repository' || value.kind === 'temporary-repository')
    && typeof value.displayName === 'string' && value.displayName.length > 0
    && typeof value.workspacePath === 'string' && value.workspacePath.length > 0
    && typeof value.commitSha === 'string' && SHA_40.test(value.commitSha)
    && (value.provider === 'github' || value.provider === 'ado')
    && typeof value.project === 'string' && value.project.length > 0
    && typeof value.repository === 'string' && value.repository.length > 0
  );
}

function isUnavailable(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.sourceId === 'string' && UUID.test(value.sourceId)
    && typeof value.displayName === 'string'
    && typeof value.reason === 'string'
  );
}

function isMcpTool(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.toolName === 'string' && value.toolName.length > 0
    && typeof value.toolId === 'string' && value.toolId.length > 0;
}

function isMcpServer(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.tools)) return false;
  return (
    typeof value.connectionId === 'string' && UUID.test(value.connectionId)
    && typeof value.displayName === 'string' && value.displayName.length > 0
    && typeof value.toolPrefix === 'string' && value.toolPrefix.length > 0
    && value.tools.every(isMcpTool)
  );
}

export function isBrainstormTurnArtifact(value: unknown): value is FrozenBrainstormArtifact {
  if (!isRecord(value)) return false;
  return (
    (value.type === null || isBrainstormArtifactType(value.type))
    && Number.isSafeInteger(value.version) && (value.version as number) >= 0
    && typeof value.markdown === 'string'
  );
}

export function isBrainstormTurnIntent(value: unknown): value is BrainstormTurnIntent {
  if (!isRecord(value)) return false;
  if (value.kind === 'chat') return true;
  return value.kind === 'type_switch' && isBrainstormArtifactType(value.targetType);
}

export function isBrainstormTurnSources(value: unknown): value is BrainstormTurnSources {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.readRoots) || !value.readRoots.every(isReadRoot)) return false;
  if (!Array.isArray(value.unavailableSources) || !value.unavailableSources.every(isUnavailable)) return false;
  if (!Array.isArray(value.mcpServers) || !value.mcpServers.every(isMcpServer)) return false;
  return typeof value.instructions === 'string' && value.instructions.length > 0;
}
