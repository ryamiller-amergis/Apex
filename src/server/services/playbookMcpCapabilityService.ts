import type { PlaybookGraph } from '../../shared/types/playbook';
import {
  ATS_BOARD_PUBLIC_WEB_MCP_PROFILE,
  ATS_BOARD_REPOSITORY_ONLY_MCP_PROFILE,
} from '../../shared/atsBoardMcp';

export type PlaybookMcpCapabilityMode = 'read' | 'write' | 'unknown';

export interface PlaybookMcpCapability {
  mode: PlaybookMcpCapabilityMode;
  serverKeys: string[];
  evidence: string[];
}

const MCP_PROFILES: Readonly<Record<string, PlaybookMcpCapability>> = {
  [ATS_BOARD_REPOSITORY_ONLY_MCP_PROFILE]: {
    mode: 'read',
    serverKeys: ['github-repo'],
    evidence: [
      'The profile is read-only: GitHub mounts github-repo only; ADO uses native repository reads and mounts no MCP server.',
    ],
  },
  [ATS_BOARD_PUBLIC_WEB_MCP_PROFILE]: {
    mode: 'read',
    serverKeys: ['github-repo', 'web-search'],
    evidence: [
      'The profile is read-only: repository reads plus a project-configured web-search MCP only; ado-skills and user MCP pills are not mounted.',
      'Public web research is charter-bound and must not be treated as Amergis-internal fact.',
    ],
  },
  'ado-skills': {
    mode: 'write',
    serverKeys: ['ado-skills'],
    evidence: [
      'ado-skills exposes update_design_doc, update_prd, update_adr, and other mutation tools.',
    ],
  },
};

export class PlaybookMcpCapabilityError extends Error {
  readonly nodeId: string;
  readonly profile: string | undefined;

  constructor(nodeId: string, profile: string | undefined, mode: PlaybookMcpCapabilityMode) {
    super(
      `Cursor-agent step "${nodeId}" MCP profile must be server-verified read-only; ` +
        `${profile ? `"${profile}" resolves to ${mode}` : 'no MCP profile was configured'}.`,
    );
    this.name = 'PlaybookMcpCapabilityError';
    this.nodeId = nodeId;
    this.profile = profile;
  }
}

/** Server-owned catalog lookup. Graph authors cannot declare their own capability. */
export function resolvePlaybookMcpCapability(profile: unknown): PlaybookMcpCapability {
  if (typeof profile !== 'string' || !profile.trim()) {
    return { mode: 'unknown', serverKeys: [], evidence: ['No MCP profile was configured.'] };
  }
  return MCP_PROFILES[profile] ?? {
    mode: 'unknown',
    serverKeys: [],
    evidence: [`MCP profile "${profile}" is not registered in the server capability catalog.`],
  };
}

export function isReadOnlyCursorAgentNode(
  node: PlaybookGraph['nodes'][number],
): boolean {
  // board-deliberation is a server-owned composite agent step. Its adapter fixes every internal
  // turn to repository-read-only; graph authors cannot supply a different profile.
  if (node.stepType === 'board-deliberation') return true;
  return node.stepType === 'cursor-agent'
    && resolvePlaybookMcpCapability(node.config?.mcpProfile).mode === 'read';
}

/** Publish-time project-wide rule for every cursor-agent node. */
export function assertCursorAgentsUseReadOnlyMcp(graph: PlaybookGraph): void {
  for (const node of graph.nodes) {
    if (node.stepType !== 'cursor-agent') continue;
    const profile = typeof node.config?.mcpProfile === 'string'
      ? node.config.mcpProfile
      : undefined;
    const capability = resolvePlaybookMcpCapability(profile);
    if (capability.mode !== 'read') {
      throw new PlaybookMcpCapabilityError(node.id, profile, capability.mode);
    }
  }
}
