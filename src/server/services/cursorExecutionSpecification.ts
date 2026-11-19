/**
 * Pure App Service option derivation for Cursor execution specifications
 * (`v2-worker-no-policy` rules 1–6).
 *
 * Kept free of `@cursor/sdk` imports so App Service durable-admission call
 * graphs (`interactiveV2NoFallback.test.ts`) never pull the SDK into the
 * admission boundary.
 */
import type { ExecutionSnapshot } from '../../shared/types/agentRunLifecycle';
import { isPlaybookAgentRunPolicy } from '../../shared/types/playbookExecutionCapability';
import type { InterviewRepositoryPhase } from '../../shared/types/interview';

export type DerivedCursorSandboxSpecification = Readonly<{
  enabled: boolean;
  omitSandbox?: boolean;
}>;

export type ExplicitCursorExecutionFields = Readonly<{
  toolAllowlist: readonly string[] | null;
  disallowedTools: readonly string[];
  settingSources: readonly string[];
  sandbox: DerivedCursorSandboxSpecification;
}>;

/** True when a Playbook agent step needs shell access for Azure CLI (`az`). */
export function playbookStepNeedsAzureCli(
  snapshot: Readonly<Pick<ExecutionSnapshot, 'skillPath' | 'playbookAgentPolicy'>>,
): boolean {
  const rawPolicy: unknown = snapshot.playbookAgentPolicy;
  const policy = rawPolicy && isPlaybookAgentRunPolicy(rawPolicy) ? rawPolicy : undefined;
  const investigationSkill = [snapshot.skillPath, policy?.skill.path].some((skillPath) =>
    (skillPath ?? '').replace(/\\/g, '/').includes('maxview-incident-investigation'),
  );
  return Boolean(policy?.capabilities.includes('azure-cli')) || investigationSkill;
}

/**
 * Pure App Service option builder for interactive turns (`v2-worker-no-policy`).
 */
export function deriveInteractiveCursorExecutionFields(input: {
  mcpServerNames: readonly string[];
  interviewPhase: InterviewRepositoryPhase | null;
}): ExplicitCursorExecutionFields {
  const mcpOnly =
    input.mcpServerNames.length === 1 && input.mcpServerNames[0] === 'mcp-server';
  const disallowSubagents = mcpOnly || input.interviewPhase === 'product';
  return {
    toolAllowlist: mcpOnly ? ['mcp'] : null,
    disallowedTools: disallowSubagents ? ['task'] : [],
    settingSources: [],
    sandbox:
      !mcpOnly && input.interviewPhase
        ? { enabled: false }
        : { enabled: false, omitSandbox: true },
  };
}

/**
 * Pure App Service option builder for worker/document turns (`v2-worker-no-policy`).
 */
export function deriveWorkerCursorExecutionFields(
  snapshot: Readonly<Pick<ExecutionSnapshot, 'skillPath' | 'playbookAgentPolicy'>>,
): ExplicitCursorExecutionFields {
  const rawPolicy: unknown = snapshot.playbookAgentPolicy;
  const policy = rawPolicy && isPlaybookAgentRunPolicy(rawPolicy) ? rawPolicy : undefined;
  const enforcing = policy?.enforcement === 'enforce';
  const shellAllowed = !enforcing || playbookStepNeedsAzureCli(snapshot);
  return {
    toolAllowlist: null,
    disallowedTools: shellAllowed ? [] : ['shell'],
    settingSources: enforcing ? [] : ['project'],
    sandbox: { enabled: false },
  };
}
