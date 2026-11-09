import type { FrozenInteractiveMcpDescriptor } from './durableInteractiveTurn';

export const PLAYBOOK_CAPABILITIES = [
  'repository-read',
  'repository-write',
  'network-read',
  'azure-cli',
  'external-write',
  'secret-use',
  'browser-use',
  'deployment',
] as const;

export type PlaybookCapability = (typeof PLAYBOOK_CAPABILITIES)[number];

/** App-Service-resolved policy. A worker applies it and never fills in missing values. */
export interface PlaybookAgentRunPolicy {
  schemaVersion: 1;
  resolverVersion: number;
  executionProfile: string;
  capabilities: PlaybookCapability[];
  skill: {
    path: string;
    sha256: string;
  };
  repository?: {
    provider: 'github' | 'azure-devops';
    repository: string;
    groundedSha?: string;
  };
  mcpServers: FrozenInteractiveMcpDescriptor[];
  localAgent: {
    cwdMode: 'scratch' | 'repository';
    /** Whether Cursor's built-in write operations are part of this execution profile. */
    allowBuiltinWrites: boolean;
    customTools: 'none' | 'native-read-only';
  };
  enforcement: 'observe' | 'enforce';
  resolvedAt: string;
}

export function isPlaybookAgentRunPolicy(value: unknown): value is PlaybookAgentRunPolicy {
  if (!value || typeof value !== 'object') return false;
  const policy = value as Record<string, unknown>;
  const skill = policy.skill as Record<string, unknown> | undefined;
  const localAgent = policy.localAgent as Record<string, unknown> | undefined;
  return (
    policy.schemaVersion === 1
    && policy.resolverVersion === 1
    && typeof policy.executionProfile === 'string'
    && Array.isArray(policy.capabilities)
    && policy.capabilities.every(
      (capability) =>
        typeof capability === 'string'
        && (PLAYBOOK_CAPABILITIES as readonly string[]).includes(capability)
    )
    && Boolean(skill)
    && typeof skill?.path === 'string'
    && typeof skill.sha256 === 'string'
    && /^[a-f0-9]{64}$/i.test(skill.sha256)
    && Array.isArray(policy.mcpServers)
    && Boolean(localAgent)
    && (localAgent?.cwdMode === 'scratch' || localAgent?.cwdMode === 'repository')
    && typeof localAgent.allowBuiltinWrites === 'boolean'
    && (localAgent.customTools === 'none' || localAgent.customTools === 'native-read-only')
    && (policy.enforcement === 'observe' || policy.enforcement === 'enforce')
    && typeof policy.resolvedAt === 'string'
    && !Number.isNaN(Date.parse(policy.resolvedAt))
  );
}
