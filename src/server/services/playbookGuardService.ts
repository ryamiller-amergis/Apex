/**
 * The six structural guards, in one place because they are called from two.
 *
 * Graph shape is checked when a version is published; concurrency is checked when a run starts or
 * a step suspends. Splitting them across those callers would guarantee the two drift — the usual
 * way being that a new caller of one forgets the other exists.
 *
 * Every check here is synchronous, deterministic and network-free, which BR-007 requires and
 * VT-18 asserts by stubbing the network to throw and running the guards through it. No guard reads
 * cost data. Cost in this system is advisory, arrives late and is allowed to undercount; a run
 * refused on a number with those properties would be refused unreproducibly.
 */
import { and, count, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { playbookRuns, playbookStepRuns } from '../db/schema';
import { isAgentStepType } from './playbookSteps/registry';
import {
  PLAYBOOK_GUARD_LIMITS,
  type PlaybookGraph,
  type PlaybookGuardViolation,
  type PlaybookGuardViolationKind,
} from '../../shared/types/playbook';

/**
 * Thrown by every guard, carrying which one refused.
 *
 * Callers map `violation.kind` to a status code; people read `message`. Both matter — a 400 with
 * no number in it tells an author their Playbook is wrong but not how to fix it, which is why
 * every message below names the cap and the observed value.
 */
export class PlaybookGuardViolationError extends Error {
  readonly violation: PlaybookGuardViolation;

  constructor(kind: PlaybookGuardViolationKind, message: string) {
    super(message);
    this.name = 'PlaybookGuardViolationError';
    this.violation = { kind, message };
  }
}

/** How many nodes in this graph are agent turns. The registry decides which types those are. */
export function countAgentSteps(graph: PlaybookGraph): number {
  return graph.nodes.filter((node) => isAgentStepType(node.stepType)).length;
}

/** The widest set of outbound edges from any single node. One means a linear graph. */
export function maxFanOut(graph: PlaybookGraph): number {
  const outbound = new Map<string, number>();
  for (const edge of graph.edges) {
    outbound.set(edge.from, (outbound.get(edge.from) ?? 0) + 1);
  }
  return outbound.size === 0 ? 0 : Math.max(...outbound.values());
}

/**
 * Returns the nodes forming a cycle, or `undefined` when the graph is acyclic.
 *
 * Depth-first with a `visiting` set, which is the standard colouring: a node reached while still
 * on the current path closes a loop. Returning the participating nodes rather than a boolean is
 * what lets the refusal name the cycle — "your Playbook has a loop" sends an author hunting
 * through twenty steps, and with a 20-step ceiling the cost of tracking the path is nothing.
 */
export function findCycle(graph: PlaybookGraph): string[] | undefined {
  const outbound = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const existing = outbound.get(edge.from);
    if (existing) existing.push(edge.to);
    else outbound.set(edge.from, [edge.to]);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const path: string[] = [];

  function walk(nodeId: string): string[] | undefined {
    if (visiting.has(nodeId)) {
      // Trim the prefix that led into the loop but is not part of it.
      return path.slice(path.indexOf(nodeId));
    }
    if (visited.has(nodeId)) return undefined;

    visiting.add(nodeId);
    path.push(nodeId);

    for (const next of outbound.get(nodeId) ?? []) {
      const cycle = walk(next);
      if (cycle) return cycle;
    }

    visiting.delete(nodeId);
    visited.add(nodeId);
    path.pop();
    return undefined;
  }

  for (const node of graph.nodes) {
    const cycle = walk(node.id);
    if (cycle) return cycle;
  }
  return undefined;
}

/**
 * The four publish-time guards, in the order an author most likely tripped.
 *
 * Checked at publish rather than per run because a published version's graph cannot change —
 * BR-006 makes it immutable — so re-deriving the same answer on every start would be waste that
 * also puts a graph walk on the run-start latency path.
 */
export function assertGraphWithinGuards(graph: PlaybookGraph): void {
  const { maxStepsPerRun, maxAgentStepsPerRun, maxFanOutWidth } = PLAYBOOK_GUARD_LIMITS;

  if (graph.nodes.length > maxStepsPerRun) {
    throw new PlaybookGuardViolationError(
      'max-steps',
      `This Playbook has ${graph.nodes.length} steps, above the limit of ${maxStepsPerRun} per run.`
    );
  }

  const agentSteps = countAgentSteps(graph);
  if (agentSteps > maxAgentStepsPerRun) {
    throw new PlaybookGuardViolationError(
      'max-agent-steps',
      `This Playbook has ${agentSteps} agent steps, above the limit of ${maxAgentStepsPerRun} per run.`
    );
  }

  const fanOut = maxFanOut(graph);
  if (fanOut > maxFanOutWidth) {
    throw new PlaybookGuardViolationError(
      'max-fan-out',
      `A step in this Playbook branches to ${fanOut} next steps, above the permitted fan-out ` +
        `width of ${maxFanOutWidth}. Phase 0 runs linear Playbooks only.`
    );
  }

  const cycle = findCycle(graph);
  if (cycle) {
    throw new PlaybookGuardViolationError(
      'loop',
      `This Playbook contains a loop: ${cycle.join(' → ')} → ${cycle[0]}. ` +
        'Loops are not permitted; a Playbook must reach an end.'
    );
  }
}

/**
 * Runs in this project that are occupying a concurrency slot.
 *
 * `running` only — `suspended` is counted separately and deliberately. See the note on
 * `maxSuspendedRunsPerProject`.
 */
async function countActiveRuns(project: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(playbookRuns)
    .where(and(eq(playbookRuns.project, project), eq(playbookRuns.status, 'running')));

  return row?.value ?? 0;
}

async function countSuspendedRuns(project: string, excludeRunId?: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(playbookRuns)
    .where(
      and(
        eq(playbookRuns.project, project),
        eq(playbookRuns.status, 'suspended'),
        // A run parking its second step must not be refused by its own first suspension.
        ...(excludeRunId ? [ne(playbookRuns.id, excludeRunId)] : [])
      )
    );

  return row?.value ?? 0;
}

/**
 * Admission guard for starting a run. Called before the run row is written, so a refused start
 * leaves no trace to explain to whoever reads the status view.
 */
export async function assertActiveRunCapacity(project: string): Promise<void> {
  const active = await countActiveRuns(project);
  const cap = PLAYBOOK_GUARD_LIMITS.maxActiveRunsPerProject;

  if (active >= cap) {
    throw new PlaybookGuardViolationError(
      'active-run-cap',
      `Project "${project}" already has ${active} running Playbooks, at its cap of ${cap}. ` +
        'Wait for one to finish before starting another.'
    );
  }
}

/**
 * Admission guard for parking a step.
 *
 * Separate from the active-run cap on purpose. Counting suspensions against concurrency would let
 * a handful of runs waiting on absent approvers lock a project out of starting anything — a
 * self-inflicted outage from ordinary neglect. Not counting them at all would leave suspensions
 * unbounded, which is the other half of the same trap.
 */
export async function assertSuspendedRunCapacity(
  project: string,
  excludeRunId?: string
): Promise<void> {
  const suspended = await countSuspendedRuns(project, excludeRunId);
  const ceiling = PLAYBOOK_GUARD_LIMITS.maxSuspendedRunsPerProject;

  if (suspended >= ceiling) {
    throw new PlaybookGuardViolationError(
      'suspended-run-ceiling',
      `Project "${project}" already has ${suspended} suspended Playbooks, at its ceiling of ` +
        `${ceiling}. Resolve or cancel one before parking another.`
    );
  }
}

/** Steps still open across a run, used by the sweep to tell a finished run from a stalled one. */
export async function countOpenStepRuns(runId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(playbookStepRuns)
    .where(
      and(
        eq(playbookStepRuns.runId, runId),
        inArray(playbookStepRuns.status, ['pending', 'running', 'suspended'])
      )
    );

  return row?.value ?? 0;
}
