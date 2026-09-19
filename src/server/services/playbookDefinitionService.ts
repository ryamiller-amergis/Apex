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
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { playbookDefinitionVersions } from '../db/schema';
import type { PlaybookGraph, PlaybookVersionStatus } from '../../shared/types/playbook';

/**
 * Legal lifecycle moves.
 *
 * `published -> draft` is absent deliberately: allowing it would be an unpublish-edit-republish
 * route around immutability, which is the same violation taking three steps instead of one. A
 * correction to a published version is a new version.
 */
const ALLOWED_TRANSITIONS: Record<PlaybookVersionStatus, readonly PlaybookVersionStatus[]> = {
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
    super(`No playbook definition version with id ${versionId}.`);
    this.name = 'PlaybookVersionNotFoundError';
  }
}

/** Content may only be edited while a version is still a draft. */
export function assertContentMutable(versionId: string, status: PlaybookVersionStatus): void {
  if (status !== 'draft') throw new PlaybookVersionImmutableError(versionId, status);
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
export async function updateVersionGraph(versionId: string, graph: PlaybookGraph): Promise<void> {
  assertContentMutable(versionId, await loadStatus(versionId));

  await db
    .update(playbookDefinitionVersions)
    .set({ graph })
    .where(eq(playbookDefinitionVersions.id, versionId));
}

/** Freezes a draft. After this the graph is fixed and only the lifecycle status can move. */
export async function publishVersion(versionId: string, publishedByUserId: string): Promise<void> {
  assertLifecycleTransition(await loadStatus(versionId), 'published');

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
