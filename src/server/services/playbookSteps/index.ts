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
import { getUserPermissions } from '../rbacService';
import { getStepTypeDescriptor, requiresInitiatorPermissionRecheck } from './registry';
import type {
  PlaybookStepAdapter,
  PlaybookStepExecutionContext,
  PlaybookStepOutcome,
} from './stepRuns';

const ADAPTERS: Readonly<Record<string, PlaybookStepAdapter>> = {
  'cursor-agent': executeCursorAgentStep,
  'approval-gate': executeApprovalGateStep,
  notify: executeNotifyStep,
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
  constructor(stepId: string, project: string) {
    super(
      `The person who started this run no longer has playbooks:run on ${project}. ` +
        `Step "${stepId}" was not executed.`
    );
    this.name = 'PlaybookPermissionRevokedError';
  }
}

/**
 * TBI-024 — re-checks the initiator's access immediately before a side-effecting step runs.
 *
 * BR-003 makes every step execute as the initiator, and a suspended run can sit for days. The
 * access checked when the run started is therefore not evidence of anything by the time a parked
 * step wakes: somebody may have left the project, or the team, in between.
 *
 * Only side-effecting steps are re-checked. An `approval-gate` changes nothing outside Apex and
 * its own decision is already restricted to the initiator, so a re-check there would cost a query
 * per step to re-derive an answer nothing acts on.
 *
 * The stand-in for Phase 0 is the initiator's project access plus `playbooks:run` — deliberately
 * the same permission that admitted the run. Phase 1 replaces it with per-step permissions once
 * step types have distinct ones worth distinguishing; the seam is here so that replacement is a
 * change to this function rather than a change to every adapter.
 */
async function assertInitiatorStillPermitted(
  context: PlaybookStepExecutionContext
): Promise<void> {
  const permissions = await getUserPermissions(context.initiatorUserId, context.project);
  if (!permissions.has('playbooks:run')) {
    throw new PlaybookPermissionRevokedError(context.stepId, context.project);
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

  // Before the adapter, not inside it: an adapter that has begun its side effect has already had
  // the effect, and three adapters each remembering to check is three chances to forget.
  if (requiresInitiatorPermissionRecheck(context.stepType)) {
    await assertInitiatorStillPermitted(context);
  }

  return adapter(context);
}

export * from './registry';
export * from './stepRuns';
