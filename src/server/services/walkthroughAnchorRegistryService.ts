/**
 * Smart Anchor Management — Phase 2 catalog CRUD + validation.
 * Wave 2 Track A: scanner extract → persist (before AI smart-tagging).
 * Drizzle-backed service for the walkthrough_anchor_registry table.
 */

import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db } from '../db/drizzle';
import { walkthroughAnchorRegistry } from '../db/schema';
import type { WalkthroughRegistryPlacement } from '../../shared/walkthroughAnchors';
import {
  toAuthoringAnchorEntry,
  type WalkthroughAnchorRegistryEntry,
} from '../../shared/walkthroughAnchors';
import {
  WalkthroughAnchorRegistryError,
  isWalkthroughAnchorReviewStatus,
  isWalkthroughAnchorSourceKind,
  normalizeSmartTags,
  validateAnchorRegistryCandidate,
  type BulkWalkthroughAnchorCommand,
  type CreateManualWalkthroughAnchorCommand,
  type CreateWalkthroughAnchorFromCandidateCommand,
  type UpdateWalkthroughAnchorCommand,
  type UpdateWalkthroughAnchorMissingStateCommand,
  type WalkthroughAnchorAiProvenance,
  type WalkthroughAnchorBulkAction,
  type WalkthroughAnchorCatalogSnapshotEntry,
  type WalkthroughAnchorModuleCoverage,
  type WalkthroughAnchorModuleCoverageEntry,
  type WalkthroughAnchorRegistryListPage,
  type WalkthroughAnchorRegistryListQuery,
  type WalkthroughAnchorRegistryRecord,
  type WalkthroughAnchorRegistryValidationError,
  type WalkthroughAnchorReviewStatus,
  type WalkthroughAnchorSourceKind,
  type WalkthroughAnchorSourceLocation,
  type WalkthroughAnchorSyncCommand,
  type WalkthroughAnchorSyncPersistenceSummary,
  type WalkthroughAnchorSyncResult,
  WALKTHROUGH_ANCHOR_BULK_ACTIONS,
} from '../../shared/types/walkthroughAnchorRegistry';
import {
  applyValidatedSmartTagSuggestions,
  type WalkthroughAnchorSmartTagMergeProvenanceBase,
  type WalkthroughAnchorSmartTaggingResult,
} from '../../shared/types/walkthroughAnchorSmartTagging';
import {
  syncExtractWalkthroughAnchors,
  type WalkthroughAnchorDiscovery,
  type WalkthroughAnchorSyncExtractionResult,
  type SyncExtractWalkthroughAnchorsInput,
} from './walkthroughAnchorSyncExtraction';
import { listRuntimeCatalogAnchors } from './walkthroughAnchorCatalogResolution';
import {
  materializeApexWalkthroughAnchorSyncCheckout,
  resolveWalkthroughAnchorSyncProvider,
} from './walkthroughAnchorSyncRepoService';
import {
  humanizeWalkthroughTestId,
  isPlausibleWalkthroughTestId,
  needsAiSmartTagging,
  needsSyncHeuristicEnrichment,
  SYNC_HEURISTIC_MODEL,
} from './walkthroughAnchorSyncHeuristics';
import { isCoachableWalkthroughDiscovery } from './walkthroughAnchorCoachableFilter';
import {
  listApplicableWalkthroughPageModules,
  listWalkthroughPageEntryComponents,
} from './walkthroughPageModuleScope';
import { WALKTHROUGH_REGISTRY_PLACEMENTS } from '../../shared/walkthroughAnchors';

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

type Actor = { id: string };
type DbExecutor = Pick<typeof db, 'query' | 'insert' | 'update'>;

type RegistryRow = typeof walkthroughAnchorRegistry.$inferSelect;

function nowIso(): string {
  return new Date().toISOString();
}

function mapRow(row: RegistryRow): WalkthroughAnchorRegistryRecord {
  return {
    id: row.id,
    anchorKey: row.anchorKey,
    testId: row.testId,
    label: row.label,
    suggestedRoute: row.suggestedRoute,
    approvedRoute: row.approvedRoute,
    allowedPlacements: row.allowedPlacements,
    smartTags: row.smartTags,
    sourceKind: row.sourceKind,
    sourceLocations: row.sourceLocations,
    sourceHash: row.sourceHash,
    reviewStatus: row.reviewStatus,
    isActive: row.isActive,
    lastSeenAt: row.lastSeenAt,
    missingSince: row.missingSince,
    deletedAt: row.deletedAt,
    aiProvenance: row.aiProvenance,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

function throwValidation(
  errors: WalkthroughAnchorRegistryValidationError[]
): never {
  const active = errors.find((e) => e.code === 'ACTIVE_REQUIRES_APPROVED');
  if (active && errors.every((e) => e.code === 'ACTIVE_REQUIRES_APPROVED')) {
    throw new WalkthroughAnchorRegistryError(
      'ACTIVE_REQUIRES_APPROVED',
      active.message,
      errors
    );
  }
  throw new WalkthroughAnchorRegistryError(
    'VALIDATION_ERROR',
    errors[0]?.message ?? 'Invalid anchor registry payload',
    errors
  );
}

function assertValidCandidate(
  candidate: Parameters<typeof validateAnchorRegistryCandidate>[0]
): void {
  const errors = validateAnchorRegistryCandidate(candidate);
  if (errors.length > 0) throwValidation(errors);
}

function assertActiveApproved(
  reviewStatus: WalkthroughAnchorReviewStatus,
  isActive: boolean
): void {
  if (isActive && reviewStatus !== 'approved') {
    throw new WalkthroughAnchorRegistryError(
      'ACTIVE_REQUIRES_APPROVED',
      'Only approved anchors may be active',
      [
        {
          field: 'isActive',
          code: 'ACTIVE_REQUIRES_APPROVED',
          message: 'Only approved anchors may be active',
        },
      ]
    );
  }
}

function asStatusList(
  value:
    | WalkthroughAnchorReviewStatus
    | WalkthroughAnchorReviewStatus[]
    | undefined
): WalkthroughAnchorReviewStatus[] | null {
  if (value == null) return null;
  return Array.isArray(value) ? value : [value];
}

function asSourceKindList(
  value: WalkthroughAnchorSourceKind | WalkthroughAnchorSourceKind[] | undefined
): WalkthroughAnchorSourceKind[] | null {
  if (value == null) return null;
  return Array.isArray(value) ? value : [value];
}

function buildListWhere(
  query: WalkthroughAnchorRegistryListQuery
): SQL | undefined {
  const clauses: SQL[] = [];

  if (!query.includeDeleted) {
    clauses.push(isNull(walkthroughAnchorRegistry.deletedAt));
  }

  const statuses = asStatusList(query.reviewStatus);
  if (statuses?.length) {
    clauses.push(inArray(walkthroughAnchorRegistry.reviewStatus, statuses));
  }

  if (query.isActive !== undefined) {
    clauses.push(eq(walkthroughAnchorRegistry.isActive, query.isActive));
  }

  const kinds = asSourceKindList(query.sourceKind);
  if (kinds?.length) {
    clauses.push(inArray(walkthroughAnchorRegistry.sourceKind, kinds));
  }

  if (query.approvedRoute) {
    clauses.push(
      eq(walkthroughAnchorRegistry.approvedRoute, query.approvedRoute)
    );
  }

  if (query.missingOnly) {
    clauses.push(isNotNull(walkthroughAnchorRegistry.missingSince));
  }

  if (query.smartTags?.length) {
    const tags = normalizeSmartTags(query.smartTags);
    if (tags.length) {
      clauses.push(
        sql`${walkthroughAnchorRegistry.smartTags} @> ${JSON.stringify(tags)}::jsonb`
      );
    }
  }

  const search = query.search?.trim();
  if (search) {
    const pattern = `%${search}%`;
    clauses.push(
      or(
        ilike(walkthroughAnchorRegistry.anchorKey, pattern),
        ilike(walkthroughAnchorRegistry.testId, pattern),
        ilike(walkthroughAnchorRegistry.label, pattern)
      )!
    );
  }

  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return and(...clauses);
}

function computeCounts(
  rows: RegistryRow[]
): WalkthroughAnchorRegistryListPage['counts'] {
  let pending = 0;
  let approved = 0;
  let rejected = 0;
  let active = 0;
  let missing = 0;
  for (const row of rows) {
    if (row.reviewStatus === 'pending') pending += 1;
    else if (row.reviewStatus === 'approved') approved += 1;
    else if (row.reviewStatus === 'rejected') rejected += 1;
    if (row.isActive) active += 1;
    if (row.missingSince != null) missing += 1;
  }
  return { total: rows.length, pending, approved, rejected, active, missing };
}

function encodeCursor(row: RegistryRow): string {
  return `${row.updatedAt}|${row.id}`;
}

function decodeCursor(cursor: string): { updatedAt: string; id: string } {
  const sep = cursor.indexOf('|');
  if (sep <= 0 || sep === cursor.length - 1) {
    throw new WalkthroughAnchorRegistryError(
      'VALIDATION_ERROR',
      'cursor must be an opaque server cursor'
    );
  }
  return { updatedAt: cursor.slice(0, sep), id: cursor.slice(sep + 1) };
}

async function findLiveByKeyOrTestId(
  executor: DbExecutor,
  anchorKey: string,
  testId: string,
  excludeId?: string
): Promise<RegistryRow | null> {
  const rows = await executor.query.walkthroughAnchorRegistry.findMany({
    where: and(
      isNull(walkthroughAnchorRegistry.deletedAt),
      or(
        eq(walkthroughAnchorRegistry.anchorKey, anchorKey),
        eq(walkthroughAnchorRegistry.testId, testId)
      )
    ),
    limit: 8,
  });
  const hit = rows.find((r) => r.id !== excludeId) ?? null;
  return hit;
}

async function requireLiveRow(
  executor: DbExecutor,
  id: string
): Promise<RegistryRow> {
  const row = await executor.query.walkthroughAnchorRegistry.findFirst({
    where: and(
      eq(walkthroughAnchorRegistry.id, id),
      isNull(walkthroughAnchorRegistry.deletedAt)
    ),
  });
  if (!row) {
    throw new WalkthroughAnchorRegistryError(
      'NOT_FOUND',
      `Anchor registry record not found: ${id}`
    );
  }
  return row;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function listAnchors(
  query: WalkthroughAnchorRegistryListQuery = {}
): Promise<WalkthroughAnchorRegistryListPage> {
  const limit = Math.min(
    Math.max(query.limit ?? LIST_DEFAULT_LIMIT, 1),
    LIST_MAX_LIMIT
  );
  const where = buildListWhere(query);

  const rows = await db.query.walkthroughAnchorRegistry.findMany({
    where,
    orderBy: [
      desc(walkthroughAnchorRegistry.updatedAt),
      desc(walkthroughAnchorRegistry.id),
    ],
  });

  const counts = computeCounts(rows);

  let filtered = rows;
  if (query.cursor) {
    const { updatedAt, id } = decodeCursor(query.cursor);
    filtered = rows.filter(
      (r) => r.updatedAt < updatedAt || (r.updatedAt === updatedAt && r.id < id)
    );
  }

  const page = filtered.slice(0, limit);
  const nextCursor =
    filtered.length > limit && page.length > 0
      ? encodeCursor(page[page.length - 1])
      : null;

  return {
    items: page.map(mapRow),
    nextCursor,
    counts,
  };
}

/**
 * High-level coverage across the user-facing module scope used by Sync.
 * A module is covered when it has at least one approved, active, present anchor
 * assigned to one of the module's authoring routes.
 */
export async function getModuleCoverage(): Promise<WalkthroughAnchorModuleCoverage> {
  const [modules, rows] = await Promise.all([
    listApplicableWalkthroughPageModules(),
    db.query.walkthroughAnchorRegistry.findMany({
      where: and(
        eq(walkthroughAnchorRegistry.reviewStatus, 'approved'),
        eq(walkthroughAnchorRegistry.isActive, true),
        isNull(walkthroughAnchorRegistry.deletedAt),
        isNull(walkthroughAnchorRegistry.missingSince),
        isNotNull(walkthroughAnchorRegistry.lastSeenAt)
      ),
    }),
  ]);

  const routeCounts = new Map<string, number>();
  for (const row of rows) {
    const route = row.approvedRoute ?? row.suggestedRoute;
    if (!route) continue;
    routeCounts.set(route, (routeCounts.get(route) ?? 0) + 1);
  }

  const entries: WalkthroughAnchorModuleCoverageEntry[] = modules.map((module) => {
    const routes = [...new Set(module.pageEntries.map((entry) => entry.suggestedRoute))];
    const anchorCount = routes.reduce(
      (total, route) => total + (routeCounts.get(route) ?? 0),
      0
    );
    return {
      key: module.key,
      label: module.label,
      anchorCount,
      routes,
    };
  });

  const coveredModules = entries.filter((entry) => entry.anchorCount > 0);
  const uncoveredModules = entries.filter((entry) => entry.anchorCount === 0);

  return {
    totalModules: entries.length,
    coveredCount: coveredModules.length,
    uncoveredCount: uncoveredModules.length,
    coveredModules,
    uncoveredModules,
  };
}

export async function getAnchorById(
  id: string,
  options: { includeDeleted?: boolean } = {}
): Promise<WalkthroughAnchorRegistryRecord | null> {
  const row = await db.query.walkthroughAnchorRegistry.findFirst({
    where: options.includeDeleted
      ? eq(walkthroughAnchorRegistry.id, id)
      : and(
          eq(walkthroughAnchorRegistry.id, id),
          isNull(walkthroughAnchorRegistry.deletedAt)
        ),
  });
  return row ? mapRow(row) : null;
}

export async function getAnchorByKey(
  anchorKey: string,
  options: { includeDeleted?: boolean } = {}
): Promise<WalkthroughAnchorRegistryRecord | null> {
  const row = await db.query.walkthroughAnchorRegistry.findFirst({
    where: options.includeDeleted
      ? eq(walkthroughAnchorRegistry.anchorKey, anchorKey)
      : and(
          eq(walkthroughAnchorRegistry.anchorKey, anchorKey),
          isNull(walkthroughAnchorRegistry.deletedAt)
        ),
  });
  return row ? mapRow(row) : null;
}

export async function getAnchorByTestId(
  testId: string,
  options: { includeDeleted?: boolean } = {}
): Promise<WalkthroughAnchorRegistryRecord | null> {
  const row = await db.query.walkthroughAnchorRegistry.findFirst({
    where: options.includeDeleted
      ? eq(walkthroughAnchorRegistry.testId, testId)
      : and(
          eq(walkthroughAnchorRegistry.testId, testId),
          isNull(walkthroughAnchorRegistry.deletedAt)
        ),
  });
  return row ? mapRow(row) : null;
}

/**
 * Full catalog snapshot for playback enrichment / fallback classification.
 * Includes soft-deleted rows so `deleted` fallback reasons resolve correctly.
 */
export async function listCatalogRecordsForResolution(): Promise<
  WalkthroughAnchorRegistryRecord[]
> {
  const items: WalkthroughAnchorRegistryRecord[] = [];
  let cursor: string | null = null;
  do {
    const page = await listAnchors({
      includeDeleted: true,
      limit: LIST_MAX_LIMIT,
      cursor,
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

/**
 * Approved+active authoring / AI allow-list mapped to registry entry shape.
 */
export async function listAuthoringAnchorEntries(): Promise<
  WalkthroughAnchorRegistryEntry[]
> {
  const items: WalkthroughAnchorRegistryRecord[] = [];
  let cursor: string | null = null;
  do {
    const page = await listAnchors({
      reviewStatus: 'approved',
      isActive: true,
      includeDeleted: false,
      limit: LIST_MAX_LIMIT,
      cursor,
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);

  return listRuntimeCatalogAnchors(items).map(toAuthoringAnchorEntry);
}

// ── Writes ────────────────────────────────────────────────────────────────────

function resolveCandidateAnchorKey(
  testId: string,
  suggestedAnchorKey?: string | null
): string {
  const suggested = suggestedAnchorKey?.trim();
  return suggested || testId.trim();
}

/** Live catalog snapshot for scan diffs (soft-deleted excluded). */
export async function listCatalogSnapshotForSync(): Promise<
  WalkthroughAnchorCatalogSnapshotEntry[]
> {
  const rows = await db.query.walkthroughAnchorRegistry.findMany({
    where: isNull(walkthroughAnchorRegistry.deletedAt),
  });
  return rows.map((row) => ({
    testId: row.testId,
    anchorKey: row.anchorKey,
    reviewStatus: row.reviewStatus,
    isActive: row.isActive,
    deletedAt: row.deletedAt,
  }));
}

/**
 * Insert a scanner-discovered candidate as pending + inactive.
 * Prefer this over createManualAnchor (which defaults to approved/manual).
 */
export async function createFromCandidate(
  input: CreateWalkthroughAnchorFromCandidateCommand,
  actor: Actor,
  executor: DbExecutor = db
): Promise<WalkthroughAnchorRegistryRecord> {
  const testId = input.testId.trim();
  const anchorKey = resolveCandidateAnchorKey(testId, input.suggestedAnchorKey);
  const sourceLocations: WalkthroughAnchorSourceLocation[] = Array.isArray(
    input.sourceLocations
  )
    ? [...input.sourceLocations]
    : [];
  // Scanner-owned fields only. Leave tags/route/rationale empty until AI (or Super Admin) fills them.
  const label = (
    input.label?.trim() || humanizeWalkthroughTestId(testId)
  ).trim();
  const allowedPlacements = (
    input.allowedPlacements?.length
      ? [...input.allowedPlacements]
      : [...WALKTHROUGH_REGISTRY_PLACEMENTS]
  ) as WalkthroughRegistryPlacement[];
  const suggestedRoute = input.suggestedRoute ?? null;
  const smartTags: string[] = [];
  const reviewStatus: WalkthroughAnchorReviewStatus = 'pending';
  const isActive = false;

  assertValidCandidate({
    anchorKey,
    testId,
    label,
    suggestedRoute,
    approvedRoute: null,
    allowedPlacements,
    smartTags,
    sourceKind: input.sourceKind,
    sourceLocations,
    reviewStatus,
    isActive,
  });

  const duplicate = await findLiveByKeyOrTestId(executor, anchorKey, testId);
  if (duplicate) {
    throw new WalkthroughAnchorRegistryError(
      'DUPLICATE',
      duplicate.anchorKey === anchorKey
        ? `anchorKey already exists: ${anchorKey}`
        : `testId already exists: ${testId}`
    );
  }

  const ts = nowIso();
  const [row] = await executor
    .insert(walkthroughAnchorRegistry)
    .values({
      anchorKey,
      testId,
      label,
      suggestedRoute,
      approvedRoute: null,
      allowedPlacements,
      smartTags,
      sourceKind: input.sourceKind,
      sourceLocations,
      sourceHash: input.sourceHash,
      reviewStatus,
      isActive,
      lastSeenAt: ts,
      missingSince: null,
      aiProvenance: null,
      createdBy: actor.id,
      updatedBy: actor.id,
      createdAt: ts,
      updatedAt: ts,
    })
    .returning();

  return mapRow(row);
}

/** Refresh a live row from a scan hit: lastSeenAt, source fields, clear missingSince.
 * Optionally resets empty pending rows to scanner baseline (label + placements),
 * and clears leftover heuristic fake tags/provenance on re-sync.
 */
export async function refreshFromSyncDiscovery(
  id: string,
  discovery: Pick<
    WalkthroughAnchorDiscovery,
    'sourceLocations' | 'sourceHash' | 'testId' | 'sourceKind'
  >,
  actor: Actor,
  executor: DbExecutor = db,
  options?: { applyHeuristicsIfEmpty?: boolean }
): Promise<WalkthroughAnchorRegistryRecord> {
  const existing = await requireLiveRow(executor, id);
  const ts = nowIso();
  const patch: Record<string, unknown> = {
    lastSeenAt: ts,
    missingSince: null,
    sourceLocations: [...discovery.sourceLocations],
    sourceHash: discovery.sourceHash,
    updatedBy: actor.id,
    updatedAt: ts,
  };

  const needsEnrichment =
    options?.applyHeuristicsIfEmpty === true &&
    needsSyncHeuristicEnrichment({
      reviewStatus: existing.reviewStatus,
      smartTags: existing.smartTags,
      aiProvenance: existing.aiProvenance,
    });

  if (needsEnrichment) {
    // Scanner-only baseline: humanized label + full placements; AI fields stay empty.
    patch.label =
      existing.label?.trim() ||
      humanizeWalkthroughTestId(discovery.testId || existing.testId);
    patch.allowedPlacements = [...WALKTHROUGH_REGISTRY_PLACEMENTS];
    patch.smartTags = [];
    patch.aiProvenance = null;
  } else if (
    existing.reviewStatus === 'pending' &&
    existing.aiProvenance?.model === SYNC_HEURISTIC_MODEL
  ) {
    // Clear prior heuristic "fake" metadata on re-sync; AI fields empty until Track B.
    patch.allowedPlacements = [...WALKTHROUGH_REGISTRY_PLACEMENTS];
    patch.smartTags = [];
    patch.aiProvenance = null;
  }

  const [row] = await executor
    .update(walkthroughAnchorRegistry)
    .set(patch)
    .where(eq(walkthroughAnchorRegistry.id, id))
    .returning();
  return mapRow(row);
}

function shouldStampMissing(
  entry: WalkthroughAnchorCatalogSnapshotEntry
): boolean {
  if (entry.deletedAt != null) return false;
  return entry.reviewStatus === 'approved' || entry.reviewStatus === 'rejected';
}

/**
 * Persist an extraction diff:
 * - insert newCandidates as pending/inactive (scanner baseline only)
 * - refresh existingMatches (lastSeenAt / source / clear missingSince)
 * - reset empty / heuristic-only pending metadata to scanner baseline
 * - include coachable pending discoveries in reviewCandidates (re-sync resurfaces
 *   rows after the modal was closed without approve/reject)
 * - stamp missingSince for approved/rejected disappearances (not soft-deleted; not pending)
 */
export async function persistSyncExtractionResult(
  extraction: WalkthroughAnchorSyncExtractionResult,
  actor: Actor
): Promise<WalkthroughAnchorSyncPersistenceSummary> {
  return db.transaction(async (tx) => {
    const liveRows = await tx.query.walkthroughAnchorRegistry.findMany({
      where: isNull(walkthroughAnchorRegistry.deletedAt),
    });
    const byTestId = new Map(liveRows.map((row) => [row.testId, row]));

    const created: WalkthroughAnchorRegistryRecord[] = [];
    const refreshed: WalkthroughAnchorRegistryRecord[] = [];
    const markedMissing: WalkthroughAnchorRegistryRecord[] = [];
    const reviewCandidates: WalkthroughAnchorRegistryRecord[] = [];
    const smartTaggingIds: string[] = [];

    const queuePendingForReview = (
      row: WalkthroughAnchorRegistryRecord,
      options?: { queueSmartTagging?: boolean }
    ) => {
      if (row.reviewStatus !== 'pending') return;
      // Soft-hide legacy noise (platform-admin / walkthrough chrome / nitty IDs).
      if (
        !isCoachableWalkthroughDiscovery({
          testId: row.testId,
          sourceKind:
            row.sourceKind === 'explicit' ? 'explicit' : 'data_testid',
          sourceLocations: row.sourceLocations,
        })
      ) {
        return;
      }
      reviewCandidates.push(row);
      if (options?.queueSmartTagging) {
        smartTaggingIds.push(row.id);
      }
    };

    for (const candidate of extraction.newCandidates) {
      if (!isPlausibleWalkthroughTestId(candidate.testId)) {
        continue;
      }
      // Race / re-entry: if the testId appeared between extract and persist, refresh instead.
      const existing = byTestId.get(candidate.testId);
      if (existing) {
        const needsEnrichment = needsSyncHeuristicEnrichment({
          reviewStatus: existing.reviewStatus,
          smartTags: existing.smartTags,
          aiProvenance: existing.aiProvenance,
        });
        const row = await refreshFromSyncDiscovery(
          existing.id,
          candidate,
          actor,
          tx,
          { applyHeuristicsIfEmpty: needsEnrichment }
        );
        refreshed.push(row);
        queuePendingForReview(row, {
          queueSmartTagging: needsAiSmartTagging(row),
        });
        continue;
      }
      const row = await createFromCandidate(
        {
          testId: candidate.testId,
          suggestedAnchorKey: candidate.suggestedAnchorKey,
          sourceKind: candidate.sourceKind,
          sourceLocations: candidate.sourceLocations,
          sourceHash: candidate.sourceHash,
        },
        actor,
        tx
      );
      created.push(row);
      queuePendingForReview(row, { queueSmartTagging: true });
      byTestId.set(row.testId, row as unknown as RegistryRow);
    }

    for (const match of extraction.existingMatches) {
      if (!isPlausibleWalkthroughTestId(match.testId)) {
        continue;
      }
      const existing = byTestId.get(match.testId);
      if (!existing) continue;
      const needsEnrichment = needsSyncHeuristicEnrichment({
        reviewStatus: existing.reviewStatus,
        smartTags: existing.smartTags,
        aiProvenance: existing.aiProvenance,
      });
      const row = await refreshFromSyncDiscovery(
        existing.id,
        match,
        actor,
        tx,
        { applyHeuristicsIfEmpty: needsEnrichment }
      );
      refreshed.push(row);
      // Always resurface pending matches in Sync review (even when already tagged).
      queuePendingForReview(row, {
        queueSmartTagging: needsAiSmartTagging(row),
      });
    }

    const ts = nowIso();
    for (const warning of extraction.missingWarnings) {
      if (!shouldStampMissing(warning.catalogEntry)) continue;
      const existing = byTestId.get(warning.testId);
      if (!existing || existing.deletedAt != null) continue;
      // Preserve first-seen missing timestamp.
      if (existing.missingSince != null) {
        markedMissing.push(mapRow(existing));
        continue;
      }
      const [row] = await tx
        .update(walkthroughAnchorRegistry)
        .set({
          missingSince: ts,
          updatedBy: actor.id,
          updatedAt: ts,
        })
        .where(eq(walkthroughAnchorRegistry.id, existing.id))
        .returning();
      markedMissing.push(mapRow(row));
    }

    // Deduplicate review/smart-tagging lists by id (stable first-seen order).
    const seenReview = new Set<string>();
    const uniqueReview = reviewCandidates.filter((row) => {
      if (seenReview.has(row.id)) return false;
      seenReview.add(row.id);
      return true;
    });
    const seenSmart = new Set<string>();
    const uniqueSmartIds = smartTaggingIds.filter((id) => {
      if (seenSmart.has(id)) return false;
      seenSmart.add(id);
      return true;
    });

    return {
      created,
      refreshed,
      markedMissing,
      reviewCandidates: uniqueReview,
      newCandidateIdsForSmartTagging: uniqueSmartIds,
    };
  });
}

/**
 * Super Admin sync entry: extract repository anchors, persist BEFORE AI tagging.
 *
 * Provider resolution (when command.provider omitted):
 * - production → Apex project skillProvider (github|ado) + repo-cache materialize
 * - otherwise → local cwd (includes uncommitted WIP)
 *
 * Track B (AI smart-tagging) should consume
 * `result.persistence.newCandidateIdsForSmartTagging` only — do not invoke
 * startSmartTagging from this path.
 */
export async function syncExtractAndPersistAnchors(
  command: WalkthroughAnchorSyncCommand,
  actor: Actor
): Promise<WalkthroughAnchorSyncResult> {
  const provider = await resolveWalkthroughAnchorSyncProvider(command.provider);
  const catalogSnapshot = await listCatalogSnapshotForSync();
  const applicableModules = await listApplicableWalkthroughPageModules();

  let repositoryRoot = command.repositoryRoot;
  let branch: string | null = null;
  let committedTruth = false;

  if (provider === 'github' || provider === 'ado') {
    committedTruth = true;
    if (!command.files) {
      const checkout = await materializeApexWalkthroughAnchorSyncCheckout(
        provider
      );
      repositoryRoot = checkout.repositoryRoot;
      branch = checkout.branch;
    }
  }

  const extractInput: SyncExtractWalkthroughAnchorsInput = {
    provider,
    catalogSnapshot,
    pageEntryComponents: listWalkthroughPageEntryComponents(applicableModules),
    repositoryRoot,
    clientRelativeRoot: command.clientRelativeRoot,
    files: command.files,
    branch,
    committedTruth,
  };

  const extraction = await syncExtractWalkthroughAnchors(extractInput);

  // Persist all discoveries before any AI enrichment (Track B owns tagging).
  const persistence = await persistSyncExtractionResult(extraction, actor);

  return {
    discoveries: extraction.discoveries,
    newCandidates: extraction.newCandidates,
    existingMatches: extraction.existingMatches,
    missingWarnings: extraction.missingWarnings,
    duplicates: extraction.duplicates,
    unsupportedDynamicPatterns: extraction.unsupportedDynamicPatterns,
    diagnostics: extraction.diagnostics,
    persistence,
  };
}

export async function createManualAnchor(
  input: CreateManualWalkthroughAnchorCommand,
  actor: Actor
): Promise<WalkthroughAnchorRegistryRecord> {
  const reviewStatus: WalkthroughAnchorReviewStatus =
    input.reviewStatus ?? 'approved';
  const isActive = input.isActive ?? reviewStatus === 'approved';
  const smartTags = normalizeSmartTags(input.smartTags ?? []);
  const sourceLocations: WalkthroughAnchorSourceLocation[] = Array.isArray(
    input.sourceLocations
  )
    ? [...input.sourceLocations]
    : [];
  const allowedPlacements = (input.allowedPlacements ??
    []) as WalkthroughRegistryPlacement[];

  assertValidCandidate({
    anchorKey: input.anchorKey,
    testId: input.testId,
    label: input.label,
    suggestedRoute: input.suggestedRoute ?? null,
    approvedRoute: input.approvedRoute ?? null,
    allowedPlacements,
    smartTags,
    sourceKind: 'manual',
    sourceLocations,
    reviewStatus,
    isActive,
  });
  assertActiveApproved(reviewStatus, isActive);

  if (!isWalkthroughAnchorReviewStatus(reviewStatus)) {
    throw new WalkthroughAnchorRegistryError(
      'VALIDATION_ERROR',
      'Invalid reviewStatus'
    );
  }

  const anchorKey = input.anchorKey.trim();
  const testId = input.testId.trim();
  const label = input.label.trim();

  const duplicate = await findLiveByKeyOrTestId(db, anchorKey, testId);
  if (duplicate) {
    throw new WalkthroughAnchorRegistryError(
      'DUPLICATE',
      duplicate.anchorKey === anchorKey
        ? `anchorKey already exists: ${anchorKey}`
        : `testId already exists: ${testId}`
    );
  }

  const ts = nowIso();
  const [row] = await db
    .insert(walkthroughAnchorRegistry)
    .values({
      anchorKey,
      testId,
      label,
      suggestedRoute: input.suggestedRoute ?? null,
      approvedRoute: input.approvedRoute ?? null,
      allowedPlacements,
      smartTags,
      sourceKind: 'manual',
      sourceLocations,
      sourceHash: null,
      reviewStatus,
      isActive,
      createdBy: actor.id,
      updatedBy: actor.id,
      createdAt: ts,
      updatedAt: ts,
    })
    .returning();

  return mapRow(row);
}

export async function updateAnchor(
  id: string,
  patch: UpdateWalkthroughAnchorCommand,
  actor: Actor
): Promise<WalkthroughAnchorRegistryRecord> {
  return db.transaction(async (tx) => {
    const existing = await requireLiveRow(tx, id);

    const smartTags =
      patch.smartTags !== undefined
        ? normalizeSmartTags(patch.smartTags)
        : existing.smartTags;
    const reviewStatus = patch.reviewStatus ?? existing.reviewStatus;
    const isActive = patch.isActive ?? existing.isActive;
    const label =
      patch.label !== undefined ? patch.label.trim() : existing.label;
    const suggestedRoute =
      patch.suggestedRoute !== undefined
        ? patch.suggestedRoute
        : existing.suggestedRoute;
    const approvedRoute =
      patch.approvedRoute !== undefined
        ? patch.approvedRoute
        : existing.approvedRoute;
    const allowedPlacements =
      patch.allowedPlacements !== undefined
        ? ([...patch.allowedPlacements] as WalkthroughRegistryPlacement[])
        : existing.allowedPlacements;
    const sourceLocations =
      patch.sourceLocations !== undefined
        ? [...patch.sourceLocations]
        : existing.sourceLocations;

    assertValidCandidate({
      anchorKey: existing.anchorKey,
      testId: existing.testId,
      label,
      suggestedRoute,
      approvedRoute,
      allowedPlacements,
      smartTags,
      sourceKind: existing.sourceKind,
      sourceLocations,
      reviewStatus,
      isActive,
    });
    assertActiveApproved(reviewStatus, isActive);

    // Rejecting forces deactivation even if patch omitted isActive.
    const nextActive = reviewStatus === 'rejected' ? false : isActive;

    const [row] = await tx
      .update(walkthroughAnchorRegistry)
      .set({
        label,
        suggestedRoute,
        approvedRoute,
        allowedPlacements,
        smartTags,
        sourceLocations,
        reviewStatus,
        isActive: nextActive,
        updatedBy: actor.id,
        updatedAt: nowIso(),
      })
      .where(eq(walkthroughAnchorRegistry.id, id))
      .returning();

    return mapRow(row);
  });
}

function applyBulkAction(
  row: RegistryRow,
  action: WalkthroughAnchorBulkAction
): Pick<RegistryRow, 'reviewStatus' | 'isActive'> {
  switch (action) {
    case 'approve':
      return { reviewStatus: 'approved', isActive: row.isActive };
    case 'reject':
      return { reviewStatus: 'rejected', isActive: false };
    case 'activate':
      assertActiveApproved(row.reviewStatus, true);
      return { reviewStatus: row.reviewStatus, isActive: true };
    case 'deactivate':
      return { reviewStatus: row.reviewStatus, isActive: false };
    default:
      throw new WalkthroughAnchorRegistryError(
        'VALIDATION_ERROR',
        `Unknown bulk action: ${String(action)}`
      );
  }
}

export async function bulkUpdateAnchors(
  command: BulkWalkthroughAnchorCommand,
  actor: Actor
): Promise<WalkthroughAnchorRegistryRecord[]> {
  if (!Array.isArray(command.ids) || command.ids.length === 0) {
    throw new WalkthroughAnchorRegistryError(
      'VALIDATION_ERROR',
      'ids must be a non-empty array'
    );
  }
  if (
    !(WALKTHROUGH_ANCHOR_BULK_ACTIONS as readonly string[]).includes(
      command.action
    )
  ) {
    throw new WalkthroughAnchorRegistryError(
      'VALIDATION_ERROR',
      'Invalid bulk action'
    );
  }

  const uniqueIds = [
    ...new Set(command.ids.filter((id) => typeof id === 'string' && id.trim())),
  ];
  if (uniqueIds.length === 0) {
    throw new WalkthroughAnchorRegistryError(
      'VALIDATION_ERROR',
      'ids must be a non-empty array'
    );
  }

  return db.transaction(async (tx) => {
    const results: WalkthroughAnchorRegistryRecord[] = [];
    const ts = nowIso();

    for (const id of uniqueIds) {
      const existing = await requireLiveRow(tx, id);
      const next = applyBulkAction(existing, command.action);
      const [row] = await tx
        .update(walkthroughAnchorRegistry)
        .set({
          reviewStatus: next.reviewStatus,
          isActive: next.isActive,
          updatedBy: actor.id,
          updatedAt: ts,
        })
        .where(eq(walkthroughAnchorRegistry.id, id))
        .returning();
      results.push(mapRow(row));
    }

    return results;
  });
}

export async function updateMissingState(
  command: UpdateWalkthroughAnchorMissingStateCommand,
  actor: Actor
): Promise<WalkthroughAnchorRegistryRecord[]> {
  if (!Array.isArray(command.updates) || command.updates.length === 0) {
    throw new WalkthroughAnchorRegistryError(
      'VALIDATION_ERROR',
      'updates must be a non-empty array'
    );
  }

  return db.transaction(async (tx) => {
    const results: WalkthroughAnchorRegistryRecord[] = [];
    const ts = nowIso();

    for (const update of command.updates) {
      if (!update?.id || typeof update.id !== 'string') {
        throw new WalkthroughAnchorRegistryError(
          'VALIDATION_ERROR',
          'Each update requires an id'
        );
      }
      if (update.missingSince != null) {
        if (
          typeof update.missingSince !== 'string' ||
          Number.isNaN(Date.parse(update.missingSince))
        ) {
          throw new WalkthroughAnchorRegistryError(
            'VALIDATION_ERROR',
            'missingSince must be an ISO timestamp or null'
          );
        }
      }

      await requireLiveRow(tx, update.id);
      const missingSince =
        update.missingSince == null
          ? null
          : new Date(update.missingSince).toISOString();

      const [row] = await tx
        .update(walkthroughAnchorRegistry)
        .set({
          missingSince,
          updatedBy: actor.id,
          updatedAt: ts,
        })
        .where(eq(walkthroughAnchorRegistry.id, update.id))
        .returning();
      results.push(mapRow(row));
    }

    return results;
  });
}

export async function softDeleteAnchor(
  id: string,
  actor: Actor
): Promise<WalkthroughAnchorRegistryRecord> {
  const existing = await requireLiveRow(db, id);
  const ts = nowIso();
  const [row] = await db
    .update(walkthroughAnchorRegistry)
    .set({
      deletedAt: ts,
      isActive: false,
      updatedBy: actor.id,
      updatedAt: ts,
    })
    .where(eq(walkthroughAnchorRegistry.id, existing.id))
    .returning();
  return mapRow(row);
}

/**
 * Persist validated smart-tag suggestions onto pending catalog rows only.
 * Matching is by testId; approved/rejected rows are never mutated.
 * When a suggested anchorKey would collide with another live row, the existing key is kept.
 */
export async function applySmartTagSuggestionsToPending(input: {
  testIds: readonly string[];
  result: WalkthroughAnchorSmartTaggingResult;
  provenanceBase: WalkthroughAnchorSmartTagMergeProvenanceBase;
  actor: Actor;
}): Promise<WalkthroughAnchorRegistryRecord[]> {
  const uniqueTestIds = [
    ...new Set(
      input.testIds
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean)
    ),
  ];
  if (uniqueTestIds.length === 0) {
    return [];
  }

  return db.transaction(async (tx) => {
    const liveRows = await tx.query.walkthroughAnchorRegistry.findMany({
      where: and(
        isNull(walkthroughAnchorRegistry.deletedAt),
        inArray(walkthroughAnchorRegistry.testId, uniqueTestIds)
      ),
    });

    const targets = liveRows.map((row) => ({
      id: row.id,
      testId: row.testId,
      anchorKey: row.anchorKey,
      label: row.label,
      suggestedRoute: row.suggestedRoute,
      allowedPlacements: row.allowedPlacements,
      smartTags: row.smartTags,
      reviewStatus: row.reviewStatus,
      aiProvenance: row.aiProvenance,
    }));

    const merged = applyValidatedSmartTagSuggestions(
      targets,
      input.result,
      input.provenanceBase
    );

    const byId = new Map(liveRows.map((row) => [row.id, row]));
    const updated: WalkthroughAnchorRegistryRecord[] = [];
    const ts = nowIso();

    for (const next of merged) {
      const existing = byId.get(next.id);
      if (!existing || existing.reviewStatus !== 'pending') continue;

      const suggestionApplied =
        next.label !== existing.label ||
        next.suggestedRoute !== existing.suggestedRoute ||
        JSON.stringify(next.allowedPlacements) !==
          JSON.stringify(existing.allowedPlacements) ||
        JSON.stringify(next.smartTags) !== JSON.stringify(existing.smartTags) ||
        next.anchorKey !== existing.anchorKey ||
        next.aiProvenance != null;

      if (!suggestionApplied || !next.aiProvenance) continue;

      let nextAnchorKey = next.anchorKey.trim();
      if (nextAnchorKey !== existing.anchorKey) {
        const collision = await findLiveByKeyOrTestId(
          tx,
          nextAnchorKey,
          existing.testId,
          existing.id
        );
        if (collision) {
          nextAnchorKey = existing.anchorKey;
        }
      }

      const smartTags = normalizeSmartTags(next.smartTags);
      const allowedPlacements = [
        ...next.allowedPlacements,
      ] as WalkthroughRegistryPlacement[];
      const label = next.label.trim();
      const suggestedRoute = next.suggestedRoute;
      const aiProvenance: WalkthroughAnchorAiProvenance = {
        ...next.aiProvenance,
      };

      assertValidCandidate({
        anchorKey: nextAnchorKey,
        testId: existing.testId,
        label,
        suggestedRoute,
        approvedRoute: existing.approvedRoute,
        allowedPlacements,
        smartTags,
        sourceKind: existing.sourceKind,
        sourceLocations: existing.sourceLocations,
        reviewStatus: 'pending',
        isActive: false,
      });

      const [row] = await tx
        .update(walkthroughAnchorRegistry)
        .set({
          anchorKey: nextAnchorKey,
          label,
          suggestedRoute,
          allowedPlacements,
          smartTags,
          aiProvenance,
          // Stay pending + inactive until Super Admin review.
          reviewStatus: 'pending',
          isActive: false,
          updatedBy: input.actor.id,
          updatedAt: ts,
        })
        .where(eq(walkthroughAnchorRegistry.id, existing.id))
        .returning();

      updated.push(mapRow(row));
    }

    return updated;
  });
}

/** Type guard helpers exported for route parsing. */
export function parseBulkAction(
  value: unknown
): WalkthroughAnchorBulkAction | null {
  return typeof value === 'string' &&
    (WALKTHROUGH_ANCHOR_BULK_ACTIONS as readonly string[]).includes(value)
    ? (value as WalkthroughAnchorBulkAction)
    : null;
}

export function parseReviewStatusFilter(
  value: unknown
): WalkthroughAnchorReviewStatus | WalkthroughAnchorReviewStatus[] | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'string') {
    if (value.includes(',')) {
      const parts = value
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.every(isWalkthroughAnchorReviewStatus)) return parts;
      return undefined;
    }
    return isWalkthroughAnchorReviewStatus(value) ? value : undefined;
  }
  return undefined;
}

export function parseSourceKindFilter(
  value: unknown
): WalkthroughAnchorSourceKind | WalkthroughAnchorSourceKind[] | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'string') {
    if (value.includes(',')) {
      const parts = value
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.every(isWalkthroughAnchorSourceKind)) return parts;
      return undefined;
    }
    return isWalkthroughAnchorSourceKind(value) ? value : undefined;
  }
  return undefined;
}
