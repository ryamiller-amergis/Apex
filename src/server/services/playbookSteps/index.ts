/**
 * Step-type dispatch.
 *
 * Two tables live in this directory and it is worth being clear that they are not duplicates.
 * `registry.ts` declares what a step type *is* — whether it suspends, how long it waits, which
 * Skills it may run — and that description is shared with anything that needs to reason about step
 * types. This maps a step type to the function that *runs* it, which is server-only and has no
 * business in a descriptor.
 *
 * They are checked against each other by a test rather than by convention: a descriptor with no
 * adapter is a step type that fails the moment a run reaches it, and a run reaching a step is the
 * worst place to discover a wiring mistake.
 */
import { executeApprovalGateStep } from './approvalGateAdapter';
import { executeCursorAgentStep } from './cursorAgentAdapter';
import { executeNotifyStep } from './notifyAdapter';
import { executeIngestArtifactStep } from './ingestArtifactAdapter';
import { executeBranchStep } from './branchAdapter';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { playbookRuns, playbookStepRuns } from '../../db/schema';
import { getUserPermissions } from '../rbacService';
import { parseStepInput } from './descriptorValidation';
import { getStepTypeDescriptor, requiredPermissionsForStep } from './registry';
import { isFeatureEnabled } from '../featureFlagService';
import {
  configHasBindings,
  resolvePlaybookBindings,
} from '../playbookBindingResolver';
import type {
  PlaybookStepAdapter,
  PlaybookStepExecutionContext,
  PlaybookStepOutcome,
} from './stepRuns';

const ADAPTERS: Readonly<Record<string, PlaybookStepAdapter>> = {
  'cursor-agent': executeCursorAgentStep,
  'approval-gate': executeApprovalGateStep,
  notify: executeNotifyStep,
  'ingest-artifact': executeIngestArtifactStep,
  branch: executeBranchStep,
};

/** The step types that can actually be executed. Compared against the registry by a test. */
export function adapterStepTypes(): readonly string[] {
  return Object.keys(ADAPTERS);
}

/**
 * Raised when the initiator has lost the access a step was about to act with.
 *
 * Carries the step it stopped, because by the time anyone reads this the run has been failing for
 * a while and "permission denied" without a location is not something you can act on.
 */
export class PlaybookPermissionRevokedError extends Error {
  constructor(stepId: string, project: string, missingPermissions: readonly string[]) {
    super(
      `Step "${stepId}" was not executed because the person who started this run is missing ` +
        `${missingPermissions.join(', ')} on ${project}.`
    );
    this.name = 'PlaybookPermissionRevokedError';
  }
}

export class PlaybookProductionAdapterDisabledError extends Error {
  constructor(stepType: string) {
    super(`Step type "${stepType}" is unavailable while playbooks-production-adapters is disabled.`);
    this.name = 'PlaybookProductionAdapterDisabledError';
  }
}

export class PlaybookRunTerminatedError extends Error {
  constructor() {
    super('Playbook run ended because a stale ingestion produced no further work.');
    this.name = 'PlaybookRunTerminatedError';
  }
}

async function resolveStepConfig(
  context: PlaybookStepExecutionContext,
): Promise<Record<string, unknown>> {
  if (!configHasBindings(context.config)) return context.config;

  const [run] = await db
    .select({ runInput: playbookRuns.runInput })
    .from(playbookRuns)
    .where(eq(playbookRuns.id, context.runId))
    .limit(1);
  const prior = await db
    .select({
      stepId: playbookStepRuns.stepId,
      output: playbookStepRuns.outputInline,
    })
    .from(playbookStepRuns)
    .where(and(
      eq(playbookStepRuns.runId, context.runId),
      eq(playbookStepRuns.status, 'completed'),
    ));

  const steps: Record<string, Record<string, unknown>> = {};
  for (const row of prior) {
    steps[row.stepId] = (row.output ?? {}) as Record<string, unknown>;
  }

  return resolvePlaybookBindings(context.config, {
    input: (run?.runInput ?? {}) as Record<string, unknown>,
    steps,
  });
}

/**
 * TBI-033 — re-checks the initiator's descriptor permissions immediately before every step runs.
 *
 * BR-003 makes every step execute as the initiator, and a suspended run can sit for days. The
 * access checked when the run started is therefore not evidence of anything by the time a parked
 * step wakes: somebody may have left the project, or the team, in between.
 *
 * The registry is authoritative. `read` steps are included: classification describes effects,
 * while `requiredPermissions` describes who may execute the step.
 */
async function assertInitiatorStillPermitted(
  context: PlaybookStepExecutionContext,
  requiredPermissions: readonly string[]
): Promise<void> {
  const permissions = await getUserPermissions(context.initiatorUserId, context.project);
  const missingPermissions = requiredPermissions.filter(
    (permission) => !permissions.has(permission)
  );
  if (missingPermissions.length > 0) {
    throw new PlaybookPermissionRevokedError(
      context.stepId,
      context.project,
      missingPermissions
    );
  }
}

/**
 * Runs one step.
 *
 * Looks the descriptor up first so an unregistered step type is refused by the registry's error,
 * naming what does exist, rather than by an undefined function call.
 */
export async function executeStep(
  context: PlaybookStepExecutionContext
): Promise<PlaybookStepOutcome> {
  getStepTypeDescriptor(context.stepType);

  const adapter = ADAPTERS[context.stepType];
  if (!adapter) {
    throw new Error(
      `Step type "${context.stepType}" is registered but has no adapter. ` +
        'A descriptor without an implementation cannot execute.'
    );
  }

  // Invalid stored config must cost nothing, including no permission query.
  const boundConfig = await resolveStepConfig(context);
  const parsedConfig = parseStepInput(context.stepType, boundConfig);

  // @feature-flag:playbooks-production-adapters start winner=enabled
  const isPhase2Step = context.stepType === 'ingest-artifact'
    || context.stepType === 'branch'
    || (context.stepType === 'approval-gate' && Boolean(parsedConfig.approverPool));
  const phase2Enabled = !isPhase2Step || await isFeatureEnabled('playbooks-production-adapters', {
      userId: context.initiatorUserId,
      project: context.project,
    });
  if (isPhase2Step && !phase2Enabled) {
    // @feature-flag:playbooks-production-adapters disabled-start
    if (context.stepType === 'ingest-artifact' || context.stepType === 'branch') {
      throw new PlaybookProductionAdapterDisabledError(context.stepType);
    }
    if (context.stepType === 'approval-gate') {
      delete parsedConfig.approverPool;
      delete parsedConfig.gatedStepId;
    }
    // @feature-flag:playbooks-production-adapters disabled-end
  }
  // @feature-flag:playbooks-production-adapters enabled-start

  // Every descriptor is enforced, including `read`. Fetch once at the last boundary before
  // dispatch so a permission revoked while the run was parked cannot reach an adapter.
  await assertInitiatorStillPermitted(
    context,
    requiredPermissionsForStep(context.stepType, parsedConfig),
  );

  const result = await adapter({ ...context, config: parsedConfig });
  // @feature-flag:playbooks-production-adapters enabled-end
  // @feature-flag:playbooks-production-adapters end
  return result;
}

export * from './registry';
export * from './descriptorValidation';
export * from './stepRuns';
