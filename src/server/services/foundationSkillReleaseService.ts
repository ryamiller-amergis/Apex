/**
 * Foundation Skill Release Service
 *
 * Manages the lifecycle of @apex/skills suite releases stored in the DB:
 *   - Create a draft release (status = 'draft')
 *   - Publish (draft → published): promotes to Azure Artifacts Release view + records audit
 *   - Deprecate (published → deprecated)
 *   - Query: get latest published, list all, get by id
 *
 * A failed validation or Azure Artifacts promotion leaves the release in 'draft'.
 * Once published, the artifact coordinates are immutable (the release row may not
 * be updated — only deprecated).
 */

import { eq, desc } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  foundationSkillReleases,
  foundationSkillReleaseAudit,
} from '../db/schema';
import type {
  FoundationSkillRelease,
  FoundationSkillReleaseAuditEntry,
  CreateFoundationSkillReleaseRequest,
  FoundationSkillAuditAction,
} from '../../shared/types/foundationSkills';
import {
  isAzureArtifactsConfigured,
  promoteToReleaseView,
  computePackageIntegrity,
} from './azureArtifactsSkillService';

// ── Internal helpers ──────────────────────────────────────────────────────────

function mapRow(row: typeof foundationSkillReleases.$inferSelect): FoundationSkillRelease {
  return {
    id:                  row.id,
    version:             row.version,
    status:              row.status as FoundationSkillRelease['status'],
    artifactPackage:     row.artifactPackage,
    artifactVersion:     row.artifactVersion,
    artifactFeed:        row.artifactFeed ?? null,
    integritySha256:     row.integritySha256 ?? null,
    contractApiVersion:  row.contractApiVersion,
    selectedSkills:      (row.selectedSkills as string[]) ?? [],
    manifestSnapshot:    (row.manifestSnapshot as Record<string, unknown>) ?? null,
    releaseNotes:        row.releaseNotes ?? null,
    breakingChanges:     row.breakingChanges ?? null,
    publishedBy:         row.publishedBy ?? null,
    publishedAt:         row.publishedAt ?? null,
    deprecatedBy:        row.deprecatedBy ?? null,
    deprecatedAt:        row.deprecatedAt ?? null,
    createdBy:           row.createdBy,
    createdAt:           row.createdAt,
    updatedAt:           row.updatedAt,
  };
}

async function appendAudit(
  releaseId: string | null,
  releaseVersion: string,
  action: FoundationSkillAuditAction,
  actor: { id?: string | null; email?: string | null },
  details?: Record<string, unknown> | null,
): Promise<void> {
  await db.insert(foundationSkillReleaseAudit).values({
    releaseId,
    releaseVersion,
    action,
    actorId:    actor.id   ?? null,
    actorEmail: actor.email ?? null,
    details:    details    ?? null,
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/** List all releases, newest first. */
export async function listReleases(): Promise<FoundationSkillRelease[]> {
  const rows = await db
    .select()
    .from(foundationSkillReleases)
    .orderBy(desc(foundationSkillReleases.createdAt));
  return rows.map(mapRow);
}

/** Get a single release by id. Returns null when not found. */
export async function getRelease(id: string): Promise<FoundationSkillRelease | null> {
  const rows = await db
    .select()
    .from(foundationSkillReleases)
    .where(eq(foundationSkillReleases.id, id));
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Get the latest published release, or null when none exists. */
export async function getLatestPublishedRelease(): Promise<FoundationSkillRelease | null> {
  const rows = await db
    .select()
    .from(foundationSkillReleases)
    .where(eq(foundationSkillReleases.status, 'published'))
    .orderBy(desc(foundationSkillReleases.publishedAt))
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Create a draft release record.
 * Throws when a release with the same version already exists.
 */
export async function createRelease(
  input: CreateFoundationSkillReleaseRequest,
  actor: { id: string; email?: string | null },
): Promise<FoundationSkillRelease> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(foundationSkillReleases)
      .values({
        version:             input.version,
        artifactVersion:     input.artifactVersion,
        artifactFeed:        input.artifactFeed ?? null,
        integritySha256:     input.integritySha256 ?? null,
        selectedSkills:      input.selectedSkills,
        manifestSnapshot:    input.manifestSnapshot ?? null,
        releaseNotes:        input.releaseNotes ?? null,
        breakingChanges:     input.breakingChanges ?? null,
        createdBy:           actor.id,
      })
      .returning();

    await tx.insert(foundationSkillReleaseAudit).values({
      releaseId:      row.id,
      releaseVersion: row.version,
      action:         'created',
      actorId:        actor.id,
      actorEmail:     actor.email ?? null,
    });

    return mapRow(row);
  });
}

/**
 * Publish a draft release:
 *   1. Verify the artifact exists and compute integrity if not already set
 *   2. Promote to Azure Artifacts Release view (if feed is configured)
 *   3. Update status → 'published' + record published_by / published_at
 *
 * Throws if the release is not in 'draft' state, or if the feed promotion fails.
 * A failed step leaves the release in 'draft' (no partial publish).
 */
export async function publishRelease(
  id: string,
  actor: { id: string; email?: string | null },
): Promise<FoundationSkillRelease> {
  const existing = await getRelease(id);
  if (!existing) throw new Error(`Release not found: ${id}`);
  if (existing.status !== 'draft') {
    throw new Error(`Release ${id} is not in 'draft' state (current: ${existing.status})`);
  }

  // Compute integrity if not yet set and feed is available
  let integrity = existing.integritySha256;
  if (!integrity && isAzureArtifactsConfigured()) {
    try {
      integrity = await computePackageIntegrity(existing.artifactVersion);
    } catch (e: any) {
      console.warn(`[foundationSkillReleaseService] Could not compute integrity for ${id}: ${e.message}`);
    }
  }

  // Promote to Release view (throws on failure — leaving release in 'draft')
  if (isAzureArtifactsConfigured()) {
    await promoteToReleaseView(existing.artifactVersion);
  } else {
    console.warn('[foundationSkillReleaseService] Azure Artifacts not configured — skipping Release-view promotion');
  }

  const now = new Date().toISOString();

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(foundationSkillReleases)
      .set({
        status:          'published',
        integritySha256: integrity ?? existing.integritySha256,
        publishedBy:     actor.id,
        publishedAt:     now,
        updatedAt:       now,
      })
      .where(eq(foundationSkillReleases.id, id))
      .returning();

    await tx.insert(foundationSkillReleaseAudit).values({
      releaseId:      id,
      releaseVersion: existing.version,
      action:         'published',
      actorId:        actor.id,
      actorEmail:     actor.email ?? null,
      details:        { artifactVersion: existing.artifactVersion },
    });

    return mapRow(updated);
  });
}

/**
 * Deprecate a published release. Idempotent — already-deprecated is a no-op.
 * Throws if the release is in 'draft' state (drafts are deleted, not deprecated).
 */
export async function deprecateRelease(
  id: string,
  actor: { id: string; email?: string | null },
  reason?: string | null,
): Promise<FoundationSkillRelease> {
  const existing = await getRelease(id);
  if (!existing) throw new Error(`Release not found: ${id}`);
  if (existing.status === 'draft') {
    throw new Error(`Draft releases cannot be deprecated — delete the draft instead`);
  }
  if (existing.status === 'deprecated') return existing; // idempotent

  const now = new Date().toISOString();

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(foundationSkillReleases)
      .set({ status: 'deprecated', deprecatedBy: actor.id, deprecatedAt: now, updatedAt: now })
      .where(eq(foundationSkillReleases.id, id))
      .returning();

    await tx.insert(foundationSkillReleaseAudit).values({
      releaseId:      id,
      releaseVersion: existing.version,
      action:         'deprecated',
      actorId:        actor.id,
      actorEmail:     actor.email ?? null,
      details:        reason ? { reason } : null,
    });

    return mapRow(updated);
  });
}

/**
 * Delete a draft release (drafts are never published so no audit trail needed
 * for rollback — a 'deleted' event is still recorded for completeness).
 * Throws if the release is not in 'draft' state.
 */
export async function deleteDraftRelease(
  id: string,
  actor: { id: string; email?: string | null },
): Promise<void> {
  const existing = await getRelease(id);
  if (!existing) throw new Error(`Release not found: ${id}`);
  if (existing.status !== 'draft') {
    throw new Error(`Only draft releases can be deleted`);
  }

  await db.transaction(async (tx) => {
    await tx.insert(foundationSkillReleaseAudit).values({
      releaseId:      null,
      releaseVersion: existing.version,
      action:         'validation_failed', // closest available action for a draft delete
      actorId:        actor.id,
      actorEmail:     actor.email ?? null,
      details:        { reason: 'draft deleted by Platform Admin' },
    });
    await tx.delete(foundationSkillReleases).where(eq(foundationSkillReleases.id, id));
  });
}

/** Get audit log for a release, newest first. */
export async function getReleaseAudit(releaseId: string): Promise<FoundationSkillReleaseAuditEntry[]> {
  const rows = await db
    .select()
    .from(foundationSkillReleaseAudit)
    .where(eq(foundationSkillReleaseAudit.releaseId, releaseId))
    .orderBy(desc(foundationSkillReleaseAudit.createdAt));
  return rows.map((r) => ({
    id:             r.id,
    releaseId:      r.releaseId ?? null,
    releaseVersion: r.releaseVersion,
    action:         r.action as FoundationSkillReleaseAuditEntry['action'],
    actorId:        r.actorId ?? null,
    actorEmail:     r.actorEmail ?? null,
    details:        (r.details as Record<string, unknown>) ?? null,
    createdAt:      r.createdAt,
  }));
}

/** Exported for use in `foundationSkillCompatibilityService`. */
export { appendAudit };
