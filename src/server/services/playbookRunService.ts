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
import { beginRun } from './playbookAdvanceService';
import type { PlaybookGraph } from '../../shared/types/playbook';

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
  if (graph.nodes.length === 0) {
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

  /*
   * The engine takes over here. It drives forward until a step parks or the graph ends, which is
   * what lets a definition whose steps all complete in-tick finish without anything nudging it.
   */
  const chain = await beginRun({
    runId: run.id,
    project: input.project,
    initiatorUserId: input.initiatorUserId,
    definitionVersionId: version.id,
    graph,
  });

  /*
   * The run row stays on failure. Unlike the no-published-version case, this run really did start —
   * it has a pinned version and a step that failed, and the status view should be able to show why.
   * The chain has already marked both the step and the run failed; rethrowing is what turns a
   * first-step failure into a response the caller can act on rather than a 201 for a dead run.
   */
  if (chain.endedAs === 'failed') {
    throw chain.error;
  }

  return { runId: run.id, status: 'running' };
}
