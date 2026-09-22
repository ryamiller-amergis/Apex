/**
 * Write path for playbook definition versions, and the place version immutability is enforced.
 *
 * BR-006 says a published version is never edited — a run pins a version id and may sit suspended
 * against it for days, so its content changing underneath would rewrite history the run already
 * acted on. Postgres cannot express "no column may change once status is published, except status"
 * without a trigger, and a trigger puts business logic in a second place nobody reads. So the rule
 * lives here and is proven by a test, which is what TBI-011's definition of done asks for.
 *
 * The database still backstops the part that matters most: a version any run pinned cannot be
 * hard-deleted, because `playbook_runs.definition_version_id` is a restrict-mode foreign key.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { playbookDefinitions, playbookDefinitionVersions } from '../db/schema';
import { assertGraphWithinGuards } from './playbookGuardService';
import { assertCursorAgentsUseReadOnlyMcp } from './playbookMcpCapabilityService';
import type {
  PlaybookDefinition,
  PlaybookDefinitionDetail,
  PlaybookDefinitionDraft,
  PlaybookDefinitionDraftResponse,
  PlaybookDefinitionListResult,
  PlaybookDeprecateVersionResponse,
  PlaybookGraph,
  PlaybookPublishedVersionSummary,
  PlaybookPublishResponse,
  PlaybookVersionStatus,
} from '../../shared/types/playbook';

/**
 * Legal lifecycle moves.
 *
 * `published -> draft` is absent deliberately: allowing it would be an unpublish-edit-republish
 * route around immutability, which is the same violation taking three steps instead of one. A
 * correction to a published version is a new version.
 */
const ALLOWED_TRANSITIONS: Record<
  PlaybookVersionStatus,
  readonly PlaybookVersionStatus[]
> = {
  draft: ['published'],
  published: ['deprecated', 'archived'],
  deprecated: ['archived'],
  archived: [],
};

/** Thrown when a caller tries to change content that publication froze. */
export class PlaybookVersionImmutableError extends Error {
  constructor(versionId: string, status: PlaybookVersionStatus) {
    super(
      `Playbook definition version ${versionId} is ${status} and its content is immutable. ` +
        'Only the lifecycle status may change after publication; publish a new version instead.'
    );
    this.name = 'PlaybookVersionImmutableError';
  }
}

/** Thrown when a lifecycle move is not one of the legal transitions. */
export class PlaybookVersionTransitionError extends Error {
  constructor(from: PlaybookVersionStatus, to: PlaybookVersionStatus) {
    super(
      `Cannot move a playbook definition version from ${from} to ${to}. ` +
        `Legal moves from ${from}: ${ALLOWED_TRANSITIONS[from].join(', ') || 'none'}.`
    );
    this.name = 'PlaybookVersionTransitionError';
  }
}

export class PlaybookVersionNotFoundError extends Error {
  constructor(versionId: string) {
    super(`Playbook definition version ${versionId} was not found.`);
    this.name = 'PlaybookVersionNotFoundError';
  }
}

/** Unknown and cross-project definition ids deliberately produce the same result. */
export class PlaybookDefinitionNotFoundError extends Error {
  constructor(definitionId: string) {
    super(
      `Playbook definition ${definitionId} was not found in the requested project.`
    );
    this.name = 'PlaybookDefinitionNotFoundError';
  }
}

/** A retained draft is a required lifecycle invariant for every definition. */
export class PlaybookDraftNotFoundError extends Error {
  constructor(definitionId: string) {
    super(`Playbook definition ${definitionId} has no retained draft.`);
    this.name = 'PlaybookDraftNotFoundError';
  }
}

/** The caller saved or published from a revision that another author has replaced. */
export class PlaybookDraftConflictError extends Error {
  constructor(definitionId: string) {
    super(
      `The draft for playbook definition ${definitionId} changed; reload it and try again.`
    );
    this.name = 'PlaybookDraftConflictError';
  }
}

/** Content may only be edited while a version is still a draft. */
export function assertContentMutable(
  versionId: string,
  status: PlaybookVersionStatus
): void {
  if (status !== 'draft')
    throw new PlaybookVersionImmutableError(versionId, status);
}

export function assertLifecycleTransition(
  from: PlaybookVersionStatus,
  to: PlaybookVersionStatus
): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new PlaybookVersionTransitionError(from, to);
  }
}

async function loadStatus(versionId: string): Promise<PlaybookVersionStatus> {
  const row = await db.query.playbookDefinitionVersions.findFirst({
    where: eq(playbookDefinitionVersions.id, versionId),
    columns: { status: true },
  });
  if (!row) throw new PlaybookVersionNotFoundError(versionId);
  return row.status;
}

/** Replaces a draft's graph. Refuses once the version has been published. */
export async function updateVersionGraph(
  versionId: string,
  graph: PlaybookGraph
): Promise<void> {
  assertContentMutable(versionId, await loadStatus(versionId));

  await db
    .update(playbookDefinitionVersions)
    .set({ graph })
    .where(eq(playbookDefinitionVersions.id, versionId));
}

/**
 * Freezes a draft. After this the graph is fixed and only the lifecycle status can move.
 *
 * TBI-023's four graph guards run here and nowhere else. Publication is the last moment the shape
 * can be rejected — afterwards immutability means a bad graph can only be deprecated, never fixed,
 * and every run started from it has already been admitted.
 */
export async function publishVersion(
  versionId: string,
  publishedByUserId: string
): Promise<void> {
  const version = await db.query.playbookDefinitionVersions.findFirst({
    where: eq(playbookDefinitionVersions.id, versionId),
    columns: { status: true, graph: true },
  });
  if (!version) throw new PlaybookVersionNotFoundError(versionId);

  assertLifecycleTransition(version.status, 'published');
  assertGraphWithinGuards(version.graph as PlaybookGraph);
  assertCursorAgentsUseReadOnlyMcp(version.graph as PlaybookGraph);

  await db
    .update(playbookDefinitionVersions)
    .set({
      status: 'published',
      publishedBy: publishedByUserId,
      publishedAt: new Date().toISOString(),
    })
    .where(eq(playbookDefinitionVersions.id, versionId));
}

/**
 * Moves a published version along its lifecycle. This is the one column publication leaves mutable,
 * which is how a version stops being offered for new runs without disturbing runs already pinned
 * to it.
 */
export async function moveVersionLifecycle(
  versionId: string,
  next: PlaybookVersionStatus
): Promise<void> {
  assertLifecycleTransition(await loadStatus(versionId), next);

  await db
    .update(playbookDefinitionVersions)
    .set({ status: next })
    .where(eq(playbookDefinitionVersions.id, versionId));
}

type DefinitionRow = typeof playbookDefinitions.$inferSelect;
type VersionRow = typeof playbookDefinitionVersions.$inferSelect;

interface CreateDefinitionInput {
  project: string;
  name: string;
  description?: string | null;
  graph: PlaybookGraph;
  createdByUserId: string;
}

interface UpdateDraftInput {
  project: string;
  definitionId: string;
  name: string;
  description?: string | null;
  graph: PlaybookGraph;
  expectedDraftUpdatedAt: string;
}

interface PublishDraftInput {
  project: string;
  definitionId: string;
  publishedByUserId: string;
  expectedDraftUpdatedAt: string;
}

interface DeprecateVersionInput {
  project: string;
  definitionId: string;
  versionId: string;
}

const versionSelection = {
  id: playbookDefinitionVersions.id,
  definitionId: playbookDefinitionVersions.definitionId,
  versionNumber: playbookDefinitionVersions.versionNumber,
  graph: playbookDefinitionVersions.graph,
  status: playbookDefinitionVersions.status,
  publishedBy: playbookDefinitionVersions.publishedBy,
  publishedAt: playbookDefinitionVersions.publishedAt,
  createdAt: playbookDefinitionVersions.createdAt,
  updatedAt: playbookDefinitionVersions.updatedAt,
};

function toDefinition(row: DefinitionRow): PlaybookDefinition {
  return {
    id: row.id,
    project: row.project,
    name: row.name,
    description: row.description,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDraft(row: VersionRow): PlaybookDefinitionDraft {
  return {
    id: row.id,
    definitionId: row.definitionId,
    nextVersionNumber: row.versionNumber,
    graph: row.graph,
    updatedAt: row.updatedAt,
  };
}

function toPublishedSummary(row: VersionRow): PlaybookPublishedVersionSummary {
  return {
    id: row.id,
    definitionId: row.definitionId,
    versionNumber: row.versionNumber,
    status: row.status,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt,
  };
}

function expectDefinition(
  row: DefinitionRow | undefined,
  definitionId: string
): DefinitionRow {
  if (!row) throw new PlaybookDefinitionNotFoundError(definitionId);
  return row;
}

function expectDraft(
  row: VersionRow | undefined,
  definitionId: string
): VersionRow {
  if (!row) throw new PlaybookDraftNotFoundError(definitionId);
  return row;
}

function assertExpectedRevision(
  definitionId: string,
  actual: string,
  expected: string
): void {
  if (actual !== expected) throw new PlaybookDraftConflictError(definitionId);
}

/**
 * Creates definition identity and its sole retained draft atomically. No published history exists
 * until the first successful copy-on-publish.
 */
export async function createDefinition(
  input: CreateDefinitionInput
): Promise<PlaybookDefinitionDetail> {
  return db.transaction(async (tx) => {
    const [definition] = await tx
      .insert(playbookDefinitions)
      .values({
        project: input.project,
        name: input.name.trim(),
        description: input.description ?? null,
        createdBy: input.createdByUserId,
      })
      .returning();

    const [draft] = await tx
      .insert(playbookDefinitionVersions)
      .values({
        definitionId: definition.id,
        versionNumber: 1,
        graph: input.graph,
        status: 'draft',
      })
      .returning();

    return {
      definition: toDefinition(definition),
      draft: toDraft(draft),
      versions: [],
      currentPublishedVersionId: null,
    };
  });
}

/**
 * Saves the existing retained draft by optimistic revision. Definition identity metadata shares
 * the transaction so callers never observe a renamed definition with an older graph, or vice versa.
 */
export async function updateDraft(
  input: UpdateDraftInput
): Promise<PlaybookDefinitionDraftResponse> {
  return db.transaction(async (tx) => {
    const [definitionRow] = await tx
      .select()
      .from(playbookDefinitions)
      .where(
        and(
          eq(playbookDefinitions.id, input.definitionId),
          eq(playbookDefinitions.project, input.project)
        )
      )
      .for('update');
    expectDefinition(definitionRow, input.definitionId);

    const [draftRow] = await tx
      .select(versionSelection)
      .from(playbookDefinitionVersions)
      .where(
        and(
          eq(playbookDefinitionVersions.definitionId, input.definitionId),
          eq(playbookDefinitionVersions.status, 'draft')
        )
      )
      .for('update');
    const draft = expectDraft(draftRow, input.definitionId);
    assertExpectedRevision(
      input.definitionId,
      draft.updatedAt,
      input.expectedDraftUpdatedAt
    );

    const now = new Date().toISOString();
    const [definition] = await tx
      .update(playbookDefinitions)
      .set({
        name: input.name.trim(),
        description: input.description ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(playbookDefinitions.id, input.definitionId),
          eq(playbookDefinitions.project, input.project)
        )
      )
      .returning();

    const [updatedDraft] = await tx
      .update(playbookDefinitionVersions)
      .set({ graph: input.graph, updatedAt: now })
      .where(
        and(
          eq(playbookDefinitionVersions.id, draft.id),
          eq(playbookDefinitionVersions.status, 'draft'),
          eq(playbookDefinitionVersions.updatedAt, input.expectedDraftUpdatedAt)
        )
      )
      .returning();
    if (!updatedDraft) throw new PlaybookDraftConflictError(input.definitionId);

    return {
      definition: toDefinition(definition),
      draft: toDraft(updatedDraft),
    };
  });
}

/**
 * Copies a valid retained draft to immutable history in one transaction.
 *
 * Advancing the draft first frees candidate number N under the existing unique constraint. The
 * immutable copy is then inserted at N. Any later error rejects the transaction and restores the
 * draft's original number and revision.
 */
export async function publishDraft(
  input: PublishDraftInput
): Promise<PlaybookPublishResponse> {
  return db.transaction(async (tx) => {
    const [draftRow] = await tx
      .select(versionSelection)
      .from(playbookDefinitionVersions)
      .innerJoin(
        playbookDefinitions,
        eq(playbookDefinitions.id, playbookDefinitionVersions.definitionId)
      )
      .where(
        and(
          eq(playbookDefinitions.id, input.definitionId),
          eq(playbookDefinitions.project, input.project),
          eq(playbookDefinitionVersions.status, 'draft')
        )
      )
      .for('update');
    const draft = expectDraft(draftRow, input.definitionId);
    assertExpectedRevision(
      input.definitionId,
      draft.updatedAt,
      input.expectedDraftUpdatedAt
    );
    assertGraphWithinGuards(draft.graph);
    assertCursorAgentsUseReadOnlyMcp(draft.graph);

    const publishedAt = new Date().toISOString();
    const [advancedDraft] = await tx
      .update(playbookDefinitionVersions)
      .set({
        versionNumber: draft.versionNumber + 1,
        updatedAt: publishedAt,
      })
      .where(
        and(
          eq(playbookDefinitionVersions.id, draft.id),
          eq(playbookDefinitionVersions.status, 'draft'),
          eq(playbookDefinitionVersions.updatedAt, input.expectedDraftUpdatedAt)
        )
      )
      .returning();
    if (!advancedDraft)
      throw new PlaybookDraftConflictError(input.definitionId);

    const [publishedVersion] = await tx
      .insert(playbookDefinitionVersions)
      .values({
        definitionId: draft.definitionId,
        versionNumber: draft.versionNumber,
        graph: draft.graph,
        status: 'published',
        publishedBy: input.publishedByUserId,
        publishedAt,
      })
      .returning();

    return {
      publishedVersion: toPublishedSummary(publishedVersion),
      draft: toDraft(advancedDraft),
      currentPublishedVersionId: publishedVersion.id,
    };
  });
}

/** Returns project-scoped definition identity, retained draft, and complete immutable history. */
export async function getDefinitionDetail(
  project: string,
  definitionId: string
): Promise<PlaybookDefinitionDetail> {
  const [definitionRow] = await db
    .select()
    .from(playbookDefinitions)
    .where(
      and(
        eq(playbookDefinitions.id, definitionId),
        eq(playbookDefinitions.project, project)
      )
    );
  const definition = expectDefinition(definitionRow, definitionId);

  const rows = await db
    .select(versionSelection)
    .from(playbookDefinitionVersions)
    .where(eq(playbookDefinitionVersions.definitionId, definitionId))
    .orderBy(desc(playbookDefinitionVersions.versionNumber));
  const draft = expectDraft(
    rows.find((row) => row.status === 'draft'),
    definitionId
  );
  const versions = rows
    .filter((row) => row.status !== 'draft')
    .map(toPublishedSummary);
  const current = versions.find((version) => version.status === 'published');

  return {
    definition: toDefinition(definition),
    draft: toDraft(draft),
    versions,
    currentPublishedVersionId: current?.id ?? null,
  };
}

/** Lists project definitions with draft revisions and current published numbers, without graphs. */
export async function listDefinitions(
  project: string
): Promise<PlaybookDefinitionListResult> {
  const definitions = await db
    .select()
    .from(playbookDefinitions)
    .where(eq(playbookDefinitions.project, project))
    .orderBy(desc(playbookDefinitions.createdAt));
  if (definitions.length === 0) return { definitions: [] };

  const versions = await db
    .select(versionSelection)
    .from(playbookDefinitionVersions)
    .where(
      inArray(
        playbookDefinitionVersions.definitionId,
        definitions.map((definition) => definition.id)
      )
    );

  return {
    definitions: definitions.map((definition) => {
      const matching = versions.filter(
        (version) => version.definitionId === definition.id
      );
      const draft = expectDraft(
        matching.find((version) => version.status === 'draft'),
        definition.id
      );
      const currentPublishedVersionNumber = matching
        .filter((version) => version.status === 'published')
        .reduce<number | null>(
          (highest, version) =>
            highest === null || version.versionNumber > highest
              ? version.versionNumber
              : highest,
          null
        );
      return {
        id: definition.id,
        project: definition.project,
        name: definition.name,
        description: definition.description,
        draftUpdatedAt: draft.updatedAt,
        currentPublishedVersionNumber,
      };
    }),
  };
}

/**
 * Deprecates one same-project published row. Existing run pins and every other history row remain
 * untouched; the highest older published row becomes current automatically.
 */
export async function deprecateVersion(
  input: DeprecateVersionInput
): Promise<PlaybookDeprecateVersionResponse> {
  return db.transaction(async (tx) => {
    const [version] = await tx
      .select(versionSelection)
      .from(playbookDefinitionVersions)
      .innerJoin(
        playbookDefinitions,
        eq(playbookDefinitions.id, playbookDefinitionVersions.definitionId)
      )
      .where(
        and(
          eq(playbookDefinitionVersions.id, input.versionId),
          eq(playbookDefinitionVersions.definitionId, input.definitionId),
          eq(playbookDefinitions.project, input.project)
        )
      )
      .for('update');
    if (!version) throw new PlaybookVersionNotFoundError(input.versionId);
    assertLifecycleTransition(version.status, 'deprecated');

    const [deprecatedVersion] = await tx
      .update(playbookDefinitionVersions)
      .set({ status: 'deprecated' })
      .where(
        and(
          eq(playbookDefinitionVersions.id, input.versionId),
          eq(playbookDefinitionVersions.status, 'published')
        )
      )
      .returning();
    if (!deprecatedVersion) {
      throw new PlaybookVersionTransitionError(version.status, 'deprecated');
    }

    const [current] = await tx
      .select({ id: playbookDefinitionVersions.id })
      .from(playbookDefinitionVersions)
      .where(
        and(
          eq(playbookDefinitionVersions.definitionId, input.definitionId),
          eq(playbookDefinitionVersions.status, 'published')
        )
      )
      .orderBy(desc(playbookDefinitionVersions.versionNumber))
      .limit(1);

    return {
      version: toPublishedSummary(deprecatedVersion),
      currentPublishedVersionId: current?.id ?? null,
    };
  });
}
