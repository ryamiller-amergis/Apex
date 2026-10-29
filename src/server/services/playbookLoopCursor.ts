/**
 * Which graph node a loop iteration belongs to, and whether that iteration should run.
 * Step ids stay unique per iteration (`nodeId#2`) because a run can store one row per step id.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { playbookStepRuns } from '../db/schema';
import type {
  PlaybookGraph,
  PlaybookGraphNode,
} from '../../shared/types/playbook';

export function iterationIndex(stepId: string): {
  baseId: string;
  index: number;
} {
  const match = /^(.*)#(\d+)$/.exec(stepId);
  if (!match) return { baseId: stepId, index: 0 };
  return { baseId: match[1], index: Number(match[2]) };
}

/** The foreach or until that owns this body step, walking a linear chain of predecessors. */
export function owningLoop(
  graph: PlaybookGraph,
  stepId: string
): { loopId: string; kind: 'foreach' | 'until'; index: number } | null {
  const { baseId, index } = iterationIndex(stepId);
  let cursor = baseId;
  const seen = new Set<string>();
  while (!seen.has(cursor)) {
    seen.add(cursor);
    const inbound = graph.edges.filter((edge) => edge.to === cursor);
    if (inbound.length !== 1) return null;
    const previous = graph.nodes.find((node) => node.id === inbound[0].from);
    if (!previous || previous.stepType === 'join' || previous.parallel)
      return null;
    if (previous.stepType === 'foreach' || previous.stepType === 'until') {
      return { loopId: previous.id, kind: previous.stepType, index };
    }
    cursor = previous.id;
  }
  return null;
}

async function readStepOutput(
  runId: string,
  stepId: string
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ output: playbookStepRuns.outputInline })
    .from(playbookStepRuns)
    .where(
      and(
        eq(playbookStepRuns.runId, runId),
        eq(playbookStepRuns.stepId, stepId)
      )
    )
    .limit(1);
  if (!row?.output || typeof row.output !== 'object') return null;
  return row.output as Record<string, unknown>;
}

/**
 * True when this iteration is past the list, or a previous until already stopped.
 * The loop step itself always runs so it can record that decision.
 */
export async function loopStepShouldSkip(
  runId: string,
  graph: PlaybookGraph,
  node: PlaybookGraphNode,
  engineStepId: string
): Promise<boolean> {
  const { index } = iterationIndex(engineStepId);
  if (node.stepType === 'until' && index > 0) {
    const previousId = index === 1 ? node.id : `${node.id}#${index - 1}`;
    const output = await readStepOutput(runId, previousId);
    return output?.continue !== true;
  }
  if (node.stepType === 'foreach' || node.stepType === 'until') return false;
  const owner = owningLoop(graph, engineStepId);
  if (!owner) return false;
  if (owner.kind === 'foreach') {
    const output = await readStepOutput(runId, owner.loopId);
    const iterations =
      typeof output?.iterations === 'number' ? output.iterations : 0;
    return owner.index >= iterations;
  }
  const untilId =
    owner.index === 0 ? owner.loopId : `${owner.loopId}#${owner.index}`;
  const output = await readStepOutput(runId, untilId);
  return output?.continue !== true;
}

/** Puts the current list element on the foreach output so later bindings can read it. */
export async function exposeForeachItem(
  runId: string,
  graph: PlaybookGraph,
  engineStepId: string
): Promise<void> {
  const owner = owningLoop(graph, engineStepId);
  if (!owner || owner.kind !== 'foreach') return;
  const [row] = await db
    .select({
      output: playbookStepRuns.outputInline,
      input: playbookStepRuns.inputInline,
    })
    .from(playbookStepRuns)
    .where(
      and(
        eq(playbookStepRuns.runId, runId),
        eq(playbookStepRuns.stepId, owner.loopId)
      )
    )
    .limit(1);
  if (!row) return;
  const items = Array.isArray((row.input as { items?: unknown } | null)?.items)
    ? (row.input as { items: unknown[] }).items
    : [];
  const output =
    row.output && typeof row.output === 'object'
      ? (row.output as Record<string, unknown>)
      : {};
  await db
    .update(playbookStepRuns)
    .set({
      outputInline: { ...output, item: items[owner.index], index: owner.index },
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(playbookStepRuns.runId, runId),
        eq(playbookStepRuns.stepId, owner.loopId)
      )
    );
}
