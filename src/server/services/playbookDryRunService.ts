import type { PlaybookDryRunIssue, PlaybookDryRunResult, PlaybookGraph } from '../../shared/types/playbook';
import { PLAYBOOK_DRY_RUN_LIMIT as DRY_RUN_LIMIT } from '../../shared/types/playbook';
import { getUserPermissions } from './rbacService';
import { collectGraphIssues } from './playbookGuardService';
import {
  PlaybookBranchConditionError,
  evaluateBranchCondition,
  validateBranchCondition,
} from './playbookSteps/branchConditionEvaluator';
import {
  getStepTypeDescriptor,
  isBranchStepType,
  isRegisteredStepType,
  requiredPermissionsForStep,
} from './playbookSteps/registry';
import { getDefinitionDetail } from './playbookDefinitionService';
import { resolvePlaybookGraphAgentPolicies } from './playbookExecutionCapabilityService';
import { getSkillConfig } from './projectSettingsService';

function buildManifest(graph: PlaybookGraph): string[] {
  const keys = new Set<string>();
  for (const node of graph.nodes) {
    if (!isRegisteredStepType(node.stepType)) continue;
    for (const permission of requiredPermissionsForStep(node.stepType, node.config ?? {})) {
      keys.add(permission);
    }
  }
  return [...keys].sort();
}

export async function dryRunPlaybookDraft(input: {
  project: string;
  definitionId: string;
  stubs: Record<string, unknown>;
  userId: string;
}): Promise<PlaybookDryRunResult> {
  const detail = await getDefinitionDetail(input.project, input.definitionId);
  const graph = detail.draft.graph;
  const issues: PlaybookDryRunIssue[] = [];
  let capabilityManifest: PlaybookDryRunResult['capabilityManifest'] = [];

  issues.push(...collectGraphIssues(graph));

  try {
    let settings: Awaited<ReturnType<typeof getSkillConfig>> = null;
    try {
      settings = await getSkillConfig(input.project);
    } catch {
      // Capability declarations and hashes remain testable without optional repository grounding.
      settings = null;
    }
    const policies = await resolvePlaybookGraphAgentPolicies({
      graph,
      repository: settings?.skillRepo ?? input.project,
      provider: settings?.skillProvider,
      enforce: false,
    });
    capabilityManifest = policies.map(({ nodeId, policy }) => ({
      nodeId,
      skillPath: policy.skill.path,
      executionProfile: policy.executionProfile,
      capabilities: policy.capabilities,
      skillSha256: policy.skill.sha256,
    }));
  } catch (error) {
    issues.push({
      nodeId: '',
      kind: 'capability',
      message: error instanceof Error ? error.message : 'Capability policy resolution failed.',
    });
  }

  const parsedOutputs: Record<string, Record<string, unknown>> = {};
  for (const node of graph.nodes) {
    if (!input.stubs[node.id]) continue;
    const descriptor = getStepTypeDescriptor(node.stepType);
    const parsed = descriptor.outputSchema.safeParse(input.stubs[node.id]);
    if (!parsed.success) {
      issues.push({
        nodeId: node.id,
        kind: 'stub',
        message: parsed.error.issues.map((issue) => issue.message).join('; '),
      });
      continue;
    }
    parsedOutputs[node.id] = parsed.data as Record<string, unknown>;
  }

  for (const node of graph.nodes) {
    if (!isBranchStepType(node.stepType)) continue;
    // The structure check above already reported a branch whose condition is wrong.
    if (issues.some((issue) => issue.nodeId === node.id && issue.kind === 'branch')) continue;
    try {
      validateBranchCondition(graph, node);
      const config = getStepTypeDescriptor('branch').inputSchema.parse(node.config ?? {}) as {
        condition: Parameters<typeof evaluateBranchCondition>[0];
      };
      const sourceOutput = parsedOutputs[config.condition.sourceStepId];
      if (!sourceOutput) {
        issues.push({
          nodeId: node.id,
          kind: 'branch',
          message: `Branch step "${node.id}" needs a stub output for source "${config.condition.sourceStepId}".`,
        });
        continue;
      }
      evaluateBranchCondition(config.condition, parsedOutputs);
    } catch (error) {
      const message =
        error instanceof PlaybookBranchConditionError || error instanceof Error
          ? error.message
          : 'Branch validation failed.';
      issues.push({ nodeId: node.id, kind: 'branch', message });
    }
  }

  const manifest = buildManifest(graph);
  const heldPermissions = await getUserPermissions(input.userId, input.project);
  const held = manifest.filter((key) => heldPermissions.has(key));
  const missing = manifest.filter((key) => !heldPermissions.has(key));

  return {
    verdict: issues.length === 0 ? 'passed' : 'failed',
    limit: DRY_RUN_LIMIT,
    manifest,
    authorFootnote: { held, missing },
    issues,
    capabilityManifest,
  };
}
