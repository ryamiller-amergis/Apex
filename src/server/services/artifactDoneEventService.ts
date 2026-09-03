/**
 * Frozen done events for pipeline artifacts (FEAT-001 / TBI-002).
 *
 * Each artifact gets at most one row in `artifact_done_events`, written at the
 * transition that makes it done. The insert is guarded by the unique constraint
 * on (artifact_type, artifact_id) plus `onConflictDoNothing`, so a later edit,
 * re-approval, or regeneration can never move a timestamp a median was already
 * computed from. Nothing in this module updates or deletes an event.
 *
 * Only true terminal transitions belong here — reviewer-stage approvals do not.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { artifactDoneEvents } from '../db/schema';
import type { ArtifactDoneEventType } from '../../shared/types/homeDashboard';

export type { ArtifactDoneEventType };

/**
 * Record the done event for an artifact. Safe to call more than once: the first
 * captured timestamp wins.
 *
 * @param doneAt Instant of the transition. Defaults to now; pass the same
 * timestamp the transition itself was written with so the event matches it even
 * if this insert lands a moment later.
 */
export async function recordArtifactDoneEvent(
  artifactType: ArtifactDoneEventType,
  artifactId: string,
  doneAt: string = new Date().toISOString(),
): Promise<void> {
  await db
    .insert(artifactDoneEvents)
    .values({ artifactType, artifactId, doneAt })
    .onConflictDoNothing();
}

/** The frozen done instant for an artifact, or null when it has no event yet. */
export async function getArtifactDoneEventAt(
  artifactType: ArtifactDoneEventType,
  artifactId: string,
): Promise<string | null> {
  const row = await db.query.artifactDoneEvents.findFirst({
    where: and(
      eq(artifactDoneEvents.artifactType, artifactType),
      eq(artifactDoneEvents.artifactId, artifactId),
    ),
    columns: { doneAt: true },
  });
  return row?.doneAt ?? null;
}
