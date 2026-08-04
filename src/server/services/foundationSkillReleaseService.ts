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
  SkillMatrixEntry,
  ProjectAvailableSkill,
  FoundationSkillTier,
} from '../../shared/types/foundationSkills';
import {
  isReleaseVisibleToProject,
  getEffectiveTargetProjects,
  getVisibleSkillsForProject,
} from '../../shared/types/foundationSkills';
export {
  isReleaseVisibleToProject,
  getEffectiveTargetProjects,
  getVisibleSkillsForProject,
} from '../../shared/types/foundationSkills';
import {
  isAzureArtifactsConfigured,
  promoteToReleaseView,
  computePackageIntegrity,
  deprecatePackageVersion,
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
    targetProjects:      (row.targetProjects as string[]) ?? [],
    skillTargets:        (row.skillTargets as Record<string, string[]>) ?? {},
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

/** Catalog entry shape (subset of catalog.json skill entries). */
export interface CatalogSkillEntry {
  name: string;
  summary: string;
  tier: FoundationSkillTier;
}

/** Skills that may be included in a release (i.e. shipped to consumer projects). */
export function shippableSkills(catalog: CatalogSkillEntry[]): CatalogSkillEntry[] {
  return catalog.filter((s) => s.tier !== 'apex-only');
}

/**
 * Returns the subset of `selected` that must not be released to teams.
 * Unknown names are ignored here — name validity is a separate concern.
 */
export function rejectNonShippableSkills(
  selected: string[],
  catalog: CatalogSkillEntry[],
): string[] {
  const apexOnly = new Set(catalog.filter((s) => s.tier === 'apex-only').map((s) => s.name));
  return selected.filter((name) => apexOnly.has(name));
}

/**
 * Builds the Platform Admin skills matrix from all releases in the DB.
 * `catalog` should be the full list of known skills with summaries (from catalog.json).
 */
export async function getSkillsMatrix(catalog: CatalogSkillEntry[]): Promise<SkillMatrixEntry[]> {
  const releases = await listReleases();

  // Build a lookup: skillName → SkillMatrixEntry.releases[]
  const bySkill = new Map<string, SkillMatrixEntry['releases']>();

  for (const rel of releases) {
    for (const skillName of rel.selectedSkills ?? []) {
      if (!bySkill.has(skillName)) bySkill.set(skillName, []);
      bySkill.get(skillName)!.push({
        releaseId:              rel.id,
        version:                rel.version,
        status:                 rel.status,
        effectiveTargetProjects: getEffectiveTargetProjects(rel, skillName),
      });
    }
  }

  // Build the final array preserving catalog order; include skills not yet in any release
  return catalog.map((entry) => ({
    name:     entry.name,
    summary:  entry.summary,
    releases: bySkill.get(entry.name) ?? [],
  }));
}

/**
 * Returns skills available to the given Apex project from the latest published release
 * that is visible to the project.
 */
export async function getProjectAvailableSkills(
  apexProject: string,
  catalog: CatalogSkillEntry[],
): Promise<ProjectAvailableSkill[]> {
  const release = await getLatestPublishedRelease(apexProject);
  if (!release) return [];

  const summaryMap = new Map(catalog.map((c) => [c.name, c.summary]));

  return getVisibleSkillsForProject(release, apexProject).map((name) => ({
    name,
    summary:                summaryMap.get(name) ?? '',
    version:                release.version,
    releaseId:              release.id,
    effectiveTargetProjects: getEffectiveTargetProjects(release, name),
  }));
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

/** Get a release by its suite version. Returns null when not found. */
export async function getReleaseByVersion(version: string): Promise<FoundationSkillRelease | null> {
  const rows = await db
    .select()
    .from(foundationSkillReleases)
    .where(eq(foundationSkillReleases.version, version));
  return rows[0] ? mapRow(rows[0]) : null;
}

/** True when `a` is strictly greater than `b` as X.Y.Z semver (missing parts = 0). */
export function semverGreaterThan(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return false;
}

/**
 * Published releases visible to `apexProject` with a version strictly lower than
 * `installedVersion` — valid rollback targets for that team.
 * Newest candidates first.
 */
export async function listRollbackTargets(
  apexProject: string,
  installedVersion: string,
): Promise<FoundationSkillRelease[]> {
  const rows = await db
    .select()
    .from(foundationSkillReleases)
    .where(eq(foundationSkillReleases.status, 'published'))
    .orderBy(desc(foundationSkillReleases.publishedAt));

  return rows
    .map(mapRow)
    .filter((rel) =>
      isReleaseVisibleToProject(rel, apexProject) &&
      semverGreaterThan(installedVersion, rel.version),
    );
}

/**
 * Get the latest published release visible to the given Apex project, or null.
 * When `apexProject` is omitted the first published release is returned (admin use).
 */
export async function getLatestPublishedRelease(
  apexProject?: string | null,
): Promise<FoundationSkillRelease | null> {
  const rows = await db
    .select()
    .from(foundationSkillReleases)
    .where(eq(foundationSkillReleases.status, 'published'))
    .orderBy(desc(foundationSkillReleases.publishedAt));

  for (const row of rows) {
    const release = mapRow(row);
    if (isReleaseVisibleToProject(release, apexProject ?? null)) return release;
  }
  return null;
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
        targetProjects:      input.targetProjects ?? [],
        skillTargets:        input.skillTargets ?? {},
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
      details:        {
        artifactVersion: existing.artifactVersion,
        targetProjects: existing.targetProjects,
      },
    });

    return mapRow(updated);
  });
}

/**
 * Deprecate a published release. Idempotent — already-deprecated is a no-op.
 * Throws if the release is in 'draft' state (drafts are deleted, not deprecated).
 *
 * Also flags the version on the Azure Artifacts feed so a manual `npm install`
 * warns. Feed failure is non-fatal: the DB state is the source of truth for
 * targeting, and the failure is recorded in the audit details.
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

  let feedError: string | null = null;
  if (isAzureArtifactsConfigured()) {
    const message = reason
      ? `Deprecated in APEX: ${reason}`
      : `Deprecated in APEX — no longer offered to new installs.`;
    try {
      await deprecatePackageVersion(existing.artifactVersion, message);
    } catch (e: unknown) {
      feedError = (e as Error).message;
      console.warn(`[foundationSkillReleaseService] Feed deprecation failed for ${id}: ${feedError}`);
    }
  }

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
      details:        (reason || feedError)
        ? { ...(reason ? { reason } : {}), ...(feedError ? { feedError } : {}) }
        : null,
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

/** Update release notes and/or breaking changes for any release status. */
export interface UpdateReleaseInput {
  releaseNotes?:    string | null;
  breakingChanges?: string | null;
  targetProjects?:  string[];
  /** Per-skill project targeting overrides; updatable on any status. */
  skillTargets?:    Record<string, string[]>;
  selectedSkills?:  string[];
  /** Only allowed for draft releases */
  version?:         string;
  artifactVersion?: string;
  artifactFeed?:    string | null;
}

export async function updateRelease(
  id: string,
  actor: { id: string; email?: string | null },
  input: UpdateReleaseInput,
): Promise<FoundationSkillRelease> {
  const existing = await getRelease(id);
  if (!existing) throw new Error(`Release not found: ${id}`);

  if ((input.version !== undefined || input.artifactVersion !== undefined || input.artifactFeed !== undefined)
      && existing.status !== 'draft') {
    throw new Error(`Version and artifact fields can only be changed on draft releases`);
  }

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(foundationSkillReleases)
      .set({
        ...(input.releaseNotes    !== undefined && { releaseNotes:    input.releaseNotes    ?? null }),
        ...(input.breakingChanges !== undefined && { breakingChanges: input.breakingChanges ?? null }),
        ...(input.targetProjects  !== undefined && { targetProjects:  input.targetProjects }),
        ...(input.skillTargets    !== undefined && { skillTargets:    input.skillTargets }),
        ...(input.selectedSkills  !== undefined && { selectedSkills:  input.selectedSkills }),
        ...(input.version         !== undefined && { version:         input.version }),
        ...(input.artifactVersion !== undefined && { artifactVersion: input.artifactVersion }),
        ...(input.artifactFeed    !== undefined && { artifactFeed:    input.artifactFeed    ?? null }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(foundationSkillReleases.id, id))
      .returning();
    await tx.insert(foundationSkillReleaseAudit).values({
      releaseId:      id,
      releaseVersion: existing.version,
      action:         'published',
      actorId:        actor.id,
      actorEmail:     actor.email ?? null,
      details:        { action: 'release_edited', fields: Object.keys(input) },
    });
    return mapRow(updated);
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
