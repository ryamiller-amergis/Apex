/**
 * Run-level bookkeeping around the engine.
 *
 * Traversal used to live here. It does not any more: deciding which step runs next, and carrying a
 * parked run forward, are Mastra's job now, behind `playbookEngine/`. What stays is everything the
 * PRD makes Apex's — when a run may move at all, and the rows that record that it did.
 *
 * The rule is unchanged and is the reason this file still exists: **a run only ever moves forward
 * from a settled position**, meaning every step so far is `completed`. A step that is pending,
 * running or suspended means the run is mid-flight and advancing would run the step a gate exists
 * to gate; a step that failed or expired means the run is over, or is parked for a person.
 *
 * That matters because `advanceRun` is called from three unrelated places — the approval route, the
 * terminal agent-run event listener, and the reconciliation sweep — and the usual way a design like
 * this breaks is a fourth caller appearing that forgets a precondition. There is one precondition,
 * it is checked here rather than by the callers, and getting it wrong is a no-op rather than a
 * double-executed step.
 *
 * The sweep is still the guarantee. The event listener is a NOTIFY and may be missed; a process may
 * die between a step being resolved and the engine being told. `advanceStalledRuns` picks up
 * anything left settled-but-unfinished, which is why no caller here needs a retry of its own.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { playbookDefinitionVersions, playbookRuns, playbookStepRuns } from '../db/schema';
import * as playbookEngine from './playbookEngine';
import {
  PLAYBOOK_STEP_RUN_OPEN_STATUSES,
  type PlaybookGraph,
} from '../../shared/types/playbook';

/** Run states from which nothing further can be started. */
const TERMINAL_RUN_STATUSES = ['completed', 'cancelled', 'failed', 'expired'] as const;

const OPEN_STEP_STATUSES: ReadonlySet<string> = new Set(PLAYBOOK_STEP_RUN_OPEN_STATUSES);

function nowIso(): string {
  return new Date().toISOString();
}

/** Why an advance did nothing. Every one of these is ordinary rather than an error. */
export type PlaybookAdvanceSkipReason =
  /** No such run. */
  | 'run-not-found'
  /** The run already finished, one way or another. */
  | 'run-terminal'
  /** A step is pending, running or suspended — the run is mid-flight. */
  | 'step-open'
  /** A step failed or expired. The run is over, or parked for a person to retry. */
  | 'step-not-completed'
  /** The run is settled but has no resolved step to carry on from. Nothing to tell the engine. */
  | 'no-resume-point';

export interface PlaybookAdvanceOutcome {
  /** True when the run moved: the engine carried it on, or it was marked completed. */
  advanced: boolean;
  /** Set only when `advanced` is false. */
  reason?: PlaybookAdvanceSkipReason;
  /** Where the engine stopped, when it was asked. */
  endedAs?: 'suspended' | 'completed' | 'failed';
}

/**
 * Marks a run finished. Guarded on `running` so a run that expired or was cancelled underneath us
 * is never overwritten — the same conditional-update discipline the step transitions use.
 */
async function markRunCompleted(runId: string): Promise<boolean> {
  const updated = await db
    .update(playbookRuns)
    .set({ status: 'completed', completedAt: nowIso(), updatedAt: nowIso() })
    .where(and(eq(playbookRuns.id, runId), eq(playbookRuns.status, 'running')))
    .returning({ id: playbookRuns.id });

  return updated.length > 0;
}

async function markRunFailed(runId: string): Promise<void> {
  await db
    .update(playbookRuns)
    .set({ status: 'failed', completedAt: nowIso(), updatedAt: nowIso() })
    .where(and(eq(playbookRuns.id, runId), inArray(playbookRuns.status, ['running', 'suspended'])));
}

/**
 * Records the run-level consequence of whatever the engine just did.
 *
 * Kept in one place because `start` and `resume` end the same three ways, and two copies of this
 * mapping would drift the moment a fourth outcome appears.
 */
async function applyEngineOutcome(
  runId: string,
  outcome: playbookEngine.EngineOutcome
): Promise<PlaybookAdvanceOutcome> {
  if (outcome.endedAs === 'failed') {
    await markRunFailed(runId);
    return { advanced: true, endedAs: 'failed' };
  }
  if (outcome.endedAs === 'completed') {
    await markRunCompleted(runId);
    return { advanced: true, endedAs: 'completed' };
  }
  // Parked. Whatever wakes it — an approval, a terminal event, the sweep — advances from there.
  return { advanced: true, endedAs: 'suspended' };
}

interface RunRow {
  status: string;
  project: string;
  initiatorUserId: string;
  graph: PlaybookGraph;
}

async function loadRun(runId: string): Promise<RunRow | undefined> {
  const [row] = await db
    .select({
      status: playbookRuns.status,
      project: playbookRuns.project,
      initiatorUserId: playbookRuns.initiatorUserId,
      graph: playbookDefinitionVersions.graph,
    })
    .from(playbookRuns)
    .innerJoin(
      playbookDefinitionVersions,
      eq(playbookRuns.definitionVersionId, playbookDefinitionVersions.id)
    )
    .where(eq(playbookRuns.id, runId))
    .limit(1);

  return row ? { ...row, graph: row.graph as PlaybookGraph } : undefined;
}

/**
 * Starts a run on the engine and records where it got to.
 *
 * Separate from `advanceRun` because a brand-new run has no settled position to check — it has no
 * steps at all, and the guard that protects every other entry point would refuse it.
 */
export async function beginRun(input: {
  runId: string;
  project: string;
  initiatorUserId: string;
  definitionVersionId: string;
  graph: PlaybookGraph;
}): Promise<PlaybookAdvanceOutcome & { error?: unknown }> {
  const outcome = await playbookEngine.start({
    runId: input.runId,
    graph: input.graph,
    projectName: input.project,
    initiatorUserId: input.initiatorUserId,
    definitionVersionId: input.definitionVersionId,
  });

  const applied = await applyEngineOutcome(input.runId, outcome);
  return { ...applied, error: outcome.error };
}

/**
 * The step the engine is parked at.
 *
 * The most recently created step row, because the chain is linear and each row is written as its
 * step begins — so the newest one is where the engine stopped. This is only ever asked of a run
 * that has already been found settled, which is what makes "newest" unambiguous: nothing is still
 * open, so nothing can be created after it while the question is being answered.
 */
async function resumePoint(runId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ stepId: playbookStepRuns.stepId })
    .from(playbookStepRuns)
    .where(eq(playbookStepRuns.runId, runId))
    .orderBy(desc(playbookStepRuns.createdAt))
    .limit(1);

  return row?.stepId;
}

/**
 * Tells the engine to carry a run on, if it should.
 *
 * Never throws. Every caller is on a best-effort path — a route that has already recorded a
 * decision the caller was told succeeded, an event listener whose exceptions would break delivery
 * for every other subscriber, and a sweep that must survive one bad run to reach the next. A
 * failure here leaves the run failed in the database, which is where anyone looking will look.
 *
 * `stepId` is supplied by the callers that know it, which is both of the fast ones: an approval
 * knows the gate it resolved and a terminal event knows the step it woke. The sweep does not, and
 * works it out from the rows.
 */
export async function advanceRun(runId: string, stepId?: string): Promise<PlaybookAdvanceOutcome> {
  const row = await loadRun(runId);
  if (!row) return { advanced: false, reason: 'run-not-found' };

  if ((TERMINAL_RUN_STATUSES as readonly string[]).includes(row.status)) {
    return { advanced: false, reason: 'run-terminal' };
  }

  const steps = await db
    .select({ stepId: playbookStepRuns.stepId, status: playbookStepRuns.status })
    .from(playbookStepRuns)
    .where(eq(playbookStepRuns.runId, runId));

  /*
   * One condition, checked once. Anything other than `completed` means the run is not sitting at a
   * settled position: open statuses are mid-flight, and failed or expired ones are the end of the
   * line. Telling the two apart in the reason is for the caller's logs; neither advances.
   */
  const blocking = steps.find((step) => step.status !== 'completed');
  if (blocking) {
    return {
      advanced: false,
      reason: OPEN_STEP_STATUSES.has(blocking.status) ? 'step-open' : 'step-not-completed',
    };
  }

  const from = stepId ?? (await resumePoint(runId));
  if (!from) return { advanced: false, reason: 'no-resume-point' };

  const outcome = await playbookEngine.resume({
    runId,
    graph: row.graph,
    projectName: row.project,
    initiatorUserId: row.initiatorUserId,
    stepId: from,
  });

  return applyEngineOutcome(runId, outcome);
}

/**
 * Runs left settled but unfinished — the backstop for a missed advance.
 *
 * A process dying between a step being resolved and the engine being told leaves a run that is
 * `running`, has every step `completed`, and has nobody waiting to nudge it: the event that would
 * have advanced it has already been consumed. Nothing else in the system would ever look at it
 * again. This is the pass that does.
 *
 * Deliberately Apex's own sweep rather than the engine's `restartAllActiveWorkflowRuns()`. A
 * blanket restart re-drives side effects, and a `cursor-agent` step re-driven blindly enqueues a
 * second agent run. This only ever resumes from a settled position, so the worst case is a no-op.
 *
 * Scoped to `running` because a `suspended` run is legitimately waiting and is the resume path's
 * business, not this one's.
 */
export async function advanceStalledRuns(): Promise<number> {
  const candidates = await db
    .select({ id: playbookRuns.id })
    .from(playbookRuns)
    .where(eq(playbookRuns.status, 'running'));

  let advanced = 0;
  for (const candidate of candidates) {
    // Fully guarded, so a run that is actually mid-flight is a no-op rather than a double start.
    const outcome = await advanceRun(candidate.id);
    if (outcome.advanced) advanced += 1;
  }

  return advanced;
}
