/**
 * The only place Apex may ever import a playbook orchestration engine.
 *
 * Everything outside this directory calls the four operations below and sees Apex types only. That
 * is what makes the engine replaceable: if a fallback trigger fires, VoltAgent replaces Mastra
 * inside this directory and nothing else in the codebase changes. A `no-restricted-imports` rule
 * fails the build on any engine import from outside, and a snapshot test guards this file's export
 * list, because lint sees imports crossing in while only a snapshot sees the surface growing out.
 *
 * Phase 0 defines the surface without an engine behind it — there are no step types to orchestrate
 * yet. The operations therefore refuse rather than pretend, and the refusal is deliberate: a caller
 * merged ahead of the engine gets a clear error, not a silent no-op.
 */
import { isFeatureEnabled } from '../featureFlagService';
import { getAppEnvironment } from '../../utils/superAdmin';
import type {
  PlaybookCancelInput,
  PlaybookOperationContext,
  PlaybookResumeInput,
  PlaybookRunHandle,
  PlaybookStartInput,
  PlaybookSuspendInput,
} from '../../../shared/types/playbook';

const PLAYBOOKS_SPIKE_FLAG = 'playbooks-spike';

/**
 * The single gate every operation passes through.
 *
 * One split rather than four keeps the Phase 1 cleanup mechanical, and means the engine cannot be
 * reached by adding an operation and forgetting the check. `isFeatureEnabled` resolves an absent
 * flag as disabled, so code merging before the seed migration lands cannot enable anything.
 */
async function withPlaybooksEnabled<T>(
  context: PlaybookOperationContext,
  operation: string,
  run: () => Promise<T>
): Promise<T> {
  /*
   * The environment is passed deliberately. Rule categories are ANDed during evaluation, so an
   * environment rule that finds no environment on the context matches nothing and the flag resolves
   * disabled everywhere. Phase 0 is targeted at local and dev precisely that way, which would leave
   * the feature silently dark if this were omitted.
   */
  const enabled = await isFeatureEnabled(PLAYBOOKS_SPIKE_FLAG, {
    userId: context.initiatorUserId,
    project: context.projectName,
    environment: getAppEnvironment(),
  });

  // @feature-flag:playbooks-spike start winner=enabled
  if (!enabled) {
    // @feature-flag:playbooks-spike disabled-start
    throw new Error(
      `Playbooks are not enabled for project "${context.projectName}" — refusing to ${operation}.`
    );
    // @feature-flag:playbooks-spike disabled-end
  }
  // @feature-flag:playbooks-spike enabled-start
  return run();
  // @feature-flag:playbooks-spike enabled-end
  // @feature-flag:playbooks-spike end
}

/** Phase 0 has no step types, so every enabled path lands here rather than half-starting a run. */
function notYetOrchestrating(operation: string): Promise<never> {
  return Promise.reject(
    new Error(
      `Playbook ${operation} has no engine behind it yet — step types arrive with the step registry.`
    )
  );
}

/** Begins a run against a pinned definition version. */
export async function start(input: PlaybookStartInput): Promise<PlaybookRunHandle> {
  return withPlaybooksEnabled(input, 'start a run', () => notYetOrchestrating('start'));
}

/** Parks a step with its deadline. Every suspension has one. */
export async function suspend(input: PlaybookSuspendInput): Promise<PlaybookRunHandle> {
  return withPlaybooksEnabled(input, 'suspend a step', () => notYetOrchestrating('suspend'));
}

/** Advances a suspended step. Shared by both suspendable step kinds, per BR-008. */
export async function resume(input: PlaybookResumeInput): Promise<PlaybookRunHandle> {
  return withPlaybooksEnabled(input, 'resume a step', () => notYetOrchestrating('resume'));
}

/** Terminates a run. */
export async function cancel(input: PlaybookCancelInput): Promise<PlaybookRunHandle> {
  return withPlaybooksEnabled(input, 'cancel a run', () => notYetOrchestrating('cancel'));
}
