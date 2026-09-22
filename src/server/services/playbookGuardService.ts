/**
 * The six structural guards, in one place because they are called from two.
 *
 * Graph shape is checked when a version is published; concurrency is checked when a run starts or
 * a step suspends. Splitting them across those callers would guarantee the two drift — the usual
 * way being that a new caller of one forgets the other exists.
 *
 * Publication also asks the step-type registry what each node is: whether the type exists, whether
 * its config is one the type would accept, and — TBI-034 — whether anything that reaches outside
 * Apex has an approval gate on every edge into it. The registry is a map built at module load, so
 * reading it costs nothing and changes none of what follows.
 *
 * Every check here is synchronous, deterministic and network-free, which BR-007 requires and
 * VT-18 asserts by stubbing the network to throw and running the guards through it. No guard reads
 * cost data. Cost in this system is advisory, arrives late and is allowed to undercount; a run
 * refused on a number with those properties would be refused unreproducibly.
 */
import { and, count, eq, inArray, ne } from 'drizzle-orm';
import type { ZodError } from 'zod';
import { db } from '../db/drizzle';
import { playbookRuns, playbookStepRuns } from '../db/schema';
import { PlaybookStepSchemaError } from './playbookSteps/descriptorValidation';
import {
  PlaybookStepTypeError,
  getStepTypeDescriptor,
  isAgentStepType,
  isRegisteredStepType,
} from './playbookSteps/registry';
import {
  PLAYBOOK_GUARD_LIMITS,
  type PlaybookGraph,
  type PlaybookGraphNode,
  type PlaybookGuardViolation,
  type PlaybookGuardViolationKind,
  type PlaybookStepTypeDescriptor,
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
 * How a graph node's step type is resolved to the contract it declares.
 *
 * Injectable so the rule can be run against descriptors the registry has never heard of — the
 * conformance test registers a fourth `leaves-apex` type and expects the same refusal — and so the
 * runtime can later pass whichever registry is in force at execution time rather than the one a
 * version was published under.
 */
export type PlaybookStepDescriptorLookup = (
  stepType: string
) => PlaybookStepTypeDescriptor | undefined;

/** Undefined, not a throw, for a type nobody registered: the caller decides what that means. */
const registryLookup: PlaybookStepDescriptorLookup = (stepType) =>
  isRegisteredStepType(stepType) ? getStepTypeDescriptor(stepType) : undefined;

/** A graph node naming a step type the registry cannot resolve. */
export class PlaybookGraphStepTypeError extends PlaybookStepTypeError {
  constructor(nodeId: string, stepType: string) {
    super(
      `Playbook step "${nodeId}" names the step type "${stepType}", which no registered step ` +
        'type matches. A step nothing can execute must not reach a published version.'
    );
    this.name = 'PlaybookGraphStepTypeError';
  }
}

/**
 * A graph node whose `config` its own step type would reject.
 *
 * Named for the node rather than only the type, because a graph may hold several steps of one type
 * and "notify is missing a title" does not say which one.
 */
export class PlaybookGraphNodeConfigError extends PlaybookStepSchemaError {
  readonly nodeId: string;

  constructor(nodeId: string, stepType: string, error: ZodError) {
    super(stepType, 'input', error);
    this.name = 'PlaybookGraphNodeConfigError';
    this.nodeId = nodeId;
    this.message = `Playbook step "${nodeId}": ${this.message}`;
  }
}

/**
 * Whether this step type is a human approval checkpoint.
 *
 * Asked of the descriptor rather than matched against the name `approval-gate`, because the
 * registry is the only place a step type is declared and a rule that branches on a type's name
 * would be a second declaration of the same vocabulary. What makes a gate a gate is that it parks
 * the run until a person decides, which is exactly what these two fields say.
 */
function isApprovalGate(descriptor: PlaybookStepTypeDescriptor | undefined): boolean {
  return descriptor?.canSuspend === true && descriptor.suspendReason === 'approval_gate';
}

function inboundEdges(graph: PlaybookGraph): Map<string, string[]> {
  const inbound = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const existing = inbound.get(edge.to);
    if (existing) existing.push(edge.from);
    else inbound.set(edge.to, [edge.from]);
  }
  return inbound;
}

/**
 * Whether this node reaches outside Apex with something other than a gate in front of it.
 *
 * Edges, not array order. A graph whose nodes read gate-then-agent but whose edge skips the gate is
 * precisely the arrangement an order-based check waves through, and the step it lets run is the one
 * kind Apex cannot undo. An empty inbound set counts as ungated for the same reason: nothing can
 * precede a first step, so a first step can never be the one that leaves.
 */
function isUngatedLeavesApexNode(
  node: PlaybookGraphNode,
  inbound: Map<string, string[]>,
  stepTypeById: Map<string, string>,
  lookup: PlaybookStepDescriptorLookup
): boolean {
  if (lookup(node.stepType)?.sideEffect !== 'leaves-apex') return false;

  const predecessors = inbound.get(node.id) ?? [];
  if (predecessors.length === 0) return true;

  // Every path in, not merely one of them. A predecessor naming an unresolvable type is not a gate.
  return predecessors.some(
    (predecessorId) => !isApprovalGate(lookup(stepTypeById.get(predecessorId) ?? ''))
  );
}

/**
 * Every `leaves-apex` node in this graph that is not gated on all of its inbound edges, per TBI-034.
 *
 * Pure, synchronous and network-free: it reads the graph it is handed and the descriptors the
 * lookup returns, and nothing else. It neither rewrites the graph nor inserts the missing gate —
 * where a checkpoint belongs is the author's decision, and a validator that quietly supplied one
 * would be approving the thing it exists to refuse.
 */
export function findUngatedLeavesApexSteps(
  graph: PlaybookGraph,
  lookup: PlaybookStepDescriptorLookup = registryLookup
): string[] {
  const inbound = inboundEdges(graph);
  const stepTypeById = new Map(graph.nodes.map((node) => [node.id, node.stepType]));

  return graph.nodes
    .filter((node) => isUngatedLeavesApexNode(node, inbound, stepTypeById, lookup))
    .map((node) => node.id);
}

function ungatedViolation(nodeIds: string[]): PlaybookGuardViolationError {
  const named = nodeIds.map((nodeId) => `"${nodeId}"`).join(', ');
  return new PlaybookGuardViolationError(
    'ungated-leaves-apex',
    `${nodeIds.length === 1 ? 'Step' : 'Steps'} ${named} act outside Apex, so every step that can ` +
      'reach them must be an approval gate. Add a gate immediately before each one; a step that ' +
      'leaves Apex cannot be the first step, because nothing precedes it.'
  );
}

/**
 * The same rule asked about one node, for a caller holding a graph and the step it is about to run.
 *
 * The runtime needs this because a published graph's classifications are the ones that were in
 * force when it was published, and a step type reclassified to `leaves-apex` since then would
 * otherwise execute ungated. Whole-graph and per-node share `isUngatedLeavesApexNode` so the two
 * answers cannot drift.
 */
export function assertStepGateSatisfied(
  graph: PlaybookGraph,
  stepId: string,
  lookup: PlaybookStepDescriptorLookup = registryLookup
): void {
  const node = graph.nodes.find((candidate) => candidate.id === stepId);
  if (!node) {
    throw new Error(
      `Playbook step "${stepId}" is not a node in this graph, so no gate rule applies to it.`
    );
  }

  const stepTypeById = new Map(graph.nodes.map((candidate) => [candidate.id, candidate.stepType]));
  if (isUngatedLeavesApexNode(node, inboundEdges(graph), stepTypeById, lookup)) {
    throw ungatedViolation([node.id]);
  }
}

/**
 * Every node names a registered step type and carries a config that type accepts.
 *
 * Run before the gate rule because the gate rule reads classifications: a node whose type the
 * registry cannot resolve has no classification, and treating that silence as "harmless" is how an
 * unrecognised step gets published. Config is parsed here rather than at execution because
 * publication is the last moment a graph can be corrected — after it, immutability means a step
 * with a config nothing can execute can only be deprecated.
 */
export function assertGraphStepsResolvable(
  graph: PlaybookGraph,
  lookup: PlaybookStepDescriptorLookup = registryLookup
): void {
  for (const node of graph.nodes) {
    const descriptor = lookup(node.stepType);
    if (!descriptor) throw new PlaybookGraphStepTypeError(node.id, node.stepType);

    // `safeParse` rather than `parse`, and the result discarded: the graph is the author's and is
    // stored as written, so nothing here may hand back a coerced copy of it.
    const parsed = descriptor.inputSchema.safeParse(node.config ?? {});
    if (!parsed.success) {
      throw new PlaybookGraphNodeConfigError(node.id, node.stepType, parsed.error);
    }
  }
}

/**
 * The publish-time guards, in the order an author most likely tripped.
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

  assertGraphStepsResolvable(graph);

  const ungated = findUngatedLeavesApexSteps(graph);
  if (ungated.length > 0) throw ungatedViolation(ungated);
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
