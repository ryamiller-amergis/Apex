/**
 * Walkthrough domain service (FEAT-001 TBI-002).
 * Owns lifecycle, aggregate writes, live audience, eligibility, progress, and reporting.
 */

import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  appGroupMembers,
  appGroups,
  appUsers,
  userProjectAssignments,
  walkthroughAnchorMisses,
  walkthroughProgress,
  walkthroughs,
  walkthroughSteps,
  walkthroughTargetingRules,
} from '../db/schema';
import { getUserGroupIdsForProject } from './featureFlagService';
import { trackEvent } from './telemetry';
import {
  assertAnchorInCatalog,
  type ListAnchorMissesQuery,
  type PublishWalkthroughCommand,
  type RecordAnchorMissRequest,
  type UpdateWalkthroughCommand,
  type UpdateWalkthroughProgressRequest,
  type WalkthroughAcknowledgementReport,
  type WalkthroughAcknowledgementStatusFilter,
  type WalkthroughAcknowledgementUserRow,
  type WalkthroughAnchorMissPage,
  type WalkthroughCatalogPage,
  type WalkthroughCatalogQuery,
  type WalkthroughDefinition,
  type WalkthroughDraftCommand,
  type WalkthroughProgress,
  type WalkthroughReplayPage,
  type WalkthroughStep,
  type WalkthroughStepInput,
  type WalkthroughTargetRule,
  type WalkthroughTargeting,
  type ValidatedWalkthroughDraft,
  canTransitionLifecycle,
  deriveAcknowledged,
  rulesToTargeting,
  targetingToRules,
  validateCreateCommand,
  validateGenerationProvenance,
  validateTargeting,
  validateSteps,
  WalkthroughDomainError,
  assertPersistedProgressStatus,
} from '../../shared/types/walkthrough';
import {
  enrichStepAnchorFromCatalog,
} from './walkthroughAnchorCatalogResolution';
import {
  getAnchorByKey,
  listAuthoringAnchorEntries,
  listCatalogRecordsForResolution,
} from './walkthroughAnchorRegistryService';

const CATALOG_DEFAULT_LIMIT = 50;
const CATALOG_MAX_LIMIT = 50;
const ANCHOR_MISS_DEFAULT_LIMIT = 50;
const ANCHOR_MISS_MAX_LIMIT = 100;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DbWalkthroughRow = typeof walkthroughs.$inferSelect;
type DbStepRow = typeof walkthroughSteps.$inferSelect;
type DbRuleRow = typeof walkthroughTargetingRules.$inferSelect;
type DbProgressRow = typeof walkthroughProgress.$inferSelect;

type DefinitionRow = DbWalkthroughRow & {
  steps: DbStepRow[];
  targetingRules: DbRuleRow[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function dbStepRoute(step: DbStepRow): string | null {
  // Legacy test/data adapters may still expose the Drizzle property as targetRoute.
  return step.route ?? (step as DbStepRow & { targetRoute?: string | null }).targetRoute ?? null;
}

function mapAnchor(step: DbStepRow): WalkthroughStep['anchor'] {
  const route = dbStepRoute(step);
  if (!step.anchorKey || !route || !step.placement) return null;
  return {
    key: step.anchorKey,
    targetRoute: route,
    placement: step.placement,
  };
}

function mapStep(row: DbStepRow): WalkthroughStep {
  return {
    id: row.id,
    walkthroughId: row.walkthroughId,
    ordinal: row.ordinal,
    heading: row.heading,
    bodyMarkdown: row.bodyMarkdown,
    route: dbStepRoute(row),
    imageUrl: row.imageUrl,
    imageAlt: row.imageAlt,
    ctaLabel: row.ctaLabel,
    ctaRoute: row.ctaRoute,
    anchor: mapAnchor(row),
  };
}

function mapRules(rows: DbRuleRow[]): WalkthroughTargetRule[] {
  return rows.map((r) => ({ id: r.id, type: r.type, value: r.value }));
}

function mapDefinition(row: DefinitionRow): WalkthroughDefinition {
  const targetingRules = mapRules(row.targetingRules);
  const steps = [...row.steps].sort((a, b) => a.ordinal - b.ordinal).map(mapStep);
  return {
    id: row.id,
    internalName: row.internalName,
    userTitle: row.userTitle,
    whyItMatters: row.whyItMatters,
    lifecycle: row.lifecycle,
    priority: row.priority,
    isRequired: row.isRequired ?? false,
    revision: row.revision,
    publishedAt: row.publishedAt,
    archivedAt: row.archivedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
    generationProvenance: row.generationProvenance ?? null,
    steps,
    targeting: rulesToTargeting(targetingRules),
    targetingRules,
  };
}

/** Enrich step anchors with catalog testId / centered-fallback signals (Phase 6). */
export function enrichDefinitionAnchorsFromRecords(
  definition: WalkthroughDefinition,
  records: Parameters<typeof enrichStepAnchorFromCatalog>[0],
): WalkthroughDefinition {
  return {
    ...definition,
    steps: definition.steps.map((step) => {
      if (!step.anchor) return step;
      const result = enrichStepAnchorFromCatalog(records, step.anchor);
      if (result.status === 'resolved') {
        return {
          ...step,
          anchor: {
            key: result.enriched.key,
            targetRoute: result.enriched.targetRoute,
            placement: result.enriched.placement as NonNullable<WalkthroughStep['anchor']>['placement'],
            testId: result.enriched.testId,
            openers: result.enriched.openers,
            useCenteredFallback: false,
            catalogFallbackReason: undefined,
          },
        };
      }
      return {
        ...step,
        anchor: {
          ...step.anchor,
          testId: null,
          useCenteredFallback: true,
          catalogFallbackReason: result.reason,
        },
      };
    }),
  };
}

async function mapDefinitionEnriched(row: DefinitionRow): Promise<WalkthroughDefinition> {
  const definition = mapDefinition(row);
  const records = await listCatalogRecordsForResolution();
  return enrichDefinitionAnchorsFromRecords(definition, records);
}

function enrichMappedDefinition(
  row: DefinitionRow,
  records: Parameters<typeof enrichStepAnchorFromCatalog>[0],
): WalkthroughDefinition {
  return enrichDefinitionAnchorsFromRecords(mapDefinition(row), records);
}

async function assertStepsAgainstAuthoringCatalog(
  steps: readonly WalkthroughStepInput[],
): Promise<void> {
  const catalog = await listAuthoringAnchorEntries();
  for (const step of steps) {
    if (!step.anchor) continue;
    assertAnchorInCatalog(step.anchor, catalog);
  }
}

function mapProgress(row: DbProgressRow): WalkthroughProgress {
  const status = assertPersistedProgressStatus(row.status);
  return {
    walkthroughId: row.walkthroughId,
    userId: row.userId,
    revision: row.revision,
    status,
    lastStepId: row.lastStepId,
    seenAt: row.seenAt,
    acknowledgedAt: row.acknowledgedAt,
    updatedAt: row.updatedAt,
    acknowledged: deriveAcknowledged(status),
  };
}

async function loadDefinition(
  id: string,
  executor: typeof db = db,
): Promise<DefinitionRow | null> {
  const row = await executor.query.walkthroughs.findFirst({
    where: eq(walkthroughs.id, id),
    with: {
      steps: { orderBy: [asc(walkthroughSteps.ordinal)] },
      targetingRules: true,
    },
  });
  return (row as DefinitionRow | undefined) ?? null;
}

async function assertGroupBelongsToProject(groupId: string, project: string): Promise<void> {
  const group = await db.query.appGroups.findFirst({
    where: and(eq(appGroups.id, groupId), eq(appGroups.project, project)),
  });
  if (!group) {
    throw new WalkthroughDomainError(
      'INVALID_TARGET',
      'Group target must belong to the selected project',
    );
  }
}

async function validateTargetingAgainstDb(targeting: WalkthroughTargeting): Promise<WalkthroughTargeting> {
  const normalized = validateTargeting(targeting);
  if (normalized.groupId) {
    await assertGroupBelongsToProject(normalized.groupId, normalized.projects[0]);
  }
  return normalized;
}

async function replaceStepsAndRules(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  walkthroughId: string,
  steps: ReturnType<typeof validateSteps>,
  targeting: WalkthroughTargeting,
): Promise<void> {
  await tx.delete(walkthroughSteps).where(eq(walkthroughSteps.walkthroughId, walkthroughId));
  await tx.delete(walkthroughTargetingRules).where(eq(walkthroughTargetingRules.walkthroughId, walkthroughId));

  if (steps.length > 0) {
    await tx.insert(walkthroughSteps).values(
      steps.map((s) => ({
        ...(s.id ? { id: s.id } : {}),
        walkthroughId,
        ordinal: s.ordinal,
        heading: s.heading,
        bodyMarkdown: s.bodyMarkdown,
        route: s.route ?? s.anchor?.targetRoute ?? null,
        imageUrl: s.imageUrl ?? null,
        imageAlt: s.imageAlt ?? null,
        ctaLabel: s.ctaLabel ?? null,
        ctaRoute: s.ctaRoute ?? null,
        anchorKey: s.anchor?.key ?? null,
        placement: s.anchor?.placement ?? null,
      })),
    );
  }

  const rules = targetingToRules(targeting);
  await tx.insert(walkthroughTargetingRules).values(
    rules.map((r) => ({
      walkthroughId,
      type: r.type,
      value: r.value,
    })),
  );
}

function emitLifecycle(
  walkthroughId: string,
  projects: string[],
  transition: string,
  revision: number,
): void {
  trackEvent('walkthrough.lifecycle.changed', {
    walkthroughId,
    project: projects.join(','),
    projectCount: String(projects.length),
    transition,
    revision: String(revision),
  });
}

// ── Admin: catalog ────────────────────────────────────────────────────────────

export async function listCatalog(query: WalkthroughCatalogQuery = {}): Promise<WalkthroughCatalogPage> {
  const limit = Math.min(Math.max(query.limit ?? CATALOG_DEFAULT_LIMIT, 1), CATALOG_MAX_LIMIT);
  const lifecycles = query.lifecycle
    ? Array.isArray(query.lifecycle)
      ? query.lifecycle
      : [query.lifecycle]
    : null;

  const rows = await db.query.walkthroughs.findMany({
    with: {
      steps: { orderBy: [asc(walkthroughSteps.ordinal)] },
      targetingRules: true,
    },
    orderBy: [desc(walkthroughs.updatedAt), desc(walkthroughs.id)],
    limit: limit + 1,
  });

  let filtered = rows as DefinitionRow[];
  if (lifecycles) {
    filtered = filtered.filter((r) => lifecycles.includes(r.lifecycle));
  }
  if (query.project) {
    filtered = filtered.filter((r) =>
      r.targetingRules.some((rule) => rule.type === 'project' && rule.value === query.project),
    );
  }
  if (query.cursor) {
    filtered = filtered.filter(
      (r) => r.updatedAt < query.cursor! || (r.updatedAt === query.cursor && r.id < query.cursor!),
    );
  }

  const page = filtered.slice(0, limit);
  const nextCursor = filtered.length > limit ? page[page.length - 1]?.updatedAt ?? null : null;
  return {
    items: page.map(mapDefinition),
    nextCursor,
  };
}

// ── Admin: create / update ────────────────────────────────────────────────────

export async function createWalkthrough(
  input: unknown,
  actor: { id: string },
): Promise<WalkthroughDefinition> {
  const command = validateCreateCommand(input);
  await assertStepsAgainstAuthoringCatalog(command.steps);
  const targeting = await validateTargetingAgainstDb(command.targeting);
  const ts = nowIso();

  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(walkthroughs)
      .values({
        internalName: command.internalName,
        userTitle: command.userTitle,
        whyItMatters: command.whyItMatters,
        lifecycle: 'draft',
        priority: command.priority ?? 0,
        isRequired: command.isRequired ?? false,
        revision: 1,
        createdBy: actor.id,
        updatedBy: actor.id,
        createdAt: ts,
        updatedAt: ts,
        generationProvenance: command.generationProvenance ?? null,
      })
      .returning({ id: walkthroughs.id });

    await replaceStepsAndRules(tx, row.id, command.steps, targeting);
    return row.id;
  });

  const loaded = await loadDefinition(id);
  if (!loaded) throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found after create');
  emitLifecycle(id, targeting.projects, 'created', 1);
  return mapDefinitionEnriched(loaded);
}

export async function updateWalkthrough(
  id: string,
  input: UpdateWalkthroughCommand,
  actor: { id: string },
): Promise<WalkthroughDefinition> {
  const existing = await loadDefinition(id);
  if (!existing) {
    throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
  }
  if (existing.lifecycle === 'archived') {
    throw new WalkthroughDomainError('INVALID_TRANSITION', 'Archived Walkthroughs cannot be edited');
  }
  if (input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) {
    throw new WalkthroughDomainError('REVISION_CONFLICT', 'Revision conflict');
  }
  if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== existing.updatedAt) {
    throw new WalkthroughDomainError('REVISION_CONFLICT', 'Update timestamp conflict');
  }
  if (input.isRequired !== undefined && typeof input.isRequired !== 'boolean') {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'isRequired must be a boolean');
  }

  const steps = input.steps !== undefined ? validateSteps(input.steps) : existing.steps.map(mapStep);
  if (input.steps !== undefined) {
    await assertStepsAgainstAuthoringCatalog(steps);
  }
  const targeting =
    input.targeting !== undefined
      ? await validateTargetingAgainstDb(input.targeting)
      : rulesToTargeting(mapRules(existing.targetingRules));
  const generationProvenance =
    input.generationProvenance !== undefined
      ? validateGenerationProvenance(input.generationProvenance)
      : existing.generationProvenance;
  const ts = nowIso();

  await db.transaction(async (tx) => {
    await tx
      .update(walkthroughs)
      .set({
        internalName: input.internalName?.trim() ?? existing.internalName,
        userTitle: input.userTitle?.trim() ?? existing.userTitle,
        whyItMatters: input.whyItMatters ?? existing.whyItMatters,
        priority: input.priority ?? existing.priority,
        isRequired: input.isRequired ?? existing.isRequired,
        generationProvenance,
        updatedBy: actor.id,
        updatedAt: ts,
      })
      .where(eq(walkthroughs.id, id));

    await replaceStepsAndRules(
      tx,
      id,
      steps.map((s) => ({
        id: s.id,
        ordinal: s.ordinal,
        heading: s.heading,
        bodyMarkdown: s.bodyMarkdown,
        route: s.route ?? s.anchor?.targetRoute ?? null,
        imageUrl: s.imageUrl ?? null,
        imageAlt: s.imageAlt ?? null,
        ctaLabel: s.ctaLabel ?? null,
        ctaRoute: s.ctaRoute ?? null,
        anchor: s.anchor ?? null,
      })),
      targeting,
    );
  });

  const loaded = await loadDefinition(id);
  if (!loaded) throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
  return mapDefinitionEnriched(loaded);
}

// ── Admin: lifecycle ──────────────────────────────────────────────────────────

export async function publishWalkthrough(
  id: string,
  command: PublishWalkthroughCommand,
  actor: { id: string },
): Promise<WalkthroughDefinition> {
  const existing = await loadDefinition(id);
  if (!existing) {
    throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
  }
  if (command.expectedUpdatedAt !== undefined && command.expectedUpdatedAt !== existing.updatedAt) {
    throw new WalkthroughDomainError('REVISION_CONFLICT', 'Update timestamp conflict');
  }

  const targeting = await validateTargetingAgainstDb(command.targeting);
  if (existing.steps.length === 0) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'Published Walkthroughs require at least one Step');
  }

  const mode = command.mode;
  let nextRevision = existing.revision;
  const from = existing.lifecycle;

  if (mode === 'fresh') {
    if (!canTransitionLifecycle(from, 'published') && from !== 'published') {
      throw new WalkthroughDomainError('INVALID_TRANSITION', `Cannot publish from ${from}`);
    }
    if (from === 'draft' || from === 'unpublished') {
      // Republish a previously live walkthrough as a new revision so prior
      // completion/dismissal progress cannot suppress it.
      if (from === 'unpublished' && existing.publishedAt) {
        nextRevision = existing.revision + 1;
      }
    } else if (from === 'published') {
      throw new WalkthroughDomainError(
        'INVALID_TRANSITION',
        'Use silent or reshow mode for an already published Walkthrough',
      );
    } else {
      throw new WalkthroughDomainError('INVALID_TRANSITION', `Cannot publish from ${from}`);
    }
  } else if (mode === 'silent' || mode === 'reshow') {
    if (from !== 'published') {
      throw new WalkthroughDomainError('INVALID_TRANSITION', 'Silent/reshow requires a published Walkthrough');
    }
    if (mode === 'reshow') {
      nextRevision = existing.revision + 1;
    }
  } else {
    throw new WalkthroughDomainError('VALIDATION_ERROR', `Unknown publish mode: ${String(mode)}`);
  }

  const ts = nowIso();
  await db.transaction(async (tx) => {
    await tx
      .update(walkthroughs)
      .set({
        lifecycle: 'published',
        revision: nextRevision,
        publishedAt: existing.publishedAt ?? ts,
        archivedAt: null,
        updatedBy: actor.id,
        updatedAt: ts,
      })
      .where(eq(walkthroughs.id, id));

    await tx.delete(walkthroughTargetingRules).where(eq(walkthroughTargetingRules.walkthroughId, id));
    await tx.insert(walkthroughTargetingRules).values(
      targetingToRules(targeting).map((r) => ({
        walkthroughId: id,
        type: r.type,
        value: r.value,
      })),
    );
  });

  emitLifecycle(id, targeting.projects, `publish:${mode}`, nextRevision);
  const loaded = await loadDefinition(id);
  if (!loaded) throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
  return mapDefinitionEnriched(loaded);
}

export async function unpublishWalkthrough(
  id: string,
  actor: { id: string },
  command: { expectedUpdatedAt?: string } = {},
): Promise<WalkthroughDefinition> {
  const existing = await loadDefinition(id);
  if (!existing) {
    throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
  }
  if (command.expectedUpdatedAt !== undefined && command.expectedUpdatedAt !== existing.updatedAt) {
    throw new WalkthroughDomainError('REVISION_CONFLICT', 'Update timestamp conflict');
  }
  if (!canTransitionLifecycle(existing.lifecycle, 'unpublished')) {
    throw new WalkthroughDomainError(
      'INVALID_TRANSITION',
      `Cannot unpublish from ${existing.lifecycle}`,
    );
  }
  const ts = nowIso();
  await db
    .update(walkthroughs)
    .set({
      lifecycle: 'unpublished',
      updatedBy: actor.id,
      updatedAt: ts,
    })
    .where(eq(walkthroughs.id, id));

  const targeting = rulesToTargeting(mapRules(existing.targetingRules));
  emitLifecycle(id, targeting.projects, 'unpublish', existing.revision);
  const loaded = await loadDefinition(id);
  if (!loaded) throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
  return mapDefinitionEnriched(loaded);
}

export async function archiveWalkthrough(
  id: string,
  actor: { id: string },
  command: { expectedUpdatedAt?: string } = {},
): Promise<WalkthroughDefinition> {
  const existing = await loadDefinition(id);
  if (!existing) {
    throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
  }
  if (command.expectedUpdatedAt !== undefined && command.expectedUpdatedAt !== existing.updatedAt) {
    throw new WalkthroughDomainError('REVISION_CONFLICT', 'Update timestamp conflict');
  }
  if (!canTransitionLifecycle(existing.lifecycle, 'archived')) {
    throw new WalkthroughDomainError(
      'INVALID_TRANSITION',
      `Cannot archive from ${existing.lifecycle}`,
    );
  }
  const ts = nowIso();
  await db
    .update(walkthroughs)
    .set({
      lifecycle: 'archived',
      archivedAt: ts,
      updatedBy: actor.id,
      updatedAt: ts,
    })
    .where(eq(walkthroughs.id, id));

  const targeting = rulesToTargeting(mapRules(existing.targetingRules));
  emitLifecycle(id, targeting.projects, 'archive', existing.revision);
  const loaded = await loadDefinition(id);
  if (!loaded) throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
  return mapDefinitionEnriched(loaded);
}

export function validateAiDraft(input: unknown): ValidatedWalkthroughDraft {
  const draft = validateCreateCommand(input) as WalkthroughDraftCommand;
  return { valid: true, draft };
}

// ── Audience helpers ──────────────────────────────────────────────────────────

export async function userHasProjectAccess(userId: string, projectId: string): Promise<boolean> {
  const rows = await db
    .select({ project: userProjectAssignments.project })
    .from(userProjectAssignments)
    .where(
      and(
        eq(userProjectAssignments.userId, userId),
        eq(userProjectAssignments.project, projectId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function userMatchesTargeting(
  userId: string,
  projectId: string,
  targeting: WalkthroughTargeting,
): Promise<boolean> {
  if (!targeting.projects.includes(projectId)) return false;
  const hasProject = await userHasProjectAccess(userId, projectId);
  if (!hasProject) return false;
  if (!targeting.groupId) return true;
  const groupIds = await getUserGroupIdsForProject(userId, projectId);
  return groupIds.includes(targeting.groupId);
}

function isSuppressedForRevision(
  progress: DbProgressRow | undefined,
  revision: number,
): boolean {
  if (!progress || progress.revision !== revision) return false;
  return progress.status === 'completed' || progress.status === 'dismissed';
}

// ── Authenticated: eligibility / replay / definition / progress ───────────────

export async function getNextEligible(
  projectId: string,
  userId: string,
): Promise<WalkthroughDefinition | null> {
  const started = Date.now();
  try {
    const hasProject = await userHasProjectAccess(userId, projectId);
    if (!hasProject) {
      trackEvent('walkthrough.eligibility.result', {
        project: projectId,
        result: 'no_project_access',
      }, { duration_ms: Date.now() - started });
      return null;
    }

    const groupIds = await getUserGroupIdsForProject(userId, projectId);

    const published = await db.query.walkthroughs.findMany({
      where: eq(walkthroughs.lifecycle, 'published'),
      with: {
        steps: { orderBy: [asc(walkthroughSteps.ordinal)] },
        targetingRules: true,
        progress: {
          where: eq(walkthroughProgress.userId, userId),
        },
      },
      // FEAT-005 AC-0 / BR-005: priority desc, then newest publishedAt wins ties.
      orderBy: [desc(walkthroughs.priority), desc(walkthroughs.publishedAt)],
    });

    const catalogRecords = await listCatalogRecordsForResolution();

    for (const row of published as Array<DefinitionRow & { progress: DbProgressRow[] }>) {
      let targeting: WalkthroughTargeting;
      try {
        targeting = rulesToTargeting(mapRules(row.targetingRules));
      } catch {
        continue;
      }
      if (!targeting.projects.includes(projectId)) continue;
      if (targeting.groupId && !groupIds.includes(targeting.groupId)) continue;

      const currentProgress = row.progress.find((p) => p.revision === row.revision);
      if (isSuppressedForRevision(currentProgress, row.revision)) continue;

      trackEvent('walkthrough.eligibility_evaluated', {
        project: projectId,
        outcome: 'eligible',
        walkthroughId: row.id,
      }, { duration_ms: Date.now() - started });
      trackEvent('walkthrough.eligibility.result', {
        project: projectId,
        result: 'hit',
        walkthroughId: row.id,
      }, { duration_ms: Date.now() - started });
      trackEvent('walkthrough.eligibility.duration_ms', { project: projectId }, {
        duration_ms: Date.now() - started,
      });
      return enrichMappedDefinition(row, catalogRecords);
    }

    trackEvent('walkthrough.eligibility.result', {
      project: projectId,
      result: 'none',
    }, { duration_ms: Date.now() - started });
    return null;
  } catch (err) {
    trackEvent('walkthrough.eligibility.result', {
      project: projectId,
      result: 'error',
    }, { duration_ms: Date.now() - started });
    throw err;
  }
}

export async function listReplay(
  projectId: string,
  userId: string,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<WalkthroughReplayPage> {
  const hasProject = await userHasProjectAccess(userId, projectId);
  if (!hasProject) {
    throw new WalkthroughDomainError('INACCESSIBLE', 'Project not accessible');
  }

  const limit = Math.min(Math.max(opts.limit ?? CATALOG_DEFAULT_LIMIT, 1), CATALOG_MAX_LIMIT);
  const groupIds = await getUserGroupIdsForProject(userId, projectId);

  const published = await db.query.walkthroughs.findMany({
    where: eq(walkthroughs.lifecycle, 'published'),
    with: {
      steps: { orderBy: [asc(walkthroughSteps.ordinal)] },
      targetingRules: true,
      progress: {
        where: eq(walkthroughProgress.userId, userId),
      },
    },
    orderBy: [desc(walkthroughs.priority), desc(walkthroughs.publishedAt)],
  });

  const catalogRecords = await listCatalogRecordsForResolution();
  const items = [];
  for (const row of published as Array<DefinitionRow & { progress: DbProgressRow[] }>) {
    let targeting: WalkthroughTargeting;
    try {
      targeting = rulesToTargeting(mapRules(row.targetingRules));
    } catch {
      continue;
    }
    if (!targeting.projects.includes(projectId)) continue;
    if (targeting.groupId && !groupIds.includes(targeting.groupId)) continue;

    const current = row.progress.find((p) => p.revision === row.revision) ?? null;
    const acknowledged = current ? deriveAcknowledged(assertPersistedProgressStatus(current.status)) : false;
    items.push({
      walkthrough: enrichMappedDefinition(row, catalogRecords),
      progress: current ? mapProgress(current) : null,
      state: (acknowledged ? 'acknowledged' : 'new') as 'new' | 'acknowledged',
    });
  }

  return { items: items.slice(0, limit), nextCursor: null };
}

export async function getAccessibleDefinition(
  projectId: string,
  walkthroughId: string,
  userId: string,
): Promise<WalkthroughDefinition> {
  const hasProject = await userHasProjectAccess(userId, projectId);
  if (!hasProject) {
    throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
  }

  const row = await loadDefinition(walkthroughId);
  if (!row || row.lifecycle !== 'published') {
    throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
  }

  let targeting: WalkthroughTargeting;
  try {
    targeting = rulesToTargeting(mapRules(row.targetingRules));
  } catch {
    throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
  }

  const matches = await userMatchesTargeting(userId, projectId, targeting);
  if (!matches) {
    throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
  }

  return mapDefinitionEnriched(row);
}

export async function updateOwnProgress(
  projectId: string,
  walkthroughId: string,
  userId: string,
  body: UpdateWalkthroughProgressRequest,
): Promise<WalkthroughProgress> {
  // Caller identity is always the server-derived userId — never accept client userId.
  const requestedStatus = assertPersistedProgressStatus(body.status);
  if (typeof body.revision !== 'number' || !Number.isInteger(body.revision) || body.revision < 1) {
    throw new WalkthroughDomainError('INVALID_PROGRESS', 'revision must be a positive integer');
  }

  const definition = await getAccessibleDefinition(projectId, walkthroughId, userId);
  if (body.revision !== definition.revision) {
    throw new WalkthroughDomainError(
      'REVISION_CONFLICT',
      'Progress revision must match the current Walkthrough revision',
    );
  }
  if (definition.isRequired && requestedStatus === 'dismissed') {
    throw new WalkthroughDomainError(
      'INVALID_PROGRESS',
      'Required Walkthroughs must be completed and cannot be dismissed',
    );
  }

  if (body.lastStepId) {
    const stepOk = definition.steps.some((s) => s.id === body.lastStepId);
    if (!stepOk) {
      throw new WalkthroughDomainError('INVALID_PROGRESS', 'lastStepId must belong to this Walkthrough');
    }
  }

  // FEAT-006 / BR-007: never downgrade terminal progress on replay.
  // - completed is sticky (dismiss/seen on replay must not rewrite metrics)
  // - dismissed must not fall back to seen; may upgrade to completed
  const existingRows = await db
    .select()
    .from(walkthroughProgress)
    .where(
      and(
        eq(walkthroughProgress.walkthroughId, walkthroughId),
        eq(walkthroughProgress.userId, userId),
        eq(walkthroughProgress.revision, body.revision),
      ),
    )
    .limit(1);
  const existing = existingRows[0];
  let status = requestedStatus;
  if (existing) {
    const prev = assertPersistedProgressStatus(existing.status);
    if (prev === 'completed') {
      status = 'completed';
    } else if (prev === 'dismissed' && requestedStatus === 'seen') {
      status = 'dismissed';
    }
  }

  const ts = nowIso();
  const acknowledged = deriveAcknowledged(status);
  const seenAt = status === 'seen' || acknowledged ? ts : null;
  // Preserve prior acknowledgement timestamp on non-downgrade / idempotent retry.
  const acknowledgedAt =
    acknowledged
      ? (existing?.acknowledgedAt && deriveAcknowledged(assertPersistedProgressStatus(existing.status))
          ? existing.acknowledgedAt
          : ts)
      : null;

  const [row] = await db
    .insert(walkthroughProgress)
    .values({
      walkthroughId,
      userId,
      revision: body.revision,
      status,
      lastStepId: body.lastStepId ?? null,
      seenAt,
      acknowledgedAt,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: [
        walkthroughProgress.walkthroughId,
        walkthroughProgress.userId,
        walkthroughProgress.revision,
      ],
      set: {
        status,
        lastStepId: body.lastStepId ?? null,
        seenAt: sql`COALESCE(${walkthroughProgress.seenAt}, ${ts})`,
        acknowledgedAt: acknowledged
          ? sql`COALESCE(${walkthroughProgress.acknowledgedAt}, ${ts})`
          : null,
        updatedAt: ts,
      },
    })
    .returning();

  trackEvent('walkthrough.progress.updated', {
    walkthroughId,
    project: projectId,
    status,
    revision: String(body.revision),
  });

  return mapProgress(row);
}

export type RecordWalkthroughAnchorMissInput = RecordAnchorMissRequest;

/**
 * FEAT-008 — durable, idempotent anchor-miss ingestion (extends FEAT-005 boundary).
 * Validates caller access + Step/registry tuple, persists one row per occurrenceId, emits telemetry.
 */
export async function recordAnchorMiss(
  projectId: string,
  walkthroughId: string,
  stepId: string,
  userId: string,
  body: RecordWalkthroughAnchorMissInput,
): Promise<{ accepted: true }> {
  if (typeof body.revision !== 'number' || !Number.isInteger(body.revision) || body.revision < 1) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'revision must be a positive integer');
  }
  if (typeof body.occurrenceId !== 'string' || !UUID_RE.test(body.occurrenceId.trim())) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'occurrenceId must be a UUID');
  }
  if (typeof body.anchorKey !== 'string' || !body.anchorKey.trim()) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'anchorKey is required');
  }
  if (typeof body.targetRoute !== 'string' || !body.targetRoute.trim()) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'targetRoute is required');
  }

  const definition = await getAccessibleDefinition(projectId, walkthroughId, userId);
  if (body.revision !== definition.revision) {
    throw new WalkthroughDomainError(
      'REVISION_CONFLICT',
      'Anchor-miss revision must match the current Walkthrough revision',
    );
  }

  const step = definition.steps.find((s) => s.id === stepId);
  if (!step) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'stepId must belong to this Walkthrough');
  }
  if (!step.anchor) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'Step is not anchored');
  }
  if (step.anchor.key !== body.anchorKey.trim()) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'anchorKey must match the published Step');
  }
  if (step.anchor.targetRoute !== body.targetRoute.trim()) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'targetRoute must match the published Step');
  }

  const registered = await getAnchorByKey(body.anchorKey.trim(), { includeDeleted: true });
  if (!registered) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'anchorKey is not in the anchor catalog');
  }

  const occurrenceId = body.occurrenceId.trim();
  const occurredAt = nowIso();

  try {
    await db
      .insert(walkthroughAnchorMisses)
      .values({
        walkthroughId,
        stepId,
        userId,
        revision: body.revision,
        projectSnapshot: projectId,
        anchorKey: registered.anchorKey,
        targetRoute: step.anchor.targetRoute,
        occurrenceId,
        occurredAt,
      })
      .onConflictDoNothing({
        target: [
          walkthroughAnchorMisses.userId,
          walkthroughAnchorMisses.walkthroughId,
          walkthroughAnchorMisses.stepId,
          walkthroughAnchorMisses.revision,
          walkthroughAnchorMisses.occurrenceId,
        ],
      });
  } catch (err) {
    trackEvent('walkthrough.anchor_miss.persist_failed', {
      walkthroughId,
      stepId,
      revision: String(body.revision),
      errorClass: err instanceof Error ? err.name : 'UnknownError',
    });
    throw err;
  }

  trackEvent('walkthrough.anchor_missed', {
    walkthroughId,
    stepId,
    revision: String(body.revision),
    anchorKey: registered.anchorKey,
    targetRoute: step.anchor.targetRoute,
    project: projectId,
    reason: typeof body.reason === 'string' ? body.reason : 'timeout',
  });

  return { accepted: true };
}

// ── Admin: acknowledgement report ─────────────────────────────────────────────

export async function getAcknowledgementReport(
  walkthroughId: string,
  statusFilter: WalkthroughAcknowledgementStatusFilter = 'all',
): Promise<WalkthroughAcknowledgementReport> {
  if (statusFilter !== 'all' && statusFilter !== 'completed' && statusFilter !== 'dismissed') {
    throw new WalkthroughDomainError(
      'VALIDATION_ERROR',
      'status filter must be all, completed, or dismissed',
    );
  }

  return db.transaction(async (tx) => {
    const row = await tx.query.walkthroughs.findFirst({
      where: eq(walkthroughs.id, walkthroughId),
      with: {
        steps: { orderBy: [asc(walkthroughSteps.ordinal)] },
        targetingRules: true,
      },
    });
    if (!row) {
      throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
    }

    const targeting = rulesToTargeting(mapRules(row.targetingRules));
    const audienceUserIds = await loadAudienceUserIdsTx(tx, targeting);
    const generatedAt = nowIso();

    const progressRows = audienceUserIds.length
      ? await tx
          .select({
            userId: walkthroughProgress.userId,
            status: walkthroughProgress.status,
            acknowledgedAt: walkthroughProgress.acknowledgedAt,
            displayName: appUsers.displayName,
            email: appUsers.email,
          })
          .from(walkthroughProgress)
          .innerJoin(appUsers, eq(walkthroughProgress.userId, appUsers.oid))
          .where(
            and(
              eq(walkthroughProgress.walkthroughId, walkthroughId),
              eq(walkthroughProgress.revision, row.revision),
              inArray(walkthroughProgress.userId, audienceUserIds),
              inArray(walkthroughProgress.status, ['completed', 'dismissed']),
            ),
          )
      : [];

    const completed: WalkthroughAcknowledgementUserRow[] = progressRows
      .filter((p) => p.status === 'completed' && p.acknowledgedAt)
      .map((p) => ({
        userId: p.userId,
        displayName: p.displayName,
        email: p.email,
        status: 'completed' as const,
        acknowledgedAt: p.acknowledgedAt!,
      }));
    const dismissed: WalkthroughAcknowledgementUserRow[] = progressRows
      .filter((p) => p.status === 'dismissed' && p.acknowledgedAt)
      .map((p) => ({
        userId: p.userId,
        displayName: p.displayName,
        email: p.email,
        status: 'dismissed' as const,
        acknowledgedAt: p.acknowledgedAt!,
      }));

    const details =
      statusFilter === 'completed'
        ? completed
        : statusFilter === 'dismissed'
          ? dismissed
          : [...completed, ...dismissed];

    trackEvent('walkthrough.reporting.read', {
      reportKind: 'acknowledgement',
      audienceSize: String(audienceUserIds.length),
      resultStatus: 'ok',
    });

    return {
      walkthroughId,
      revision: row.revision,
      generatedAt,
      acknowledgedCount: completed.length + dismissed.length,
      audienceCount: audienceUserIds.length,
      completedCount: completed.length,
      dismissedCount: dismissed.length,
      details,
      completed,
      dismissed,
    };
  });
}

export async function listAnchorMisses(
  walkthroughId: string,
  query: ListAnchorMissesQuery = {},
): Promise<WalkthroughAnchorMissPage> {
  const row = await loadDefinition(walkthroughId);
  if (!row) {
    throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
  }

  const limitRaw = query.limit ?? ANCHOR_MISS_DEFAULT_LIMIT;
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > ANCHOR_MISS_MAX_LIMIT) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'limit must be an integer from 1 to 100');
  }
  const limit = limitRaw;

  let cursorOccurredAt: string | null = null;
  let cursorId: string | null = null;
  if (query.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as {
        occurredAt?: string;
        id?: string;
      };
      if (typeof parsed.occurredAt !== 'string' || typeof parsed.id !== 'string') {
        throw new Error('bad cursor');
      }
      cursorOccurredAt = parsed.occurredAt;
      cursorId = parsed.id;
    } catch {
      throw new WalkthroughDomainError('VALIDATION_ERROR', 'cursor must be an opaque server cursor');
    }
  }

  const conditions = [eq(walkthroughAnchorMisses.walkthroughId, walkthroughId)];
  if (cursorOccurredAt && cursorId) {
    conditions.push(
      or(
        lt(walkthroughAnchorMisses.occurredAt, cursorOccurredAt),
        and(
          eq(walkthroughAnchorMisses.occurredAt, cursorOccurredAt),
          lt(walkthroughAnchorMisses.id, cursorId),
        ),
      )!,
    );
  }

  const rows = await db
    .select({
      id: walkthroughAnchorMisses.id,
      walkthroughId: walkthroughAnchorMisses.walkthroughId,
      stepId: walkthroughAnchorMisses.stepId,
      stepOrder: walkthroughSteps.ordinal,
      stepHeading: walkthroughSteps.heading,
      revision: walkthroughAnchorMisses.revision,
      anchorKey: walkthroughAnchorMisses.anchorKey,
      targetRoute: walkthroughAnchorMisses.targetRoute,
      occurredAt: walkthroughAnchorMisses.occurredAt,
    })
    .from(walkthroughAnchorMisses)
    .innerJoin(walkthroughSteps, eq(walkthroughAnchorMisses.stepId, walkthroughSteps.id))
    .where(and(...conditions))
    .orderBy(desc(walkthroughAnchorMisses.occurredAt), desc(walkthroughAnchorMisses.id))
    .limit(limit + 1);

  const pageRows = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last
      ? Buffer.from(JSON.stringify({ occurredAt: last.occurredAt, id: last.id }), 'utf8').toString(
          'base64url',
        )
      : null;

  trackEvent('walkthrough.reporting.read', {
    reportKind: 'anchor-misses',
    audienceSize: String(pageRows.length),
    resultStatus: 'ok',
  });

  return {
    items: pageRows.map((r) => ({
      id: r.id,
      walkthroughId: r.walkthroughId,
      stepId: r.stepId,
      stepOrder: r.stepOrder,
      stepHeading: r.stepHeading,
      revision: r.revision,
      anchorKey: r.anchorKey,
      targetRoute: r.targetRoute,
      occurredAt: r.occurredAt,
    })),
    nextCursor,
  };
}

async function loadAudienceUserIdsTx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle transaction client
  tx: any,
  targeting: WalkthroughTargeting,
): Promise<string[]> {
  if (targeting.groupId) {
    const project = targeting.projects[0];
    const rows = (await tx
      .select({ userId: appGroupMembers.userId })
      .from(appGroupMembers)
      .innerJoin(userProjectAssignments, eq(appGroupMembers.userId, userProjectAssignments.userId))
      .where(
        and(
          eq(appGroupMembers.groupId, targeting.groupId),
          eq(userProjectAssignments.project, project),
        ),
      )) as Array<{ userId: string }>;
    return [...new Set(rows.map((r) => r.userId))];
  }

  const rows = (await tx
    .select({ userId: userProjectAssignments.userId })
    .from(userProjectAssignments)
    .where(inArray(userProjectAssignments.project, targeting.projects))) as Array<{ userId: string }>;
  return [...new Set(rows.map((r) => r.userId))];
}

async function loadAudienceUserIds(targeting: WalkthroughTargeting): Promise<string[]> {
  return loadAudienceUserIdsTx(db, targeting);
}

/**
 * Live audience user IDs for a Walkthrough (FEAT-007 notification fan-out).
 * Resolves project assignment and optional in-project group membership server-side.
 */
export async function listLiveAudienceUserIds(walkthroughId: string): Promise<string[]> {
  const row = await loadDefinition(walkthroughId);
  if (!row) {
    throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
  }
  const targeting = rulesToTargeting(mapRules(row.targetingRules));
  return loadAudienceUserIds(targeting);
}

/**
 * Published Walkthroughs the user currently matches in a project (FEAT-007 reconcile).
 */
export async function listPublishedForUserInProject(
  userId: string,
  projectId: string,
): Promise<Array<{ id: string; revision: number; userTitle: string }>> {
  const hasProject = await userHasProjectAccess(userId, projectId);
  if (!hasProject) return [];

  const groupIds = await getUserGroupIdsForProject(userId, projectId);
  const published = await db.query.walkthroughs.findMany({
    where: eq(walkthroughs.lifecycle, 'published'),
    with: { targetingRules: true },
    orderBy: [desc(walkthroughs.priority), desc(walkthroughs.publishedAt)],
  });

  const out: Array<{ id: string; revision: number; userTitle: string }> = [];
  for (const row of published) {
    let targeting: WalkthroughTargeting;
    try {
      targeting = rulesToTargeting(mapRules(row.targetingRules));
    } catch {
      continue;
    }
    if (!targeting.projects.includes(projectId)) continue;
    if (targeting.groupId && !groupIds.includes(targeting.groupId)) continue;
    out.push({ id: row.id, revision: row.revision, userTitle: row.userTitle });
  }
  return out;
}

/** Admin get by id (no audience filter). */
export async function getWalkthroughAdmin(id: string): Promise<WalkthroughDefinition> {
  const row = await loadDefinition(id);
  if (!row) {
    throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
  }
  return mapDefinitionEnriched(row);
}
