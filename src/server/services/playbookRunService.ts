/**
 * Starting a Playbook run.
 *
 * The validation order is load-bearing rather than tidy. PBI-001's third criterion requires that a
 * definition with no published version produces **no run row at all** — not a row marked failed —
 * so the version check has to precede the insert. A run row that exists only to record its own
 * rejection would show up in the status view, count against the per-project active-run cap FEAT-005
 * adds, and have to be explained to whoever reads it. TBI-031's refused pins — deprecated,
 * archived, draft, another definition's version, or no stated reason — sit in the same position,
 * ahead of both the capacity check and the insert, for the same reason.
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
import type { PlaybookGraph, StartRunRequest } from '../../shared/types/playbook';

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

export class PlaybookVersionPinReasonRequiredError extends Error {
  constructor(versionId: string) {
    super(
      `Pinning version ${versionId} requires a documented reason. ` +
        'Send a non-blank versionPinReason, or omit definitionVersionId to run the current ' +
        'published version.'
    );
    this.name = 'PlaybookVersionPinReasonRequiredError';
  }
}

export class PlaybookVersionPinNotFoundError extends Error {
  constructor(project: string, definitionName: string, versionId: string) {
    super(
      `Version ${versionId} is not a version of Playbook "${definitionName}" in project ` +
        `${project}. Pin a version of this Playbook, or omit definitionVersionId to run the ` +
        'current published version.'
    );
    this.name = 'PlaybookVersionPinNotFoundError';
  }
}

export class PlaybookVersionPinNotPublishedError extends Error {
  constructor(definitionName: string, versionNumber: number, status: string) {
    super(
      `Version ${versionNumber} of Playbook "${definitionName}" is ${status}, not published. ` +
        'Pin a published version, or omit definitionVersionId to run the current published version.'
    );
    this.name = 'PlaybookVersionPinNotPublishedError';
  }
}

export interface RunnableVersionResolution {
  definition: typeof playbookDefinitions.$inferSelect;
  version: typeof playbookDefinitionVersions.$inferSelect;
  /** The trimmed reason for an explicit pin; null when the current published version was taken. */
  versionPinReason: string | null;
}

/**
 * TBI-031 — which version a new run gets.
 *
 * Both paths start from the same project-scoped definition lookup, so neither can cross a project
 * boundary: an explicit pin is matched within the definition that lookup returned rather than by
 * version id alone. The pinned lookup deliberately does not filter on status, because a caller who
 * pins a deprecated version should be told it is deprecated rather than told it does not exist.
 */
export async function resolveRunnableVersion(input: {
  project: string;
  definitionId: string;
  explicitVersionId?: string;
  pinReason?: string;
}): Promise<RunnableVersionResolution> {
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

  if (!input.explicitVersionId) {
    const current = await db.query.playbookDefinitionVersions.findFirst({
      where: and(
        eq(playbookDefinitionVersions.definitionId, definition.id),
        eq(playbookDefinitionVersions.status, 'published')
      ),
      orderBy: [desc(playbookDefinitionVersions.versionNumber)],
    });

    // Before the insert, deliberately. See the file comment.
    if (!current) {
      throw new PlaybookNoPublishedVersionError(definition.name);
    }

    return { definition, version: current, versionPinReason: null };
  }

  /*
   * The reason is what makes an old version's use auditable later, so a pin without one is refused
   * before the version is even read. There is nothing to look up on behalf of a request that
   * cannot be recorded.
   */
  const pinReason = input.pinReason?.trim();
  if (!pinReason) {
    throw new PlaybookVersionPinReasonRequiredError(input.explicitVersionId);
  }

  const pinned = await db.query.playbookDefinitionVersions.findFirst({
    where: and(
      eq(playbookDefinitionVersions.id, input.explicitVersionId),
      eq(playbookDefinitionVersions.definitionId, definition.id)
    ),
  });

  if (!pinned) {
    throw new PlaybookVersionPinNotFoundError(
      input.project,
      definition.name,
      input.explicitVersionId
    );
  }

  if (pinned.status !== 'published') {
    throw new PlaybookVersionPinNotPublishedError(
      definition.name,
      pinned.versionNumber,
      pinned.status
    );
  }

  return { definition, version: pinned, versionPinReason: pinReason };
}

/** Narrows the shared `StartRunResult`: a run this call created has only just started. */
export interface StartRunResult {
  runId: string;
  status: 'running';
  definitionVersionId: string;
}

export interface StartRunInput extends StartRunRequest {
  initiatorUserId: string;
}

export async function startRun(input: StartRunInput): Promise<StartRunResult> {
  const { definition, version, versionPinReason } = await resolveRunnableVersion({
    project: input.project,
    definitionId: input.definitionId,
    explicitVersionId: input.definitionVersionId,
    pinReason: input.versionPinReason,
  });

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
      versionPinReason,
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

  return { runId: run.id, status: 'running', definitionVersionId: version.id };
}
