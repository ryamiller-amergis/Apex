/**
 * Starting a Playbook run.
 *
 * The validation order is load-bearing rather than tidy. PBI-001's third criterion requires that a
 * definition with no published version produces **no run row at all** — not a row marked failed —
 * so the version check has to precede the insert. A run row that exists only to record its own
 * rejection would show up in the status view, count against the per-project active-run cap FEAT-005
 * adds, and have to be explained to whoever reads it.
 *
 * The request returns as soon as the first step is enqueued, following the posture of
 * `backgroundWorkflowRouter.routeBackgroundWorkflow`: the caller gets a handle, the work proceeds
 * elsewhere. Nothing here waits on an agent turn, which is what keeps PBI-001's one-second budget
 * achievable regardless of how long the agent actually takes.
 */
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  playbookDefinitions,
  playbookDefinitionVersions,
  playbookRuns,
} from '../db/schema';
import { assertActiveRunCapacity } from './playbookGuardService';
import { beginStepRun, executeStep, failStepRun } from './playbookSteps';
import type { PlaybookGraph, PlaybookGraphNode } from '../../shared/types/playbook';

export class PlaybookDefinitionNotFoundError extends Error {
  constructor(project: string, definitionId: string) {
    super(`No Playbook definition ${definitionId} in project ${project}.`);
    this.name = 'PlaybookDefinitionNotFoundError';
  }
}

export class PlaybookNoPublishedVersionError extends Error {
  constructor(definitionName: string) {
    super(
      `Playbook "${definitionName}" has no published version. ` +
        'Publish a version before starting a run.'
    );
    this.name = 'PlaybookNoPublishedVersionError';
  }
}

export class PlaybookEmptyGraphError extends Error {
  constructor(definitionName: string) {
    super(`The published version of Playbook "${definitionName}" has no steps to run.`);
    this.name = 'PlaybookEmptyGraphError';
  }
}

export interface StartRunResult {
  runId: string;
  status: 'running';
}

/**
 * The node a run begins at: the one nothing points to.
 *
 * Falls back to the first declared node when every node has an inbound edge, which means the graph
 * is cyclic. That is not this function's problem to report — TBI-023 refuses cycles at publish
 * time, so a cycle reaching here is a definition that was published before that guard existed. The
 * fallback makes such a run start somewhere sensible instead of failing with a confusing error
 * about an empty graph.
 */
function entryNode(graph: PlaybookGraph): PlaybookGraphNode | undefined {
  if (graph.nodes.length === 0) return undefined;

  const hasInbound = new Set(graph.edges.map((edge) => edge.to));
  return graph.nodes.find((node) => !hasInbound.has(node.id)) ?? graph.nodes[0];
}

export async function startRun(input: {
  project: string;
  definitionId: string;
  initiatorUserId: string;
}): Promise<StartRunResult> {
  /*
   * Scoped by project as well as id. The route's `requirePermission('playbooks:run')` already
   * resolved the caller's permissions against the project in the body, so resolving the definition
   * within that same project is what stops a definition id from another project being started by
   * guessing one.
   */
  const definition = await db.query.playbookDefinitions.findFirst({
    where: and(
      eq(playbookDefinitions.id, input.definitionId),
      eq(playbookDefinitions.project, input.project)
    ),
  });

  if (!definition) {
    throw new PlaybookDefinitionNotFoundError(input.project, input.definitionId);
  }

  const version = await db.query.playbookDefinitionVersions.findFirst({
    where: and(
      eq(playbookDefinitionVersions.definitionId, definition.id),
      eq(playbookDefinitionVersions.status, 'published')
    ),
    orderBy: [desc(playbookDefinitionVersions.versionNumber)],
  });

  // Before the insert, deliberately. See the file comment.
  if (!version) {
    throw new PlaybookNoPublishedVersionError(definition.name);
  }

  const graph = version.graph as PlaybookGraph;
  const first = entryNode(graph);
  if (!first) {
    throw new PlaybookEmptyGraphError(definition.name);
  }

  /*
   * Between the version check and the insert, so a run refused by the cap writes no row — the same
   * reasoning as the no-published-version case above. The graph guards are not repeated here:
   * publication already ran them, and the version is immutable, so the answer cannot have changed.
   */
  await assertActiveRunCapacity(input.project);

  const [run] = await db
    .insert(playbookRuns)
    .values({
      project: input.project,
      definitionVersionId: version.id,
      // BR-006: the run pins the version it started under, so editing the Playbook afterwards
      // cannot change what this run does.
      initiatorUserId: input.initiatorUserId,
      status: 'running',
    })
    .returning();

  const stepRun = await beginStepRun({
    runId: run.id,
    stepId: first.id,
    stepType: first.stepType,
  });

  try {
    await executeStep({
      runId: run.id,
      stepRunId: stepRun.id,
      stepId: first.id,
      stepType: first.stepType,
      project: input.project,
      initiatorUserId: input.initiatorUserId,
      config: first.config ?? {},
    });
  } catch (error) {
    /*
     * The run row stays. Unlike the no-published-version case, this run really did start — it has a
     * pinned version and a step that failed, and the status view should be able to show why.
     */
    await failStepRun({
      stepRunId: stepRun.id,
      reason: error instanceof Error ? error.message : 'The first step failed',
    });
    await db
      .update(playbookRuns)
      .set({ status: 'failed', completedAt: new Date().toISOString() })
      .where(eq(playbookRuns.id, run.id));

    throw error;
  }

  return { runId: run.id, status: 'running' };
}
