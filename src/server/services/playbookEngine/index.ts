/**
 * The only place Apex may ever import a playbook orchestration engine.
 *
 * Everything outside this directory calls the operations below and sees Apex types only. That is
 * what makes the engine replaceable: swapping Mastra for something else is a change inside this
 * directory and nowhere else. A `no-restricted-imports` rule fails the build on any engine import
 * from outside, and a snapshot test guards this file's export list, because lint sees imports
 * crossing in while only a snapshot sees the surface growing out.
 *
 * Mastra owns traversal — which step runs next, and the mechanics of parking and waking a run.
 * Apex owns everything else, including every row that records what happened.
 *
 * **`suspend` is gone from this surface.** Phase 0 declared four operations before anything ran.
 * With the engine actually wired, suspension turns out not to be an operation a caller can invoke:
 * a step parks from *inside* its own body, when its adapter reports it is waiting, and there is no
 * moment at which outside code both knows a step should park and is in a position to park it.
 * Keeping it would have meant exporting a function nothing could call correctly.
 */
import { isFeatureEnabled } from '../featureFlagService';
import { getAppEnvironment } from '../../utils/superAdmin';
import { cancelRunOnEngine, resumeRunOnEngine, startRunOnEngine } from './runtime';
import type { EngineOutcome } from './runtime';
import type {
  PlaybookCancelInput,
  PlaybookOperationContext,
  PlaybookResumeInput,
  PlaybookStartInput,
} from '../../../shared/types/playbook';

const PLAYBOOKS_SPIKE_FLAG = 'playbooks-spike';

export type { EngineOutcome } from './runtime';

/**
 * The single gate every operation passes through.
 *
 * One split rather than three keeps the cleanup mechanical, and means the engine cannot be reached
 * by adding an operation and forgetting the check. `isFeatureEnabled` resolves an absent flag as
 * disabled, so code merging before the seed migration lands cannot enable anything.
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

/**
 * Drives a run from its entry step until one parks, one fails, or the graph runs out.
 *
 * The run row already exists — Apex admits the run, checks capacity and pins the version before the
 * engine is involved at all, because those are Apex's rules and a run that fails them should never
 * reach an engine.
 */
export async function start(input: PlaybookStartInput): Promise<EngineOutcome> {
  return withPlaybooksEnabled(input, 'start a run', () =>
    startRunOnEngine(input.graph, {
      runId: input.runId,
      project: input.projectName,
      initiatorUserId: input.initiatorUserId,
    })
  );
}

/**
 * Continues a run whose parked step has been resolved.
 *
 * Shared by both suspendable step kinds, per BR-008: an approval decision and a terminal agent-run
 * event arrive by different routes and mean the same thing to the engine.
 */
export async function resume(input: PlaybookResumeInput): Promise<EngineOutcome> {
  return withPlaybooksEnabled(input, 'resume a step', () =>
    resumeRunOnEngine(
      input.graph,
      {
        runId: input.runId,
        project: input.projectName,
        initiatorUserId: input.initiatorUserId,
      },
      input.stepId
    )
  );
}

/** Terminates a run inside the engine. The Apex run row is the caller's to update. */
export async function cancel(input: PlaybookCancelInput): Promise<void> {
  return withPlaybooksEnabled(input, 'cancel a run', () =>
    cancelRunOnEngine(input.graph, {
      runId: input.runId,
      project: input.projectName,
      initiatorUserId: input.initiatorUserId,
    })
  );
}
