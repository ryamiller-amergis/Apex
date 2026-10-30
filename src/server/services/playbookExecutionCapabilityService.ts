import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PLAYBOOK_CAPABILITIES,
  type PlaybookAgentRunPolicy,
  type PlaybookCapability,
} from '../../shared/types/playbookExecutionCapability';
import type { SkillProvider } from '../../shared/types/projectSettings';
import type { PlaybookGraph } from '../../shared/types/playbook';
import {
  PlaybookMcpCapabilityError,
  resolvePlaybookMcpCapability,
} from './playbookMcpCapabilityService';

const RESOLVER_VERSION = 1;
const CAPABILITY_LINE = /^playbook-capabilities:\s*\[([^\]]*)\]\s*$/m;

export class PlaybookExecutionCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookExecutionCapabilityError';
  }
}

/** Declared capabilities, or null when the Skill does not list any. A missing list does not block a run. */
export function parsePlaybookSkillCapabilities(skillContent: string): PlaybookCapability[] | null {
  const frontmatter = skillContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const line = frontmatter?.[1].match(CAPABILITY_LINE);
  if (!line) return null;
  const capabilities = line[1]
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const unknown = capabilities.find(
    (capability) => !(PLAYBOOK_CAPABILITIES as readonly string[]).includes(capability)
  );
  if (unknown) {
    throw new PlaybookExecutionCapabilityError(
      `The Skill declares unknown Playbook capability "${unknown}".`
    );
  }
  return [...new Set(capabilities)] as PlaybookCapability[];
}

/** Graphs saved before the skill moved still name the old path. */
const MOVED_SKILL_PATHS: Record<string, string> = {
  '.cursor/skills/maxview-incident-investigation/SKILL.md':
    'playbook-skills/maxview-incident-investigation/SKILL.md',
};

function playbookContentRoots(): string[] {
  return [
    path.resolve(process.cwd()),
    path.resolve(__dirname, '..', '..', '..'),
    path.resolve(__dirname, '..', '..'),
  ];
}

export async function loadPlaybookSkillContent(skillPath: string): Promise<string> {
  const requested = skillPath.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  const relativePath = MOVED_SKILL_PATHS[requested] ?? requested;
  const tried = new Set<string>();
  for (const root of playbookContentRoots()) {
    const absolutePath = path.resolve(root, relativePath);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
      throw new PlaybookExecutionCapabilityError('The Skill path leaves the Apex repository.');
    }
    if (tried.has(absolutePath)) continue;
    tried.add(absolutePath);
    try {
      return await fs.readFile(absolutePath, 'utf8');
    } catch {
      // This layout does not have the file. Try the next root.
    }
  }
  throw new PlaybookExecutionCapabilityError(
    `The Playbook Skill "${relativePath}" could not be read to resolve its capability policy.`
  );
}

export interface ResolvePlaybookAgentRunPolicyInput {
  nodeId: string;
  skillPath: string;
  skillContent: string;
  mcpProfile: string | undefined;
  repository?: string;
  provider?: SkillProvider;
  groundedSha?: string;
  enforce: boolean;
  resolvedAt?: string;
}

export function resolvePlaybookAgentRunPolicy(
  input: ResolvePlaybookAgentRunPolicyInput
): PlaybookAgentRunPolicy {
  // Runtime compatibility for immutable pre-profile versions. New publication already requires an
  // explicit profile in assertCursorAgentsUseReadOnlyMcp.
  const executionProfile = input.mcpProfile ?? 'repository-read-only';
  const profile = resolvePlaybookMcpCapability(executionProfile);
  if (profile.mode !== 'read') {
    throw new PlaybookMcpCapabilityError(input.nodeId, executionProfile, profile.mode);
  }
  const declared = parsePlaybookSkillCapabilities(input.skillContent);
  const requested: PlaybookCapability[] = ['repository-read', 'network-read'];
  // A Skill that names azure-cli is allowed to run Azure CLI in the worker shell.
  // The shell stays closed for every other Skill, including one with no capability list.
  if (declared?.includes('azure-cli')) requested.push('azure-cli');

  const provider =
    input.provider === 'ado'
      ? 'azure-devops'
      : input.provider === 'github'
        ? 'github'
        : undefined;

  return {
    schemaVersion: 1,
    resolverVersion: RESOLVER_VERSION,
    executionProfile,
    capabilities: requested,
    skill: {
      path: input.skillPath.replace(/^[/\\]+/, ''),
      sha256: createHash('sha256').update(input.skillContent).digest('hex'),
    },
    ...(input.repository && provider
      ? {
          repository: {
            provider,
            repository: input.repository,
            ...(input.groundedSha ? { groundedSha: input.groundedSha } : {}),
          },
        }
      : {}),
    // The repository is exposed through native read tools. No live MCP endpoint is resolved by a
    // worker for this profile.
    mcpServers: [],
    localAgent: {
      cwdMode: 'scratch',
      allowBuiltinWrites: false,
      customTools: input.repository ? 'native-read-only' : 'none',
    },
    enforcement: input.enforce ? 'enforce' : 'observe',
    resolvedAt: input.resolvedAt ?? new Date().toISOString(),
  };
}

export async function resolvePlaybookGraphAgentPolicies(input: {
  graph: PlaybookGraph;
  repository?: string;
  provider?: SkillProvider;
  enforce: boolean;
}): Promise<Array<{ nodeId: string; policy: PlaybookAgentRunPolicy }>> {
  const policies: Array<{ nodeId: string; policy: PlaybookAgentRunPolicy }> = [];
  for (const node of input.graph.nodes) {
    // Cloud-agent steps count toward the agent cap, but they do not load a repository Skill.
    if (node.stepType !== 'cursor-agent') continue;
    const skillPath = typeof node.config?.skillPath === 'string' ? node.config.skillPath : '';
    const skillContent = await loadPlaybookSkillContent(skillPath);
    policies.push({
      nodeId: node.id,
      policy: resolvePlaybookAgentRunPolicy({
        nodeId: node.id,
        skillPath,
        skillContent,
        mcpProfile:
          typeof node.config?.mcpProfile === 'string' ? node.config.mcpProfile : undefined,
        repository: input.repository,
        provider: input.provider,
        enforce: input.enforce,
      }),
    });
  }
  return policies;
}
