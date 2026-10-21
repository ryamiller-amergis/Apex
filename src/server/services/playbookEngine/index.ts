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
import {
  cancelRunOnEngine,
  resumeRunOnEngine,
  retryStepRunOnEngine,
  startRunOnEngine,
} from './runtime';
import type { EngineOutcome } from './runtime';
import type {
  PlaybookCancelInput,
  PlaybookResumeInput,
  PlaybookRetryInput,
  PlaybookStartInput,
} from '../../../shared/types/playbook';

export type { EngineOutcome } from './runtime';

/**
 * Drives a run from its entry step until one parks, one fails, or the graph runs out.
 *
 * The run row already exists — Apex admits the run, checks capacity and pins the version before the
 * engine is involved at all, because those are Apex's rules and a run that fails them should never
 * reach an engine.
 */
export async function start(input: PlaybookStartInput): Promise<EngineOutcome> {
  return startRunOnEngine(input.graph, {
    runId: input.runId,
    project: input.projectName,
    initiatorUserId: input.initiatorUserId,
  });
}

/**
 * Continues a run whose parked step has been resolved.
 *
 * Shared by both suspendable step kinds, per BR-008: an approval decision and a terminal agent-run
 * event arrive by different routes and mean the same thing to the engine.
 */
export async function resume(input: PlaybookResumeInput): Promise<EngineOutcome> {
  return resumeRunOnEngine(
    input.graph,
    {
      runId: input.runId,
      project: input.projectName,
      initiatorUserId: input.initiatorUserId,
    },
    input.stepId
  );
}

/** Terminates a run inside the engine. The Apex run row is the caller's to update. */
export async function cancel(input: PlaybookCancelInput): Promise<void> {
  return cancelRunOnEngine(input.graph, {
    runId: input.runId,
    project: input.projectName,
    initiatorUserId: input.initiatorUserId,
  });
}

/** Retries one Apex-owned failed row, re-running runtime guards before adapter dispatch. */
export async function retry(input: PlaybookRetryInput): Promise<EngineOutcome> {
  return retryStepRunOnEngine(
    input.graph,
    {
      runId: input.runId,
      project: input.projectName,
      initiatorUserId: input.initiatorUserId,
    },
    input.stepRunId,
    input.stepId
  );
}
