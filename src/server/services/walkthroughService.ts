/**
 * Walkthrough domain service (FEAT-001 TBI-002).
 * Owns lifecycle, aggregate writes, live audience, eligibility, progress, and reporting.
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  appGroupMembers,
  appGroups,
  appUsers,
  userProjectAssignments,
  walkthroughProgress,
  walkthroughs,
  walkthroughSteps,
  walkthroughTargetingRules,
} from '../db/schema';
import { getUserGroupIdsForProject } from './featureFlagService';
import { trackEvent } from './telemetry';
import {
  assertPersistedProgressStatus,
  canTransitionLifecycle,
  deriveAcknowledged,
  rulesToTargeting,
  targetingToRules,
  validateCreateCommand,
  validateTargeting,
  validateSteps,
  WalkthroughDomainError,
  type PublishWalkthroughCommand,
  type UpdateWalkthroughCommand,
  type UpdateWalkthroughProgressRequest,
  type WalkthroughAcknowledgementReport,
  type WalkthroughCatalogPage,
  type WalkthroughCatalogQuery,
  type WalkthroughDefinition,
  type WalkthroughDraftCommand,
  type WalkthroughProgress,
  type WalkthroughReplayPage,
  type WalkthroughStep,
  type WalkthroughTargetRule,
  type WalkthroughTargeting,
  type ValidatedWalkthroughDraft,
} from '../../shared/types/walkthrough';

const CATALOG_DEFAULT_LIMIT = 50;
const CATALOG_MAX_LIMIT = 50;

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

function mapAnchor(step: DbStepRow): WalkthroughStep['anchor'] {
  if (!step.anchorKey && !step.targetRoute && !step.placement) return null;
  return {
    key: step.anchorKey!,
    targetRoute: step.targetRoute!,
    placement: step.placement!,
  };
}

function mapStep(row: DbStepRow): WalkthroughStep {
  return {
    id: row.id,
    walkthroughId: row.walkthroughId,
    ordinal: row.ordinal,
    heading: row.heading,
    bodyMarkdown: row.bodyMarkdown,
    imageUrl: row.imageUrl,
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
    revision: row.revision,
    publishedAt: row.publishedAt,
    archivedAt: row.archivedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
    steps,
    targeting: rulesToTargeting(targetingRules),
    targetingRules,
  };
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
    await assertGroupBelongsToProject(normalized.groupId, normalized.project);
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
        imageUrl: s.imageUrl ?? null,
        ctaLabel: s.ctaLabel ?? null,
        ctaRoute: s.ctaRoute ?? null,
        anchorKey: s.anchor?.key ?? null,
        targetRoute: s.anchor?.targetRoute ?? null,
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

function emitLifecycle(walkthroughId: string, project: string, transition: string, revision: number): void {
  trackEvent('walkthrough.lifecycle.changed', {
    walkthroughId,
    project,
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
        revision: 1,
        createdBy: actor.id,
        updatedBy: actor.id,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning({ id: walkthroughs.id });

    await replaceStepsAndRules(tx, row.id, command.steps, targeting);
    return row.id;
  });

  const loaded = await loadDefinition(id);
  if (!loaded) throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found after create');
  emitLifecycle(id, targeting.project, 'created', 1);
  return mapDefinition(loaded);
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

  const steps = input.steps !== undefined ? validateSteps(input.steps) : existing.steps.map(mapStep);
  const targeting =
    input.targeting !== undefined
      ? await validateTargetingAgainstDb(input.targeting)
      : rulesToTargeting(mapRules(existing.targetingRules));
  const ts = nowIso();

  await db.transaction(async (tx) => {
    await tx
      .update(walkthroughs)
      .set({
        internalName: input.internalName?.trim() ?? existing.internalName,
        userTitle: input.userTitle?.trim() ?? existing.userTitle,
        whyItMatters: input.whyItMatters ?? existing.whyItMatters,
        priority: input.priority ?? existing.priority,
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
        imageUrl: s.imageUrl ?? null,
        ctaLabel: s.ctaLabel ?? null,
        ctaRoute: s.ctaRoute ?? null,
        anchor: s.anchor ?? null,
      })),
      targeting,
    );
  });

  const loaded = await loadDefinition(id);
  if (!loaded) throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
  return mapDefinition(loaded);
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
      // ok
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

  emitLifecycle(id, targeting.project, `publish:${mode}`, nextRevision);
  const loaded = await loadDefinition(id);
  if (!loaded) throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
  return mapDefinition(loaded);
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
  emitLifecycle(id, targeting.project, 'unpublish', existing.revision);
  const loaded = await loadDefinition(id);
  if (!loaded) throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
  return mapDefinition(loaded);
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
  emitLifecycle(id, targeting.project, 'archive', existing.revision);
  const loaded = await loadDefinition(id);
  if (!loaded) throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
  return mapDefinition(loaded);
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
  if (targeting.project !== projectId) return false;
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
      orderBy: [desc(walkthroughs.priority), asc(walkthroughs.publishedAt)],
    });

    for (const row of published as Array<DefinitionRow & { progress: DbProgressRow[] }>) {
      let targeting: WalkthroughTargeting;
      try {
        targeting = rulesToTargeting(mapRules(row.targetingRules));
      } catch {
        continue;
      }
      if (targeting.project !== projectId) continue;
      if (targeting.groupId && !groupIds.includes(targeting.groupId)) continue;

      const currentProgress = row.progress.find((p) => p.revision === row.revision);
      if (isSuppressedForRevision(currentProgress, row.revision)) continue;

      trackEvent('walkthrough.eligibility.result', {
        project: projectId,
        result: 'hit',
        walkthroughId: row.id,
      }, { duration_ms: Date.now() - started });
      trackEvent('walkthrough.eligibility.duration_ms', { project: projectId }, {
        duration_ms: Date.now() - started,
      });
      return mapDefinition(row);
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
    orderBy: [desc(walkthroughs.priority), asc(walkthroughs.publishedAt)],
  });

  const items = [];
  for (const row of published as Array<DefinitionRow & { progress: DbProgressRow[] }>) {
    let targeting: WalkthroughTargeting;
    try {
      targeting = rulesToTargeting(mapRules(row.targetingRules));
    } catch {
      continue;
    }
    if (targeting.project !== projectId) continue;
    if (targeting.groupId && !groupIds.includes(targeting.groupId)) continue;

    const current = row.progress.find((p) => p.revision === row.revision) ?? null;
    const acknowledged = current ? deriveAcknowledged(assertPersistedProgressStatus(current.status)) : false;
    items.push({
      walkthrough: mapDefinition(row),
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

  return mapDefinition(row);
}

export async function updateOwnProgress(
  projectId: string,
  walkthroughId: string,
  userId: string,
  body: UpdateWalkthroughProgressRequest,
): Promise<WalkthroughProgress> {
  // Caller identity is always the server-derived userId — never accept client userId.
  const status = assertPersistedProgressStatus(body.status);
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

  if (body.lastStepId) {
    const stepOk = definition.steps.some((s) => s.id === body.lastStepId);
    if (!stepOk) {
      throw new WalkthroughDomainError('INVALID_PROGRESS', 'lastStepId must belong to this Walkthrough');
    }
  }

  const ts = nowIso();
  const acknowledged = deriveAcknowledged(status);
  const seenAt = status === 'seen' || acknowledged ? ts : null;
  const acknowledgedAt = acknowledged ? ts : null;

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
        acknowledgedAt,
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

// ── Admin: acknowledgement report ─────────────────────────────────────────────

export async function getAcknowledgementReport(
  walkthroughId: string,
): Promise<WalkthroughAcknowledgementReport> {
  const row = await loadDefinition(walkthroughId);
  if (!row) {
    throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
  }

  const targeting = rulesToTargeting(mapRules(row.targetingRules));
  const audienceUserIds = await loadAudienceUserIds(targeting);

  const progressRows = audienceUserIds.length
    ? await db
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

  const completed = progressRows
    .filter((p) => p.status === 'completed' && p.acknowledgedAt)
    .map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      email: p.email,
      status: 'completed' as const,
      acknowledgedAt: p.acknowledgedAt!,
    }));
  const dismissed = progressRows
    .filter((p) => p.status === 'dismissed' && p.acknowledgedAt)
    .map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      email: p.email,
      status: 'dismissed' as const,
      acknowledgedAt: p.acknowledgedAt!,
    }));

  return {
    walkthroughId,
    revision: row.revision,
    acknowledgedCount: completed.length + dismissed.length,
    audienceCount: audienceUserIds.length,
    completed,
    dismissed,
  };
}

async function loadAudienceUserIds(targeting: WalkthroughTargeting): Promise<string[]> {
  if (targeting.groupId) {
    const rows = await db
      .select({ userId: appGroupMembers.userId })
      .from(appGroupMembers)
      .innerJoin(userProjectAssignments, eq(appGroupMembers.userId, userProjectAssignments.userId))
      .where(
        and(
          eq(appGroupMembers.groupId, targeting.groupId),
          eq(userProjectAssignments.project, targeting.project),
        ),
      );
    return [...new Set(rows.map((r) => r.userId))];
  }

  const rows = await db
    .select({ userId: userProjectAssignments.userId })
    .from(userProjectAssignments)
    .where(eq(userProjectAssignments.project, targeting.project));
  return rows.map((r) => r.userId);
}

/** Admin get by id (no audience filter). */
export async function getWalkthroughAdmin(id: string): Promise<WalkthroughDefinition> {
  const row = await loadDefinition(id);
  if (!row) {
    throw new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found');
  }
  return mapDefinition(row);
}
