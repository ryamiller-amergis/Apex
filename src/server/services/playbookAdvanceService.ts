/**
 * Graph traversal at run time — the thing that makes a Playbook more than its first step.
 *
 * Until this existed, `startRun` executed the entry node and stopped. Approving a gate moved that
 * gate to `completed` and put the run back to `running`, and nothing ever looked at the pinned
 * graph again, so no run could reach its final step. The edges were read in exactly two places,
 * both of them publish-time guards.
 *
 * The rule this file follows is that **a run only ever moves forward from a settled position**. A
 * step that is pending, running or suspended means the run is mid-flight and advancing would run
 * the step a gate exists to gate; a step that failed or expired means the run is over, or is parked
 * for a person. So `advanceRun` moves only when every step so far is `completed`, and that single
 * condition is what makes it safe to call from anywhere, as often as anyone likes.
 *
 * That matters because it is called from three unrelated places — the approval route, the terminal
 * agent-run event listener, and the reconciliation sweep — and the usual way a design like this
 * breaks is a fourth caller appearing that forgets one of the preconditions. Here there is one
 * precondition, it is checked here rather than by the callers, and getting it wrong is a no-op
 * rather than a double-executed step.
 *
 * The sweep is still the guarantee, exactly as it is for resumption. The event listener is a
 * NOTIFY and may be missed; a process may die between a step completing and the next one starting.
 * `advanceStalledRuns` in the reconciliation pass picks up anything left settled-but-unfinished,
 * which is why no caller here needs a retry of its own.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { playbookDefinitionVersions, playbookRuns, playbookStepRuns } from '../db/schema';
import {
  beginStepRun,
  completeStepRunIfOpen,
  executeStep,
  failStepRun,
} from './playbookSteps';
import {
  PLAYBOOK_STEP_RUN_OPEN_STATUSES,
  type PlaybookGraph,
  type PlaybookGraphNode,
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
  | 'step-not-completed';

export interface PlaybookAdvanceOutcome {
  /** True when the run moved: steps were started, or it was marked completed. */
  advanced: boolean;
  /** Set only when `advanced` is false. */
  reason?: PlaybookAdvanceSkipReason;
  stepsStarted: number;
  /** Where the chain stopped, when one ran. */
  endedAs?: PlaybookChainEnd;
}

export type PlaybookChainEnd =
  /** A step parked. The resume path will advance the run when it wakes. */
  | 'suspended'
  /** The graph ran out of nodes and the run is marked completed. */
  | 'completed'
  /** A step threw. The step and the run are both marked failed. */
  | 'failed';

export interface PlaybookChainOutcome {
  stepsStarted: number;
  endedAs: PlaybookChainEnd;
  /** Present when `endedAs` is `failed`, so `startRun` can rethrow what actually went wrong. */
  error?: unknown;
}

/**
 * The node a run begins at: the one nothing points to.
 *
 * Falls back to the first declared node when every node has an inbound edge, which means the graph
 * is cyclic. That is not this function's problem to report — the publish-time guards refuse cycles,
 * so a cycle reaching here is a definition published before that guard existed. The fallback makes
 * such a run start somewhere sensible instead of failing with a confusing error about an empty
 * graph.
 */
export function entryNode(graph: PlaybookGraph): PlaybookGraphNode | undefined {
  if (graph.nodes.length === 0) return undefined;

  const hasInbound = new Set(graph.edges.map((edge) => edge.to));
  return graph.nodes.find((node) => !hasInbound.has(node.id)) ?? graph.nodes[0];
}

/**
 * The single node after this one.
 *
 * Singular because the publish-time fan-out guard caps outbound edges at one, so "the next step"
 * is unambiguous for every graph that can be published. A version published before that guard
 * existed could have more, and this takes the first edge as declared rather than picking among
 * them — deterministic, and it keeps a legacy graph running in a defined order instead of
 * pretending the branch can be executed. Real fan-out needs parallel step runs and a join, which
 * is Phase 1's work and not something to fake here.
 */
function successorNode(graph: PlaybookGraph, fromStepId: string): PlaybookGraphNode | undefined {
  const edge = graph.edges.find((e) => e.from === fromStepId);
  if (!edge) return undefined;
  return graph.nodes.find((node) => node.id === edge.to);
}

/**
 * The first node in the chain that has no step run yet.
 *
 * Walks from the entry rather than from the most recently completed step, because "most recent" is
 * a timestamp comparison and two steps completing in the same millisecond would make it a guess.
 * The graph is the authority on order; the step rows only say how far along it the run has got.
 */
function firstUnrunNode(
  graph: PlaybookGraph,
  alreadyRun: ReadonlySet<string>
): PlaybookGraphNode | undefined {
  let node = entryNode(graph);
  while (node && alreadyRun.has(node.id)) {
    node = successorNode(graph, node.id);
  }
  return node;
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
 * Runs steps from `from` onwards until one parks, one fails, or the graph runs out.
 *
 * The loop rather than one-step-at-a-time is deliberate: a `notify` step completes in the tick it
 * starts, so a definition ending in two notifications would otherwise need two external nudges to
 * finish, and the second would never come — nothing is waiting on a step that is already done.
 *
 * Shared with `startRun` so that starting a run and resuming one execute steps through identical
 * code. When they were separate, `startRun` happened to work only because the one non-suspending
 * adapter wrote its own completion row.
 */
export async function runStepChain(input: {
  runId: string;
  project: string;
  initiatorUserId: string;
  graph: PlaybookGraph;
  from: PlaybookGraphNode;
}): Promise<PlaybookChainOutcome> {
  let node: PlaybookGraphNode | undefined = input.from;
  let stepsStarted = 0;

  while (node) {
    const stepRun = await beginStepRun({
      runId: input.runId,
      stepId: node.id,
      stepType: node.stepType,
    });
    stepsStarted += 1;

    let outcome;
    try {
      outcome = await executeStep({
        runId: input.runId,
        stepRunId: stepRun.id,
        stepId: node.id,
        stepType: node.stepType,
        project: input.project,
        initiatorUserId: input.initiatorUserId,
        config: node.config ?? {},
      });
    } catch (error) {
      await failStepRun({
        stepRunId: stepRun.id,
        reason: error instanceof Error ? error.message : `Step ${node.id} failed`,
      });
      await markRunFailed(input.runId);
      return { stepsStarted, endedAs: 'failed', error };
    }

    // Parked. Whatever wakes it — an approval, a terminal event, the sweep — advances from there.
    if (outcome.kind === 'suspended') {
      return { stepsStarted, endedAs: 'suspended' };
    }

    /*
     * Conditional because the adapters own their own status writes: `notify` completes its row
     * inside the adapter, the same way `approval-gate` and `cursor-agent` suspend theirs. This is
     * the backstop for an adapter that reports `completed` without having written one, which would
     * otherwise leave a row stuck at `running` and stall the run at the next advance.
     */
    await completeStepRunIfOpen({ stepRunId: stepRun.id, output: outcome.output });

    node = successorNode(input.graph, node.id);
  }

  await markRunCompleted(input.runId);
  return { stepsStarted, endedAs: 'completed' };
}

/**
 * Starts whatever comes next for a run, if anything should.
 *
 * Never throws. Every caller is on a best-effort path — a route that has already recorded a
 * decision the caller was told succeeded, an event listener whose exceptions would break delivery
 * for every other subscriber, and a sweep that must survive one bad run to reach the next. A
 * failure here leaves the run failed in the database, which is where anyone looking will look.
 */
export async function advanceRun(runId: string): Promise<PlaybookAdvanceOutcome> {
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

  if (!row) return { advanced: false, reason: 'run-not-found', stepsStarted: 0 };

  if ((TERMINAL_RUN_STATUSES as readonly string[]).includes(row.status)) {
    return { advanced: false, reason: 'run-terminal', stepsStarted: 0 };
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
      stepsStarted: 0,
    };
  }

  const graph = row.graph as PlaybookGraph;
  const next = firstUnrunNode(graph, new Set(steps.map((step) => step.stepId)));

  if (!next) {
    // Every node has run and all of them completed. The run is finished; say so.
    return { advanced: await markRunCompleted(runId), stepsStarted: 0, endedAs: 'completed' };
  }

  const chain = await runStepChain({
    runId,
    project: row.project,
    initiatorUserId: row.initiatorUserId,
    graph,
    from: next,
  });

  return { advanced: true, stepsStarted: chain.stepsStarted, endedAs: chain.endedAs };
}

/**
 * Runs left settled but unfinished — the backstop for a missed advance.
 *
 * A process dying between a step completing and the next one starting leaves a run that is
 * `running`, has every step `completed`, and has nobody waiting to nudge it: the event that would
 * have advanced it has already been consumed. Nothing else in the system would ever look at it
 * again. This is the pass that does.
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
