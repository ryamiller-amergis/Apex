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
import { isAgentStepType } from './playbookSteps/registry';

const RESOLVER_VERSION = 1;
const CAPABILITY_LINE = /^playbook-capabilities:\s*\[([^\]]*)\]\s*$/m;

export class PlaybookExecutionCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookExecutionCapabilityError';
  }
}

export function parsePlaybookSkillCapabilities(skillContent: string): PlaybookCapability[] {
  const frontmatter = skillContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const line = frontmatter?.[1].match(CAPABILITY_LINE);
  if (!line) {
    throw new PlaybookExecutionCapabilityError(
      'The Skill frontmatter must declare playbook-capabilities.'
    );
  }
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

export async function loadPlaybookSkillContent(skillPath: string): Promise<string> {
  const repoRoot = path.resolve(process.cwd());
  const relativePath = skillPath.replace(/^[/\\]+/, '');
  const absolutePath = path.resolve(repoRoot, relativePath);
  if (absolutePath !== repoRoot && !absolutePath.startsWith(`${repoRoot}${path.sep}`)) {
    throw new PlaybookExecutionCapabilityError('The Skill path leaves the Apex repository.');
  }
  try {
    return await fs.readFile(absolutePath, 'utf8');
  } catch {
    throw new PlaybookExecutionCapabilityError(
      `The Playbook Skill "${relativePath}" could not be read to resolve its capability policy.`
    );
  }
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
  const maximum = parsePlaybookSkillCapabilities(input.skillContent);
  const requested: PlaybookCapability[] = ['repository-read', 'network-read'];
  const excessive = requested.find((capability) => !maximum.includes(capability));
  if (excessive) {
    throw new PlaybookExecutionCapabilityError(
      `Skill "${input.skillPath}" does not permit required capability "${excessive}".`
    );
  }

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
    if (!isAgentStepType(node.stepType)) continue;
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
