import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { and, asc, desc, eq, inArray, ne, not, isNull, max, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  appUsers,
  apexWorkItems,
  apexWorkItemCollaborators,
  apexWorkItemEvents,
  apexWorkItemComments,
  apexWorkItemAttachments,
  apexWorkItemLinks,
  apexReleases,
  featureRequests,
  notifications,
  prds,
  designDocs,
  designPrototypes,
  designPlans,
  userProjectAssignments,
} from '../db/schema';
import { createNotification } from './notificationService';
import { emitBoardChange } from './apexWorkBoardBus';
import { resolveDataRoot } from '../utils/dataDir';
import type {
  ApexRelease,
  ApexWorkItem,
  ApexWorkItemAttachment,
  ApexWorkItemComment,
  ApexWorkItemDocumentLink,
  ApexWorkItemDraft,
  ApexWorkItemEvent,
  ApexWorkItemFacets,
  ApexWorkItemFilters,
  ApexWorkItemHierarchyNode,
  ApexWorkItemStatus,
  ApexWorkItemType,
  AcceptanceCriterion,
  BulkUpdateApexWorkItemsDTO,
  CreateApexReleaseDTO,
  CreateApexWorkItemDTO,
  CreateFromDraftsDTO,
  CreateFromDraftsResult,
  DraftReconcilePreviewResult,
  GenerateFromFeatureRequestDTO,
  MaterializeFromPrdDTO,
  MaterializePlanLeaf,
  MaterializePreviewResult,
  MaterializeResult,
  MoveApexWorkItemDTO,
  UpdateApexReleaseDTO,
  UpdateApexWorkItemDTO,
  WorkItemOwnerSummary,
} from '../../shared/types/apexWorkItem';

const MAX_BOARD_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function httpError(msg: string, status = 400): Error {
  const e = new Error(msg);
  (e as Error & { status?: number }).status = status;
  return e;
}

function requireProject(project: string | undefined): string {
  if (!project?.trim()) throw httpError('project is required', 400);
  return project.trim();
}

function toOwnerSummary(row: { oid: string; displayName: string | null; email: string | null }): WorkItemOwnerSummary {
  return {
    oid: row.oid,
    displayName: row.displayName ?? row.email ?? row.oid,
    email: row.email ?? '',
  };
}

function acWithIds(criteria: Omit<AcceptanceCriterion, 'id'>[]): AcceptanceCriterion[] {
  return criteria.map((c, i) => ({ id: `ac-${Date.now()}-${i}`, ...c }));
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

const EARLY_STATUSES: ApexWorkItemStatus[] = ['idea', 'ready'];

async function resolveFeatureRequestIdForPrd(prdId: string): Promise<string | null> {
  const prd = await db.query.prds.findFirst({ where: eq(prds.id, prdId) });
  if (!prd?.interviewId) return null;
  const fr = await db.query.featureRequests.findFirst({
    where: eq(featureRequests.interviewId, prd.interviewId),
  });
  return fr?.id ?? null;
}

async function resolveOwnerSummary(oid: string): Promise<WorkItemOwnerSummary> {
  const row = await db.query.appUsers.findFirst({ where: eq(appUsers.oid, oid) });
  if (!row) throw httpError(`User ${oid} not found`, 404);
  return toOwnerSummary(row);
}

async function resolveActorName(actorId: string): Promise<string> {
  const row = await db.query.appUsers.findFirst({ where: eq(appUsers.oid, actorId) });
  return row?.displayName ?? row?.email ?? actorId;
}

async function nextItemNumber(project: string, tx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0] = db): Promise<number> {
  const [row] = await tx
    .select({ maxNum: max(apexWorkItems.itemNumber) })
    .from(apexWorkItems)
    .where(eq(apexWorkItems.project, project));
  return (row?.maxNum ?? 0) + 1;
}

async function appendEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db,
  workItemId: string,
  actorId: string,
  action: ApexWorkItemEvent['action'],
  extra: Partial<Pick<ApexWorkItemEvent, 'fromStatus' | 'toStatus' | 'details'>> = {},
): Promise<void> {
  await tx.insert(apexWorkItemEvents).values({
    workItemId,
    actorId,
    action,
    fromStatus: extra.fromStatus ?? null,
    toStatus: extra.toStatus ?? null,
    details: extra.details ?? {},
  });
}

async function reRankColumn(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db,
  project: string,
  status: ApexWorkItemStatus,
): Promise<void> {
  const rows = await tx
    .select({ id: apexWorkItems.id })
    .from(apexWorkItems)
    .where(and(eq(apexWorkItems.project, project), eq(apexWorkItems.status, status)))
    .orderBy(asc(apexWorkItems.position));
  for (let i = 0; i < rows.length; i++) {
    await tx.update(apexWorkItems).set({ position: i }).where(eq(apexWorkItems.id, rows[i].id));
  }
}

async function loadCollaborators(workItemId: string): Promise<WorkItemOwnerSummary[]> {
  const rows = await db
    .select({ oid: appUsers.oid, displayName: appUsers.displayName, email: appUsers.email })
    .from(apexWorkItemCollaborators)
    .innerJoin(appUsers, eq(apexWorkItemCollaborators.userOid, appUsers.oid))
    .where(eq(apexWorkItemCollaborators.workItemId, workItemId));
  return rows.map(toOwnerSummary);
}

async function loadEvents(workItemId: string): Promise<ApexWorkItemEvent[]> {
  const rows = await db
    .select({
      id: apexWorkItemEvents.id,
      workItemId: apexWorkItemEvents.workItemId,
      actorId: apexWorkItemEvents.actorId,
      actorName: appUsers.displayName,
      actorEmail: appUsers.email,
      action: apexWorkItemEvents.action,
      fromStatus: apexWorkItemEvents.fromStatus,
      toStatus: apexWorkItemEvents.toStatus,
      details: apexWorkItemEvents.details,
      createdAt: apexWorkItemEvents.createdAt,
    })
    .from(apexWorkItemEvents)
    .leftJoin(appUsers, eq(apexWorkItemEvents.actorId, appUsers.oid))
    .where(eq(apexWorkItemEvents.workItemId, workItemId))
    .orderBy(asc(apexWorkItemEvents.createdAt));
  return rows.map((r) => ({
    id: r.id,
    workItemId: r.workItemId,
    actorId: r.actorId,
    actorName: r.actorName ?? r.actorEmail ?? r.actorId,
    action: r.action as ApexWorkItemEvent['action'],
    fromStatus: (r.fromStatus ?? undefined) as ApexWorkItemStatus | undefined,
    toStatus: (r.toStatus ?? undefined) as ApexWorkItemStatus | undefined,
    details: (r.details ?? {}) as Record<string, unknown>,
    createdAt: r.createdAt,
  }));
}

function toRelease(row: typeof apexReleases.$inferSelect): ApexRelease {
  return {
    id: row.id,
    project: row.project,
    name: row.name,
    version: row.version ?? null,
    targetDate: row.targetDate ?? null,
    status: row.status as ApexRelease['status'],
    position: row.position,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeDocTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

type BacklogFeatureNode = {
  id?: string;
  title?: string;
  designDocId?: string;
  designPrototypeId?: string;
  features?: BacklogFeatureNode[];
};

function collectBacklogFeatures(backlogJson: unknown): BacklogFeatureNode[] {
  if (!backlogJson || typeof backlogJson !== 'object') return [];
  const root = backlogJson as { features?: BacklogFeatureNode[]; epics?: BacklogFeatureNode[] };
  const out: BacklogFeatureNode[] = [];
  if (Array.isArray(root.features)) {
    for (const f of root.features) out.push(f);
  }
  if (Array.isArray(root.epics)) {
    for (const epic of root.epics) {
      if (Array.isArray(epic.features)) {
        for (const f of epic.features) out.push(f);
      }
    }
  }
  return out;
}

export async function resolveDesignLinksForFeature(opts: {
  prdId: string | null | undefined;
  featureId?: string | null;
  featureTitle?: string | null;
}): Promise<{ designDocId: string | null; designPrototypeId: string | null }> {
  if (!opts.prdId) return { designDocId: null, designPrototypeId: null };

  const prd = await db.query.prds.findFirst({ where: eq(prds.id, opts.prdId) });
  if (!prd) return { designDocId: null, designPrototypeId: null };

  const docs = await db
    .select({
      id: designDocs.id,
      title: designDocs.title,
      featureIndex: designDocs.featureIndex,
      designPrototypeId: designDocs.designPrototypeId,
    })
    .from(designDocs)
    .where(eq(designDocs.prdId, opts.prdId));

  if (docs.length === 0) return { designDocId: null, designPrototypeId: null };

  const features = collectBacklogFeatures(prd.backlogJson);
  const stamped = opts.featureId
    ? features.find((f) => f.id === opts.featureId)
    : opts.featureTitle
      ? features.find((f) => f.title === opts.featureTitle)
      : undefined;

  if (stamped?.designDocId) {
    const byStamp = docs.find((d) => d.id === stamped.designDocId);
    if (byStamp) {
      return {
        designDocId: byStamp.id,
        designPrototypeId: byStamp.designPrototypeId ?? stamped.designPrototypeId ?? null,
      };
    }
  }
  if (stamped?.designPrototypeId) {
    const byProto = docs.find((d) => d.designPrototypeId === stamped.designPrototypeId);
    if (byProto) {
      return { designDocId: byProto.id, designPrototypeId: byProto.designPrototypeId ?? stamped.designPrototypeId };
    }
  }

  if (docs.length === 1) {
    return {
      designDocId: docs[0].id,
      designPrototypeId: docs[0].designPrototypeId ?? stamped?.designPrototypeId ?? null,
    };
  }

  const featTitle = opts.featureTitle ?? stamped?.title ?? null;
  if (featTitle) {
    const featNorm = normalizeDocTitle(featTitle);
    const byIndex = docs.find((d) => {
      if (d.featureIndex == null) return false;
      return features[d.featureIndex]?.title === featTitle
        || (features[d.featureIndex]?.id && features[d.featureIndex]?.id === opts.featureId);
    });
    if (byIndex) {
      return {
        designDocId: byIndex.id,
        designPrototypeId: byIndex.designPrototypeId ?? null,
      };
    }
    const byTitle = docs.find((d) => {
      const docNorm = normalizeDocTitle(d.title);
      if (docNorm === featNorm) return true;
      if (docNorm.length >= 4 && featNorm.length >= 4) {
        return docNorm.includes(featNorm) || featNorm.includes(docNorm);
      }
      return false;
    });
    if (byTitle) {
      return {
        designDocId: byTitle.id,
        designPrototypeId: byTitle.designPrototypeId ?? null,
      };
    }
  }

  return { designDocId: null, designPrototypeId: null };
}

async function buildDocumentLinks(item: {
  prdId: string | null;
  featureRequestId: string | null;
  designDocId: string | null;
  designPrototypeId: string | null;
}): Promise<ApexWorkItemDocumentLink[]> {
  const links: ApexWorkItemDocumentLink[] = [];

  if (item.featureRequestId) {
    links.push({
      kind: 'feature_request',
      label: 'Feature Request',
      path: `/feature-requests?id=${encodeURIComponent(item.featureRequestId)}`,
      available: true,
    });
  }

  if (item.prdId) {
    const prdExists = await db.query.prds.findFirst({
      where: eq(prds.id, item.prdId),
      columns: { id: true },
    });
    links.push({
      kind: 'prd',
      label: 'PRD',
      path: `/backlog/prd/${item.prdId}`,
      available: !!prdExists,
    });

    const plan = await db.query.designPlans.findFirst({
      where: eq(designPlans.prdId, item.prdId),
      columns: { id: true },
    });
    links.push({
      kind: 'design_plan',
      label: 'Design Plan',
      path: `/backlog/design-plan/${item.prdId}`,
      available: !!plan,
    });

    const protoCount = await db
      .select({ id: designPrototypes.id })
      .from(designPrototypes)
      .where(eq(designPrototypes.prdId, item.prdId))
      .limit(1);
    links.push({
      kind: 'design_prototypes',
      label: 'Prototypes',
      path: `/backlog/design-prototypes/${item.prdId}`,
      available: protoCount.length > 0 || !!item.designPrototypeId,
    });
  }

  if (item.designDocId) {
    const doc = await db.query.designDocs.findFirst({
      where: eq(designDocs.id, item.designDocId),
      columns: { id: true },
    });
    links.push({
      kind: 'design_doc',
      label: 'Design Doc',
      path: `/backlog/design-doc/${item.designDocId}`,
      available: !!doc,
    });
  }

  return links;
}

async function toApexWorkItem(
  row: typeof apexWorkItems.$inferSelect,
  includeEvents = false,
): Promise<ApexWorkItem> {
  const owner = await resolveOwnerSummary(row.ownerOid);
  const collaborators = await loadCollaborators(row.id);
  const events = includeEvents ? await loadEvents(row.id) : undefined;
  let release: ApexRelease | null = null;
  if (row.releaseId) {
    const rel = await db.query.apexReleases.findFirst({ where: eq(apexReleases.id, row.releaseId) });
    if (rel) release = toRelease(rel);
  }
  return {
    id: row.id,
    project: row.project,
    itemNumber: row.itemNumber,
    title: row.title,
    outcome: row.outcome,
    type: row.type as ApexWorkItemType,
    status: row.status as ApexWorkItemStatus,
    owner,
    collaborators,
    acceptanceCriteria: (row.acceptanceCriteria ?? []) as AcceptanceCriterion[],
    branch: row.branch ?? null,
    prUrl: row.prUrl ?? null,
    position: row.position,
    dueDate: row.dueDate ?? null,
    releaseId: row.releaseId ?? null,
    release,
    parentId: row.parentId ?? null,
    sourceType: (row.sourceType ?? 'standalone') as ApexWorkItem['sourceType'],
    prdId: row.prdId ?? null,
    backlogItemId: row.backlogItemId ?? null,
    featureRequestId: row.featureRequestId ?? null,
    adoWorkItemId: row.adoWorkItemId ?? null,
    epicId: row.epicId ?? null,
    epicTitle: row.epicTitle ?? null,
    featureId: row.featureId ?? null,
    featureTitle: row.featureTitle ?? null,
    designDocId: row.designDocId ?? null,
    designPrototypeId: row.designPrototypeId ?? null,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(events !== undefined ? { events } : {}),
  };
}

// â”€â”€ Eligible owners â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function listEligibleOwners(project: string): Promise<WorkItemOwnerSummary[]> {
  const p = requireProject(project);
  const assignees = await db
    .select({ oid: appUsers.oid, displayName: appUsers.displayName, email: appUsers.email })
    .from(appUsers)
    .innerJoin(userProjectAssignments, eq(userProjectAssignments.userId, appUsers.oid))
    .where(eq(userProjectAssignments.project, p));
  // De-dupe
  const seen = new Set<string>();
  return assignees
    .filter((u) => {
      if (seen.has(u.oid)) return false;
      seen.add(u.oid);
      return true;
    })
    .map(toOwnerSummary);
}

// â”€â”€ Releases â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function listReleases(project: string): Promise<ApexRelease[]> {
  const p = requireProject(project);
  const rows = await db
    .select()
    .from(apexReleases)
    .where(eq(apexReleases.project, p))
    .orderBy(asc(apexReleases.position), asc(apexReleases.targetDate));

  const counts = await db
    .select({
      releaseId: apexWorkItems.releaseId,
      total: sql<number>`count(*)::int`,
      done: sql<number>`count(*) filter (where ${apexWorkItems.status} = 'done')::int`,
    })
    .from(apexWorkItems)
    .where(and(eq(apexWorkItems.project, p), not(isNull(apexWorkItems.releaseId))))
    .groupBy(apexWorkItems.releaseId);

  const countMap = new Map(counts.map((c) => [c.releaseId!, { total: c.total, done: c.done }]));
  return rows.map((r) => {
    const c = countMap.get(r.id);
    return {
      ...toRelease(r),
      itemCount: c?.total ?? 0,
      doneCount: c?.done ?? 0,
    };
  });
}

export async function createRelease(actorId: string, project: string, dto: CreateApexReleaseDTO): Promise<ApexRelease> {
  const p = requireProject(project);
  if (!dto.name?.trim()) throw httpError('name is required');
  const [row] = await db
    .insert(apexReleases)
    .values({
      project: p,
      name: dto.name.trim(),
      version: dto.version ?? null,
      targetDate: dto.targetDate ?? null,
      status: dto.status ?? 'planned',
      position: 9999,
      createdBy: actorId,
      updatedBy: actorId,
    })
    .returning();
  const release = toRelease(row);
  emitBoardChange(p, { action: 'release_created', releaseId: release.id });
  return release;
}

export async function updateRelease(
  id: string,
  actorId: string,
  project: string,
  dto: UpdateApexReleaseDTO,
): Promise<ApexRelease> {
  const p = requireProject(project);
  const existing = await db.query.apexReleases.findFirst({
    where: and(eq(apexReleases.id, id), eq(apexReleases.project, p)),
  });
  if (!existing) throw httpError('Release not found', 404);

  const set: Partial<typeof apexReleases.$inferInsert> = {
    updatedBy: actorId,
    updatedAt: new Date().toISOString(),
  };
  if (dto.name !== undefined) set.name = dto.name.trim();
  if (dto.version !== undefined) set.version = dto.version;
  if (dto.targetDate !== undefined) set.targetDate = dto.targetDate;
  if (dto.status !== undefined) set.status = dto.status;
  if (dto.position !== undefined) set.position = dto.position;

  const [row] = await db.update(apexReleases).set(set).where(eq(apexReleases.id, id)).returning();
  const release = toRelease(row);
  emitBoardChange(p, { action: 'release_updated', releaseId: release.id });
  return release;
}

export async function deleteRelease(id: string, project: string): Promise<void> {
  const p = requireProject(project);
  const existing = await db.query.apexReleases.findFirst({
    where: and(eq(apexReleases.id, id), eq(apexReleases.project, p)),
  });
  if (!existing) throw httpError('Release not found', 404);
  await db.delete(apexReleases).where(eq(apexReleases.id, id));
}

// â”€â”€ Filter facets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function listFilterFacets(project: string): Promise<ApexWorkItemFacets> {
  const p = requireProject(project);
  const rows = await db
    .selectDistinct({ epicTitle: apexWorkItems.epicTitle, featureTitle: apexWorkItems.featureTitle })
    .from(apexWorkItems)
    .where(eq(apexWorkItems.project, p));
  const epicTitles = [...new Set(rows.map((r) => r.epicTitle).filter(Boolean) as string[])].sort();
  const featureTitles = [...new Set(rows.map((r) => r.featureTitle).filter(Boolean) as string[])].sort();
  const owners = await listEligibleOwners(p);
  const releases = await listReleases(p);
  return { epicTitles, featureTitles, owners, releases };
}

// â”€â”€ List â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function listApexWorkItems(filters: ApexWorkItemFilters): Promise<ApexWorkItem[]> {
  const project = requireProject(filters.project);
  const conditions = [eq(apexWorkItems.project, project)];

  if (filters.ownerId && filters.ownerId !== 'all') {
    conditions.push(eq(apexWorkItems.ownerOid, filters.ownerId));
  }
  if (filters.types && filters.types.length > 0) {
    conditions.push(inArray(apexWorkItems.type, filters.types));
  }
  if (filters.epicTitle) {
    conditions.push(eq(apexWorkItems.epicTitle, filters.epicTitle));
  }
  if (filters.featureTitle) {
    conditions.push(eq(apexWorkItems.featureTitle, filters.featureTitle));
  }
  if (filters.sourceType && filters.sourceType !== 'all') {
    conditions.push(eq(apexWorkItems.sourceType, filters.sourceType));
  }
  if (filters.releaseId && filters.releaseId !== 'all') {
    if (filters.releaseId === 'none') {
      conditions.push(isNull(apexWorkItems.releaseId));
    } else {
      conditions.push(eq(apexWorkItems.releaseId, filters.releaseId));
    }
  }
  if (filters.parentId && filters.parentId !== 'all') {
    if (filters.parentId === 'root') {
      conditions.push(isNull(apexWorkItems.parentId));
    } else {
      conditions.push(eq(apexWorkItems.parentId, filters.parentId));
    }
  }
  if (filters.search) {
    const term = `%${filters.search.toLowerCase()}%`;
    conditions.push(
      sql`(lower(${apexWorkItems.title}) like ${term} or lower(cast(${apexWorkItems.itemNumber} as text)) like ${term})`,
    );
  }

  const rows = await db
    .select()
    .from(apexWorkItems)
    .where(and(...conditions))
    .orderBy(asc(apexWorkItems.status), asc(apexWorkItems.position));

  const items = await Promise.all(rows.map((r) => toApexWorkItem(r)));
  maybeNotifyDueSoon();
  return items;
}

// â”€â”€ Due-soon notifications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let lastDueSoonCheckAt = 0;
const DUE_SOON_CHECK_INTERVAL_MS = 60 * 60 * 1000;

function maybeNotifyDueSoon(): void {
  const now = Date.now();
  if (now - lastDueSoonCheckAt < DUE_SOON_CHECK_INTERVAL_MS) return;
  lastDueSoonCheckAt = now;
  notifyDueSoonWorkItems().catch((err) => {
    console.error('[work-board] due-soon check failed:', (err as Error).message);
  });
}

/**
 * Notify owners of work items due within the next 2 days (status != done).
 * Dedupes via notification dedupeKey per item per calendar day.
 * @returns number of new notifications created
 */
export async function notifyDueSoonWorkItems(): Promise<number> {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() + 2);
  const endStr = end.toISOString().slice(0, 10);

  const rows = await db
    .select({
      id: apexWorkItems.id,
      project: apexWorkItems.project,
      itemNumber: apexWorkItems.itemNumber,
      title: apexWorkItems.title,
      dueDate: apexWorkItems.dueDate,
      ownerOid: apexWorkItems.ownerOid,
    })
    .from(apexWorkItems)
    .where(
      and(
        ne(apexWorkItems.status, 'done'),
        not(isNull(apexWorkItems.dueDate)),
        sql`${apexWorkItems.dueDate} >= ${todayStr}`,
        sql`${apexWorkItems.dueDate} <= ${endStr}`,
      ),
    );

  let created = 0;
  for (const row of rows) {
    if (!row.ownerOid || !row.dueDate) continue;
    const dedupeKey = `work_board_due_soon:${row.id}:${todayStr}`;
    const existing = await db.query.notifications.findFirst({
      where: eq(notifications.dedupeKey, dedupeKey),
    });
    if (existing) continue;

    await createNotification(
      row.ownerOid,
      {
        type: 'background',
        title: 'Work item due soon',
        body: `"${row.title}" (APX-${row.itemNumber}) is due ${row.dueDate}`,
        link: `/work-board?item=${row.id}`,
      },
      { dedupeKey },
    );
    created += 1;
  }
  return created;
}

// â”€â”€ Get by id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function toHierarchyNode(row: {
  id: string;
  itemNumber: number;
  title: string;
  type: string;
  status: string;
}): ApexWorkItemHierarchyNode {
  return {
    id: row.id,
    itemNumber: row.itemNumber,
    title: row.title,
    type: row.type as ApexWorkItemType,
    status: row.status as ApexWorkItemStatus,
  };
}

export async function getApexWorkItem(id: string, project?: string): Promise<ApexWorkItem> {
  let row = await db.query.apexWorkItems.findFirst({ where: eq(apexWorkItems.id, id) });
  if (!row) throw httpError('Work item not found', 404);
  if (project && row.project !== project) throw httpError('Work item not found', 404);

  // Lazily stamp design links for older items (same matching as ADO Feature attach).
  if (row.prdId && !row.designDocId) {
    const resolved = await resolveDesignLinksForFeature({
      prdId: row.prdId,
      featureId: row.featureId,
      featureTitle: row.featureTitle,
    });
    if (resolved.designDocId || resolved.designPrototypeId) {
      const [updated] = await db
        .update(apexWorkItems)
        .set({
          designDocId: resolved.designDocId,
          designPrototypeId: resolved.designPrototypeId,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(apexWorkItems.id, id))
        .returning();
      if (updated) row = updated;
    }
  }

  const item = await toApexWorkItem(row, true);
  item.comments = await listComments(id, row.project);
  item.attachments = await listAttachments(id, row.project);
  item.documentLinks = await buildDocumentLinks({
    prdId: row.prdId ?? null,
    featureRequestId: row.featureRequestId ?? null,
    designDocId: row.designDocId ?? null,
    designPrototypeId: row.designPrototypeId ?? null,
  });

  if (row.parentId) {
    const parent = await db.query.apexWorkItems.findFirst({
      where: and(eq(apexWorkItems.id, row.parentId), eq(apexWorkItems.project, row.project)),
    });
    item.parent = parent ? toHierarchyNode(parent) : null;
  } else {
    item.parent = null;
  }

  const childRows = await db
    .select({
      id: apexWorkItems.id,
      itemNumber: apexWorkItems.itemNumber,
      title: apexWorkItems.title,
      type: apexWorkItems.type,
      status: apexWorkItems.status,
    })
    .from(apexWorkItems)
    .where(and(eq(apexWorkItems.parentId, id), eq(apexWorkItems.project, row.project)))
    .orderBy(asc(apexWorkItems.itemNumber));
  item.children = childRows.map(toHierarchyNode);

  return item;
}

// â”€â”€ Create (standalone) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function createApexWorkItem(
  actorId: string,
  dto: CreateApexWorkItemDTO,
): Promise<ApexWorkItem> {
  const project = requireProject(dto.project);
  const designLinks = dto.designDocId || dto.designPrototypeId
    ? { designDocId: dto.designDocId ?? null, designPrototypeId: dto.designPrototypeId ?? null }
    : await resolveDesignLinksForFeature({
      prdId: dto.prdId,
      featureId: dto.featureId,
      featureTitle: dto.featureTitle,
    });
  const item = await db.transaction(async (tx) => {
    const itemNumber = await nextItemNumber(project, tx);
    const [row] = await tx
      .insert(apexWorkItems)
      .values({
        project,
        itemNumber,
        title: dto.title,
        outcome: dto.outcome,
        type: dto.type,
        status: dto.status ?? 'idea',
        ownerOid: dto.ownerId,
        acceptanceCriteria: dto.acceptanceCriteria ? acWithIds(dto.acceptanceCriteria) : [],
        branch: dto.branch ?? null,
        prUrl: dto.prUrl ?? null,
        dueDate: dto.dueDate ?? null,
        releaseId: dto.releaseId ?? null,
        parentId: dto.parentId ?? null,
        position: 9999,
        sourceType: dto.sourceType ?? 'standalone',
        prdId: dto.prdId ?? null,
        backlogItemId: dto.backlogItemId ?? null,
        featureRequestId: dto.featureRequestId ?? null,
        epicId: dto.epicId ?? null,
        epicTitle: dto.epicTitle ?? null,
        featureId: dto.featureId ?? null,
        featureTitle: dto.featureTitle ?? null,
        designDocId: designLinks.designDocId,
        designPrototypeId: designLinks.designPrototypeId,
        createdBy: actorId,
        updatedBy: actorId,
      })
      .returning();

    if (dto.collaboratorIds?.length) {
      await tx.insert(apexWorkItemCollaborators).values(
        dto.collaboratorIds.map((oid) => ({ workItemId: row.id, userOid: oid })),
      );
    }

    await appendEvent(tx, row.id, actorId, 'created');
    await reRankColumn(tx, project, row.status as ApexWorkItemStatus);

    return toApexWorkItem(row);
  });
  emitBoardChange(project, { action: 'created', itemId: item.id });
  return item;
}

// â”€â”€ Process 1 â€” Materialize from PRD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function materializeFromPrd(
  actorId: string,
  dto: MaterializeFromPrdDTO,
): Promise<ApexWorkItem[]> {
  if (!dto.backlogItemIds.length) throw httpError('No backlog items selected');
  throw httpError('backlogItems metadata must be supplied via API payload â€” use materializeFromPrdWithItems', 400);
}

export interface BacklogItemMeta {
  id: string;
  title: string;
  description: string;
  type: ApexWorkItemType;
  acceptanceCriteria: string[];
  epicId?: string;
  epicTitle?: string;
  featureId?: string;
  featureTitle?: string;
}

export async function previewMaterializeFromPrd(
  dto: MaterializeFromPrdDTO & { items: BacklogItemMeta[] },
): Promise<MaterializePreviewResult> {
  const project = requireProject(dto.project);
  if (!dto.items.length) throw httpError('No items to materialize');

  const featureRequestId = await resolveFeatureRequestIdForPrd(dto.prdId);

  const alreadyRows = await db
    .select()
    .from(apexWorkItems)
    .where(
      and(
        eq(apexWorkItems.project, project),
        eq(apexWorkItems.prdId, dto.prdId),
        not(isNull(apexWorkItems.backlogItemId)),
      ),
    );
  const alreadyByBacklogId = new Map(
    alreadyRows.filter((r) => r.backlogItemId).map((r) => [r.backlogItemId!, r]),
  );

  const frCandidates = featureRequestId
    ? await db
        .select()
        .from(apexWorkItems)
        .where(
          and(
            eq(apexWorkItems.project, project),
            eq(apexWorkItems.featureRequestId, featureRequestId),
            inArray(apexWorkItems.status, EARLY_STATUSES),
          ),
        )
    : [];

  const claimedIds = new Set<string>();
  const leaves: MaterializePlanLeaf[] = dto.items.map((item) => {
    const existing = alreadyByBacklogId.get(item.id);
    if (existing) {
      claimedIds.add(existing.id);
      return {
        backlogItemId: item.id,
        title: item.title,
        type: item.type,
        action: 'skip' as const,
        suggestedWorkItemId: existing.id,
        candidates: [{
          id: existing.id,
          itemNumber: existing.itemNumber,
          title: existing.title,
          type: existing.type as ApexWorkItemType,
          status: existing.status as ApexWorkItemStatus,
          sourceType: existing.sourceType as MaterializePlanLeaf['candidates'][0]['sourceType'],
        }],
        epicTitle: item.epicTitle ?? null,
        featureTitle: item.featureTitle ?? null,
      };
    }

    const norm = normalizeTitle(item.title);
    const matches = frCandidates.filter(
      (c) =>
        !claimedIds.has(c.id)
        && !c.backlogItemId
        && c.type === item.type
        && normalizeTitle(c.title) === norm,
    );

    if (matches.length === 1) {
      claimedIds.add(matches[0].id);
      return {
        backlogItemId: item.id,
        title: item.title,
        type: item.type,
        action: 'link' as const,
        suggestedWorkItemId: matches[0].id,
        candidates: matches.map((m) => ({
          id: m.id,
          itemNumber: m.itemNumber,
          title: m.title,
          type: m.type as ApexWorkItemType,
          status: m.status as ApexWorkItemStatus,
          sourceType: m.sourceType as MaterializePlanLeaf['candidates'][0]['sourceType'],
        })),
        epicTitle: item.epicTitle ?? null,
        featureTitle: item.featureTitle ?? null,
      };
    }

    if (matches.length > 1) {
      return {
        backlogItemId: item.id,
        title: item.title,
        type: item.type,
        action: 'choose' as const,
        suggestedWorkItemId: matches[0].id,
        candidates: matches.map((m) => ({
          id: m.id,
          itemNumber: m.itemNumber,
          title: m.title,
          type: m.type as ApexWorkItemType,
          status: m.status as ApexWorkItemStatus,
          sourceType: m.sourceType as MaterializePlanLeaf['candidates'][0]['sourceType'],
        })),
        epicTitle: item.epicTitle ?? null,
        featureTitle: item.featureTitle ?? null,
      };
    }

    // Soft matches: same type + FR, early status, no backlog id (for picker)
    const soft = frCandidates.filter(
      (c) => !claimedIds.has(c.id) && !c.backlogItemId && c.type === item.type,
    );
    if (soft.length > 0) {
      return {
        backlogItemId: item.id,
        title: item.title,
        type: item.type,
        action: 'choose' as const,
        suggestedWorkItemId: null,
        candidates: soft.map((m) => ({
          id: m.id,
          itemNumber: m.itemNumber,
          title: m.title,
          type: m.type as ApexWorkItemType,
          status: m.status as ApexWorkItemStatus,
          sourceType: m.sourceType as MaterializePlanLeaf['candidates'][0]['sourceType'],
        })),
        epicTitle: item.epicTitle ?? null,
        featureTitle: item.featureTitle ?? null,
      };
    }

    return {
      backlogItemId: item.id,
      title: item.title,
      type: item.type,
      action: 'create' as const,
      suggestedWorkItemId: null,
      candidates: [],
      epicTitle: item.epicTitle ?? null,
      featureTitle: item.featureTitle ?? null,
    };
  });

  const counts = { skip: 0, link: 0, create: 0, choose: 0 };
  for (const leaf of leaves) counts[leaf.action] += 1;

  return { featureRequestId, leaves, counts };
}

export async function materializeFromPrdWithItems(
  actorId: string,
  dto: MaterializeFromPrdDTO & { items: BacklogItemMeta[] },
): Promise<MaterializeResult> {
  const project = requireProject(dto.project);
  if (!dto.items.length) throw httpError('No items to materialize');

  const preview = await previewMaterializeFromPrd(dto);
  const featureRequestId = preview.featureRequestId;
  const choices = dto.linkChoices ?? {};

  type Resolved =
    | { kind: 'skip'; item: BacklogItemMeta }
    | { kind: 'link'; item: BacklogItemMeta; workItemId: string }
    | { kind: 'create'; item: BacklogItemMeta };

  const resolved: Resolved[] = [];
  for (const item of dto.items) {
    const plan = preview.leaves.find((l) => l.backlogItemId === item.id);
    const choice = choices[item.id];
    if (choice === 'skip' || plan?.action === 'skip') {
      resolved.push({ kind: 'skip', item });
      continue;
    }
    if (choice === 'create') {
      resolved.push({ kind: 'create', item });
      continue;
    }
    if (typeof choice === 'string' && choice !== 'create' && choice !== 'skip') {
      resolved.push({ kind: 'link', item, workItemId: choice });
      continue;
    }
    if (plan?.action === 'link' && plan.suggestedWorkItemId) {
      resolved.push({ kind: 'link', item, workItemId: plan.suggestedWorkItemId });
      continue;
    }
    if (plan?.action === 'choose') {
      throw httpError(
        `Ambiguous match for "${item.title}" â€” choose a board item, Create new, or Skip`,
        400,
      );
    }
    resolved.push({ kind: 'create', item });
  }

  if (!resolved.some((r) => r.kind === 'create' || r.kind === 'link')) {
    throw httpError('All selected items are already on the board', 409);
  }

  const created: ApexWorkItem[] = [];
  const linked: ApexWorkItem[] = [];
  let skipped = 0;

  const designLinkCache = new Map<string, { designDocId: string | null; designPrototypeId: string | null }>();
  async function designLinksFor(item: BacklogItemMeta) {
    const key = `${item.featureId ?? ''}|${item.featureTitle ?? ''}`;
    const cached = designLinkCache.get(key);
    if (cached) return cached;
    const resolvedLinks = await resolveDesignLinksForFeature({
      prdId: dto.prdId,
      featureId: item.featureId,
      featureTitle: item.featureTitle,
    });
    designLinkCache.set(key, resolvedLinks);
    return resolvedLinks;
  }

  await db.transaction(async (tx) => {
    for (const step of resolved) {
      if (step.kind === 'skip') {
        skipped += 1;
        continue;
      }

      const ac = step.item.acceptanceCriteria.map((text, i) => ({
        id: `ac-${Date.now()}-${i}`,
        text,
        done: false,
      }));
      const designLinks = await designLinksFor(step.item);

      if (step.kind === 'link') {
        const existing = await tx.query.apexWorkItems.findFirst({
          where: and(eq(apexWorkItems.id, step.workItemId), eq(apexWorkItems.project, project)),
        });
        if (!existing) throw httpError(`Work item ${step.workItemId} not found`, 404);

        const refreshFields = EARLY_STATUSES.includes(existing.status as ApexWorkItemStatus);
        const [row] = await tx
          .update(apexWorkItems)
          .set({
            ...(refreshFields
              ? {
                  title: step.item.title,
                  outcome: step.item.description,
                  acceptanceCriteria: ac,
                  type: step.item.type,
                }
              : {}),
            sourceType: existing.sourceType === 'feature_request' ? 'feature_request' : 'prd',
            prdId: dto.prdId,
            backlogItemId: step.item.id,
            featureRequestId: featureRequestId ?? existing.featureRequestId,
            epicId: step.item.epicId ?? null,
            epicTitle: step.item.epicTitle ?? null,
            featureId: step.item.featureId ?? null,
            featureTitle: step.item.featureTitle ?? null,
            designDocId: designLinks.designDocId ?? existing.designDocId ?? null,
            designPrototypeId: designLinks.designPrototypeId ?? existing.designPrototypeId ?? null,
            updatedBy: actorId,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(apexWorkItems.id, step.workItemId))
          .returning();

        await appendEvent(tx, row.id, actorId, 'linked', {
          details: {
            sourceType: 'prd',
            prdId: dto.prdId,
            backlogItemId: step.item.id,
            featureRequestId,
            designDocId: designLinks.designDocId,
            reconcile: 'link',
          },
        });
        linked.push(await toApexWorkItem(row));
        continue;
      }

      const itemNumber = await nextItemNumber(project, tx);
      const [row] = await tx
        .insert(apexWorkItems)
        .values({
          project,
          itemNumber,
          title: step.item.title,
          outcome: step.item.description,
          type: step.item.type,
          status: 'ready',
          ownerOid: dto.ownerId,
          acceptanceCriteria: ac,
          position: 9999,
          sourceType: 'prd',
          prdId: dto.prdId,
          backlogItemId: step.item.id,
          featureRequestId,
          epicId: step.item.epicId ?? null,
          epicTitle: step.item.epicTitle ?? null,
          featureId: step.item.featureId ?? null,
          featureTitle: step.item.featureTitle ?? null,
          designDocId: designLinks.designDocId,
          designPrototypeId: designLinks.designPrototypeId,
          createdBy: actorId,
          updatedBy: actorId,
        })
        .returning();

      await appendEvent(tx, row.id, actorId, 'created', {
        details: {
          sourceType: 'prd',
          prdId: dto.prdId,
          backlogItemId: step.item.id,
          featureRequestId,
          designDocId: designLinks.designDocId,
        },
      });
      created.push(await toApexWorkItem(row));
    }
    await reRankColumn(tx, project, 'ready');
  });

  emitBoardChange(project, {
    action: 'materialized',
    itemIds: [...created, ...linked].map((c) => c.id),
  });
  return { created, linked, skipped };
}

// â”€â”€ Process 2 â€” AI generate drafts from Feature Request â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function buildGenerateDraftPrompt(
  fr: { title: string; request: string; advantage: string | null },
  grain: 'single' | 'small-set',
): string {
  const count = grain === 'single' ? '1' : '2 to 4';
  return [
    `You are a senior product manager. Given this Feature Request, generate ${count} concise work item(s) that represent the delivery tasks.`,
    '',
    `Feature Request title: ${fr.title}`,
    `What they want: ${fr.request}`,
    fr.advantage ? `Why it matters: ${fr.advantage}` : '',
    '',
    'Output ONLY valid JSON (no code fences, no explanation):',
    '[{ "title": "...", "outcome": "...", "type": "PBI|TBI|Bug", "acceptanceCriteria": ["Given: ...\\nWhen: ...\\nThen: ...", "..."] }]',
    '',
    'Rules:',
    '- title: short imperative phrase',
    '- outcome (description): MUST use Mike Cohn user-story format on one or three lines:',
    '  "As a <role>, I want <capability>, So that <benefit>"',
    '  Prefer three lines: "As a <role>\\nI want <capability>\\nSo that <benefit>"',
    '  PBI â†’ end-user role; TBI â†’ developer/system role; Bug â†’ affected user role',
    '- type: PBI for user-facing, TBI for technical, Bug for defect',
    '- acceptanceCriteria: 2-4 items; EACH item MUST use Given: / When: / Then: (with colons) on separate lines',
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}

export async function generateDraftsFromFeatureRequest(
  dto: GenerateFromFeatureRequestDTO,
): Promise<ApexWorkItemDraft[]> {
  requireProject(dto.project);
  const fr = await db.query.featureRequests.findFirst({
    where: eq(featureRequests.id, dto.featureRequestId),
  });
  if (!fr) throw httpError('Feature request not found', 404);

  const prompt = buildGenerateDraftPrompt(fr, dto.grain);

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { CursorSDK } = require('@cursor/sdk') as { CursorSDK: any };
    const sdk = new CursorSDK();
    const response = await sdk.completion({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: prompt }],
    });
    const text: string = response?.choices?.[0]?.message?.content ?? response?.content ?? '';
    const parsed = JSON.parse(text.trim()) as Array<{
      title: string;
      outcome: string;
      type: string;
      acceptanceCriteria: string[];
    }>;
    return parsed.map((d, i) => ({
      id: `draft-${Date.now()}-${i}`,
      title: d.title,
      outcome: d.outcome,
      type: (['PBI', 'TBI', 'Bug', 'Epic', 'Feature'].includes(d.type) ? d.type : 'PBI') as ApexWorkItemType,
      acceptanceCriteria: (d.acceptanceCriteria ?? []).map((text) => ({ text, done: false })),
    }));
  } catch {
    const given = fr.request?.trim() || fr.title;
    const benefit = fr.advantage?.trim() || 'I can complete this work efficiently';
    return [
      {
        id: `draft-${Date.now()}-0`,
        title: fr.title,
        outcome: ['As a user', `I want ${given.slice(0, 160)}`, `So that ${benefit}`].join('\n'),
        type: 'PBI',
        acceptanceCriteria: [
          {
            text: [
              `Given: a user working on "${fr.title}"`,
              `When: they complete the requested behavior (${given.slice(0, 160)})`,
              fr.advantage
                ? `Then: the outcome is achieved â€” ${fr.advantage}`
                : 'Then: the feature behaves as described and key steps are verifiable end-to-end',
            ].join('\n'),
            done: false,
          },
        ],
      },
    ];
  }
}

export async function previewCreateFromDrafts(
  dto: Pick<CreateFromDraftsDTO, 'project' | 'featureRequestId' | 'drafts'>,
): Promise<DraftReconcilePreviewResult> {
  const project = requireProject(dto.project);
  const existing = await db
    .select()
    .from(apexWorkItems)
    .where(
      and(
        eq(apexWorkItems.project, project),
        eq(apexWorkItems.featureRequestId, dto.featureRequestId),
      ),
    );

  const claimed = new Set<string>();
  const items = dto.drafts.map((draft) => {
    const draftId = (draft as CreateApexWorkItemDTO & { id?: string }).id
      ?? `draft-${normalizeTitle(draft.title)}-${draft.type}`;
    const norm = normalizeTitle(draft.title);
    const exact = existing.filter(
      (e) =>
        !claimed.has(e.id)
        && e.type === draft.type
        && normalizeTitle(e.title) === norm,
    );
    if (exact.length === 1) {
      claimed.add(exact[0].id);
      return {
        draftId,
        title: draft.title,
        type: draft.type,
        action: 'skip' as const,
        suggestedWorkItemId: exact[0].id,
        candidates: exact.map((m) => ({
          id: m.id,
          itemNumber: m.itemNumber,
          title: m.title,
          type: m.type as ApexWorkItemType,
          status: m.status as ApexWorkItemStatus,
          sourceType: m.sourceType as DraftReconcilePreviewResult['items'][0]['candidates'][0]['sourceType'],
          backlogItemId: m.backlogItemId,
        })),
      };
    }
    if (exact.length > 1) {
      return {
        draftId,
        title: draft.title,
        type: draft.type,
        action: 'choose' as const,
        suggestedWorkItemId: exact[0].id,
        candidates: exact.map((m) => ({
          id: m.id,
          itemNumber: m.itemNumber,
          title: m.title,
          type: m.type as ApexWorkItemType,
          status: m.status as ApexWorkItemStatus,
          sourceType: m.sourceType as DraftReconcilePreviewResult['items'][0]['candidates'][0]['sourceType'],
          backlogItemId: m.backlogItemId,
        })),
      };
    }
    return {
      draftId,
      title: draft.title,
      type: draft.type,
      action: 'create' as const,
      suggestedWorkItemId: null,
      candidates: [],
    };
  });

  const counts = { skip: 0, link: 0, create: 0, choose: 0 };
  for (const item of items) counts[item.action] += 1;
  return { items, counts };
}

export async function createFromDrafts(
  actorId: string,
  dto: CreateFromDraftsDTO,
): Promise<CreateFromDraftsResult> {
  const project = requireProject(dto.project);
  const fr = await db.query.featureRequests.findFirst({
    where: eq(featureRequests.id, dto.featureRequestId),
  });
  if (!fr) throw httpError('Feature request not found', 404);

  const draftsWithIds = dto.drafts.map((d, i) => ({
    ...d,
    id: (d as CreateApexWorkItemDTO & { id?: string }).id ?? `draft-${Date.now()}-${i}`,
  }));
  const preview = await previewCreateFromDrafts({
    project: dto.project,
    featureRequestId: dto.featureRequestId,
    drafts: draftsWithIds,
  });
  const choices = dto.linkChoices ?? {};

  const created: ApexWorkItem[] = [];
  const linked: ApexWorkItem[] = [];
  let skipped = 0;

  await db.transaction(async (tx) => {
    for (const draft of draftsWithIds) {
      const plan = preview.items.find((p) => p.draftId === draft.id);
      const choice = choices[draft.id];
      const action = choice === 'create'
        ? 'create'
        : choice === 'skip'
          ? 'skip'
          : typeof choice === 'string'
            ? 'link'
            : plan?.action === 'skip'
              ? 'skip'
              : plan?.action === 'choose'
                ? 'choose'
                : 'create';

      if (action === 'choose') {
        throw httpError(`Ambiguous match for draft "${draft.title}" â€” choose Link, Create, or Skip`, 400);
      }
      if (action === 'skip') {
        skipped += 1;
        continue;
      }
      if (action === 'link') {
        const targetId = typeof choice === 'string' && choice !== 'create' && choice !== 'skip'
          ? choice
          : plan?.suggestedWorkItemId;
        if (!targetId) throw httpError(`No link target for draft "${draft.title}"`, 400);
        const [row] = await tx
          .update(apexWorkItems)
          .set({
            featureRequestId: dto.featureRequestId,
            updatedBy: actorId,
            updatedAt: new Date().toISOString(),
          })
          .where(and(eq(apexWorkItems.id, targetId), eq(apexWorkItems.project, project)))
          .returning();
        if (!row) throw httpError(`Work item ${targetId} not found`, 404);
        await appendEvent(tx, row.id, actorId, 'linked', {
          details: { sourceType: 'feature_request', featureRequestId: dto.featureRequestId, reconcile: 'link' },
        });
        linked.push(await toApexWorkItem(row));
        continue;
      }

      const itemNumber = await nextItemNumber(project, tx);
      const [row] = await tx
        .insert(apexWorkItems)
        .values({
          project,
          itemNumber,
          title: draft.title,
          outcome: draft.outcome,
          type: draft.type,
          status: 'ready',
          ownerOid: dto.ownerId,
          acceptanceCriteria: draft.acceptanceCriteria
            ? acWithIds(draft.acceptanceCriteria as Omit<AcceptanceCriterion, 'id'>[])
            : [],
          position: 9999,
          sourceType: 'feature_request',
          featureRequestId: dto.featureRequestId,
          createdBy: actorId,
          updatedBy: actorId,
        })
        .returning();

      if (dto.collaboratorIds?.length) {
        await tx.insert(apexWorkItemCollaborators).values(
          dto.collaboratorIds.map((oid) => ({ workItemId: row.id, userOid: oid })),
        );
      }

      await appendEvent(tx, row.id, actorId, 'created', {
        details: { sourceType: 'feature_request', featureRequestId: dto.featureRequestId },
      });
      created.push(await toApexWorkItem(row));
    }

    await reRankColumn(tx, project, 'ready');

    const allLinkedIds = [...created, ...linked].map((c) => c.id);
    const prior = await tx
      .select({ id: apexWorkItems.id })
      .from(apexWorkItems)
      .where(
        and(
          eq(apexWorkItems.featureRequestId, dto.featureRequestId),
          allLinkedIds.length ? not(inArray(apexWorkItems.id, allLinkedIds)) : sql`true`,
        ),
      );
    if (prior.length === 0 && created.length > 0 && fr.status !== 'declined') {
      await tx
        .update(featureRequests)
        .set({ status: 'planned', updatedAt: new Date().toISOString() })
        .where(eq(featureRequests.id, dto.featureRequestId));
    }
  });

  emitBoardChange(project, {
    action: 'created_from_drafts',
    itemIds: [...created, ...linked].map((c) => c.id),
  });
  return { created, linked, skipped };
}

// â”€â”€ Update â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function updateApexWorkItem(
  id: string,
  actorId: string,
  dto: UpdateApexWorkItemDTO,
  project?: string,
): Promise<ApexWorkItem> {
  const existing = await db.query.apexWorkItems.findFirst({ where: eq(apexWorkItems.id, id) });
  if (!existing) throw httpError('Work item not found', 404);
  if (project && existing.project !== project) throw httpError('Work item not found', 404);

  const set: Partial<typeof apexWorkItems.$inferInsert> = {
    updatedBy: actorId,
    updatedAt: new Date().toISOString(),
  };
  const details: Record<string, unknown> = {};

  if (dto.title !== undefined) { set.title = dto.title; details.title = dto.title; }
  if (dto.outcome !== undefined) { set.outcome = dto.outcome; }
  if (dto.type !== undefined) { set.type = dto.type; }
  if (dto.branch !== undefined) { set.branch = dto.branch; }
  if (dto.prUrl !== undefined) { set.prUrl = dto.prUrl; }
  if (dto.dueDate !== undefined) { set.dueDate = dto.dueDate; }
  if (dto.parentId !== undefined) { set.parentId = dto.parentId; }
  if (dto.acceptanceCriteria !== undefined) { set.acceptanceCriteria = dto.acceptanceCriteria; }

  const ownerChanged = dto.ownerId !== undefined && dto.ownerId !== existing.ownerOid;
  if (dto.ownerId !== undefined) { set.ownerOid = dto.ownerId; }

  const releaseChanged = dto.releaseId !== undefined && dto.releaseId !== existing.releaseId;
  if (dto.releaseId !== undefined) { set.releaseId = dto.releaseId; }

  await db.transaction(async (tx) => {
    await tx.update(apexWorkItems).set(set).where(eq(apexWorkItems.id, id));

    if (dto.collaboratorIds !== undefined) {
      await tx.delete(apexWorkItemCollaborators).where(eq(apexWorkItemCollaborators.workItemId, id));
      if (dto.collaboratorIds.length) {
        await tx.insert(apexWorkItemCollaborators).values(
          dto.collaboratorIds.map((oid) => ({ workItemId: id, userOid: oid })),
        );
      }
    }

    if (ownerChanged) {
      await appendEvent(tx, id, actorId, 'assigned', {
        details: { previousOwner: existing.ownerOid, newOwner: dto.ownerId! },
      });
    } else if (releaseChanged) {
      await appendEvent(tx, id, actorId, 'release_set', {
        details: { previousReleaseId: existing.releaseId, newReleaseId: dto.releaseId },
      });
    } else if (Object.keys(details).length) {
      await appendEvent(tx, id, actorId, 'updated', { details });
    }
  });

  if (ownerChanged && dto.ownerId !== actorId) {
    const actorName = await resolveActorName(actorId);
    createNotification(dto.ownerId!, {
      type: 'user-action',
      title: 'Work item assigned to you',
      body: `${actorName} assigned "${existing.title}" (APX-${existing.itemNumber}) to you`,
      link: `/work-board?item=${id}`,
    }).catch(() => {});
  }

  const updated = await db.query.apexWorkItems.findFirst({ where: eq(apexWorkItems.id, id) });
  const item = await toApexWorkItem(updated!);
  emitBoardChange(existing.project, { action: 'updated', itemId: id });
  return item;
}

// â”€â”€ Move â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function moveApexWorkItem(
  id: string,
  actorId: string,
  dto: MoveApexWorkItemDTO,
  project?: string,
): Promise<ApexWorkItem> {
  const existing = await db.query.apexWorkItems.findFirst({ where: eq(apexWorkItems.id, id) });
  if (!existing) throw httpError('Work item not found', 404);
  if (project && existing.project !== project) throw httpError('Work item not found', 404);

  const fromStatus = existing.status as ApexWorkItemStatus;
  const toStatus = dto.targetStatus;

  await db.transaction(async (tx) => {
    await tx
      .update(apexWorkItems)
      .set({
        status: toStatus,
        position: dto.targetPosition ?? 9999,
        updatedBy: actorId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(apexWorkItems.id, id));

    await appendEvent(tx, id, actorId, 'moved', { fromStatus, toStatus });
    await reRankColumn(tx, existing.project, fromStatus);
    if (fromStatus !== toStatus) await reRankColumn(tx, existing.project, toStatus);
  });

  if (toStatus === 'done' && existing.featureRequestId) {
    const fr = await db.query.featureRequests.findFirst({
      where: eq(featureRequests.id, existing.featureRequestId),
    });
    if (fr && fr.status !== 'declined') {
      const notDone = await db
        .select({ id: apexWorkItems.id })
        .from(apexWorkItems)
        .where(
          and(
            eq(apexWorkItems.featureRequestId, existing.featureRequestId),
            ne(apexWorkItems.id, id),
            not(eq(apexWorkItems.status, 'done')),
          ),
        );
      if (notDone.length === 0) {
        await db
          .update(featureRequests)
          .set({ status: 'done', updatedAt: new Date().toISOString() })
          .where(eq(featureRequests.id, existing.featureRequestId));
      }
    }
  }

  if (fromStatus === 'done' && toStatus !== 'done' && existing.featureRequestId) {
    const fr = await db.query.featureRequests.findFirst({
      where: eq(featureRequests.id, existing.featureRequestId),
    });
    if (fr?.status === 'done') {
      await db
        .update(featureRequests)
        .set({ status: 'planned', updatedAt: new Date().toISOString() })
        .where(eq(featureRequests.id, existing.featureRequestId));
    }
  }

  // Notify owner of state change (skip self)
  if (fromStatus !== toStatus && existing.ownerOid !== actorId) {
    const actorName = await resolveActorName(actorId);
    createNotification(existing.ownerOid, {
      type: 'user-action',
      title: 'Work item status changed',
      body: `${actorName} moved "${existing.title}" to ${toStatus}`,
      link: `/work-board?item=${id}`,
    }).catch(() => {});
  }

  const updated = await db.query.apexWorkItems.findFirst({ where: eq(apexWorkItems.id, id) });
  const item = await toApexWorkItem(updated!);
  emitBoardChange(existing.project, { action: 'moved', itemId: id, fromStatus, toStatus });
  return item;
}

// â”€â”€ Bulk update â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function bulkUpdateApexWorkItems(
  actorId: string,
  project: string,
  dto: BulkUpdateApexWorkItemsDTO,
): Promise<ApexWorkItem[]> {
  const p = requireProject(project);
  if (!dto.ids?.length) throw httpError('ids required');
  const results: ApexWorkItem[] = [];
  for (const id of dto.ids) {
    if (dto.targetStatus) {
      results.push(await moveApexWorkItem(id, actorId, { targetStatus: dto.targetStatus }, p));
    }
    if (dto.ownerId !== undefined || dto.releaseId !== undefined) {
      results.push(await updateApexWorkItem(id, actorId, {
        ownerId: dto.ownerId,
        releaseId: dto.releaseId,
      }, p));
    }
  }
  emitBoardChange(p, { action: 'bulk', itemIds: dto.ids });
  return results;
}

// â”€â”€ Comments â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function listComments(workItemId: string, project: string): Promise<ApexWorkItemComment[]> {
  const rows = await db
    .select({
      id: apexWorkItemComments.id,
      workItemId: apexWorkItemComments.workItemId,
      project: apexWorkItemComments.project,
      body: apexWorkItemComments.body,
      createdAt: apexWorkItemComments.createdAt,
      updatedAt: apexWorkItemComments.updatedAt,
      oid: appUsers.oid,
      displayName: appUsers.displayName,
      email: appUsers.email,
    })
    .from(apexWorkItemComments)
    .innerJoin(appUsers, eq(apexWorkItemComments.authorOid, appUsers.oid))
    .where(and(eq(apexWorkItemComments.workItemId, workItemId), eq(apexWorkItemComments.project, project)))
    .orderBy(asc(apexWorkItemComments.createdAt));

  return rows.map((r) => ({
    id: r.id,
    workItemId: r.workItemId,
    project: r.project,
    author: toOwnerSummary(r),
    body: r.body,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function addComment(
  workItemId: string,
  actorId: string,
  project: string,
  body: string,
): Promise<ApexWorkItemComment> {
  const p = requireProject(project);
  if (!body?.trim()) throw httpError('body is required');
  const item = await db.query.apexWorkItems.findFirst({
    where: and(eq(apexWorkItems.id, workItemId), eq(apexWorkItems.project, p)),
  });
  if (!item) throw httpError('Work item not found', 404);

  const [row] = await db
    .insert(apexWorkItemComments)
    .values({
      workItemId,
      project: p,
      authorOid: actorId,
      body: body.trim(),
    })
    .returning();

  await appendEvent(db, workItemId, actorId, 'commented', { details: { commentId: row.id } });

  // Mention detection: @DisplayName or bare emails â€” notify mentioned project members
  const mentionPattern = /@([A-Za-z0-9._+-]+(?:\s+[A-Za-z0-9._+-]+)?)/g;
  const owners = await listEligibleOwners(p);
  const actorName = await resolveActorName(actorId);
  let match: RegExpExecArray | null;
  const notified = new Set<string>();
  while ((match = mentionPattern.exec(body)) !== null) {
    const token = match[1].toLowerCase();
    const target = owners.find(
      (o) =>
        o.displayName.toLowerCase().includes(token) ||
        o.email.toLowerCase().startsWith(token),
    );
    if (target && target.oid !== actorId && !notified.has(target.oid)) {
      notified.add(target.oid);
      createNotification(target.oid, {
        type: 'user-action',
        title: 'You were mentioned',
        body: `${actorName} mentioned you on APX-${item.itemNumber}`,
        link: `/work-board?item=${workItemId}`,
      }).catch(() => {});
      await appendEvent(db, workItemId, actorId, 'mentioned', {
        details: { mentionedUserId: target.oid },
      });
    }
  }

  if (item.ownerOid !== actorId) {
    createNotification(item.ownerOid, {
      type: 'user-action',
      title: 'New comment on your work item',
      body: `${actorName} commented on APX-${item.itemNumber}`,
      link: `/work-board?item=${workItemId}`,
    }).catch(() => {});
  }

  const author = await resolveOwnerSummary(actorId);
  emitBoardChange(p, { action: 'commented', itemId: workItemId });
  return {
    id: row.id,
    workItemId: row.workItemId,
    project: row.project,
    author,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// â”€â”€ Attachments (disk under data root, or external URL) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function isExternalAttachmentUrl(storagePath: string): boolean {
  return /^https?:\/\//i.test(storagePath);
}

function attachmentOpenUrl(workItemId: string, attachmentId: string, project: string, storagePath: string): string {
  if (isExternalAttachmentUrl(storagePath)) return storagePath;
  return `/api/apex-work-items/${workItemId}/attachments/${attachmentId}/content?project=${encodeURIComponent(project)}`;
}

function boardAttachmentsRoot(): string {
  return path.join(resolveDataRoot(), 'board-attachments');
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 180) || 'file';
}

export async function listAttachments(workItemId: string, project: string): Promise<ApexWorkItemAttachment[]> {
  const rows = await db
    .select({
      id: apexWorkItemAttachments.id,
      workItemId: apexWorkItemAttachments.workItemId,
      project: apexWorkItemAttachments.project,
      fileName: apexWorkItemAttachments.fileName,
      contentType: apexWorkItemAttachments.contentType,
      byteSize: apexWorkItemAttachments.byteSize,
      storagePath: apexWorkItemAttachments.storagePath,
      createdAt: apexWorkItemAttachments.createdAt,
      oid: appUsers.oid,
      displayName: appUsers.displayName,
      email: appUsers.email,
    })
    .from(apexWorkItemAttachments)
    .innerJoin(appUsers, eq(apexWorkItemAttachments.uploadedBy, appUsers.oid))
    .where(and(eq(apexWorkItemAttachments.workItemId, workItemId), eq(apexWorkItemAttachments.project, project)))
    .orderBy(desc(apexWorkItemAttachments.createdAt));

  return rows.map((r) => ({
    id: r.id,
    workItemId: r.workItemId,
    project: r.project,
    fileName: r.fileName,
    contentType: r.contentType,
    byteSize: r.byteSize,
    storagePath: r.storagePath,
    uploadedBy: toOwnerSummary(r),
    createdAt: r.createdAt,
    openUrl: attachmentOpenUrl(r.workItemId, r.id, r.project, r.storagePath),
  }));
}

export async function addAttachmentMeta(
  workItemId: string,
  actorId: string,
  project: string,
  meta: {
    fileName: string;
    contentType: string;
    byteSize: number;
    storagePath?: string;
    contentBase64?: string;
  },
): Promise<ApexWorkItemAttachment> {
  const p = requireProject(project);
  const item = await db.query.apexWorkItems.findFirst({
    where: and(eq(apexWorkItems.id, workItemId), eq(apexWorkItems.project, p)),
  });
  if (!item) throw httpError('Work item not found', 404);
  if (!meta.fileName?.trim()) throw httpError('fileName is required');

  let storagePath = meta.storagePath?.trim() ?? '';
  let byteSize = meta.byteSize ?? 0;

  if (meta.contentBase64) {
    const buf = Buffer.from(meta.contentBase64, 'base64');
    if (!buf.length) throw httpError('contentBase64 is empty');
    if (buf.length > MAX_BOARD_ATTACHMENT_BYTES) {
      throw httpError(`Attachment exceeds ${MAX_BOARD_ATTACHMENT_BYTES / (1024 * 1024)}MB limit`, 413);
    }
    const safeName = sanitizeFileName(meta.fileName.trim());
    const rel = path.join(p, workItemId, `${randomUUID()}-${safeName}`);
    const abs = path.join(boardAttachmentsRoot(), rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buf);
    storagePath = path.join('board-attachments', rel).replace(/\\/g, '/');
    byteSize = buf.length;
  } else if (!storagePath) {
    throw httpError('storagePath or contentBase64 is required');
  } else if (!isExternalAttachmentUrl(storagePath) && !storagePath.startsWith('/')) {
    // Allow absolute app paths; reject opaque non-URL paths without bytes.
    if (!storagePath.startsWith('board-attachments/')) {
      throw httpError('storagePath must be an http(s) URL or uploaded file content');
    }
  }

  const [row] = await db
    .insert(apexWorkItemAttachments)
    .values({
      workItemId,
      project: p,
      fileName: meta.fileName.trim(),
      contentType: meta.contentType || 'application/octet-stream',
      byteSize,
      storagePath,
      uploadedBy: actorId,
    })
    .returning();

  await appendEvent(db, workItemId, actorId, 'attachment_added', {
    details: { attachmentId: row.id, fileName: meta.fileName },
  });

  const uploader = await resolveOwnerSummary(actorId);
  emitBoardChange(p, { action: 'attachment_added', itemId: workItemId });
  return {
    id: row.id,
    workItemId: row.workItemId,
    project: row.project,
    fileName: row.fileName,
    contentType: row.contentType,
    byteSize: row.byteSize,
    storagePath: row.storagePath,
    uploadedBy: uploader,
    createdAt: row.createdAt,
    openUrl: attachmentOpenUrl(row.workItemId, row.id, row.project, row.storagePath),
  };
}

export async function resolveAttachmentContent(
  workItemId: string,
  attachmentId: string,
  project: string,
): Promise<{ kind: 'redirect'; url: string } | { kind: 'file'; absPath: string; contentType: string; fileName: string }> {
  const p = requireProject(project);
  const row = await db.query.apexWorkItemAttachments.findFirst({
    where: and(
      eq(apexWorkItemAttachments.id, attachmentId),
      eq(apexWorkItemAttachments.workItemId, workItemId),
      eq(apexWorkItemAttachments.project, p),
    ),
  });
  if (!row) throw httpError('Attachment not found', 404);

  if (isExternalAttachmentUrl(row.storagePath)) {
    return { kind: 'redirect', url: row.storagePath };
  }

  // storagePath is relative to data root, e.g. board-attachments/{project}/{itemId}/{file}
  const resolvedAbs = path.isAbsolute(row.storagePath)
    ? row.storagePath
    : path.join(resolveDataRoot(), row.storagePath);
  try {
    await fs.access(resolvedAbs);
  } catch {
    throw httpError('Attachment file missing on disk', 404);
  }
  return {
    kind: 'file',
    absPath: resolvedAbs,
    contentType: row.contentType || 'application/octet-stream',
    fileName: row.fileName,
  };
}

export async function removeAttachment(
  workItemId: string,
  attachmentId: string,
  actorId: string,
  project: string,
): Promise<void> {
  const p = requireProject(project);
  const item = await db.query.apexWorkItems.findFirst({
    where: and(eq(apexWorkItems.id, workItemId), eq(apexWorkItems.project, p)),
  });
  if (!item) throw httpError('Work item not found', 404);

  const row = await db.query.apexWorkItemAttachments.findFirst({
    where: and(
      eq(apexWorkItemAttachments.id, attachmentId),
      eq(apexWorkItemAttachments.workItemId, workItemId),
      eq(apexWorkItemAttachments.project, p),
    ),
  });
  if (!row) throw httpError('Attachment not found', 404);

  await db
    .delete(apexWorkItemAttachments)
    .where(eq(apexWorkItemAttachments.id, attachmentId));

  if (
    !isExternalAttachmentUrl(row.storagePath)
    && (row.storagePath.startsWith('board-attachments/') || path.isAbsolute(row.storagePath))
  ) {
    const abs = path.isAbsolute(row.storagePath)
      ? row.storagePath
      : path.join(resolveDataRoot(), row.storagePath);
    try {
      await fs.unlink(abs);
    } catch {
      // File may already be missing; DB row is gone so treat as success.
    }
  }

  await appendEvent(db, workItemId, actorId, 'attachment_removed', {
    details: { attachmentId, fileName: row.fileName },
  });
  emitBoardChange(p, { action: 'attachment_removed', itemId: workItemId });
}

// â”€â”€ Materialized item ids for a PRD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function getMaterializedItemIds(prdId: string, project?: string): Promise<string[]> {
  const conditions = [
    eq(apexWorkItems.prdId, prdId),
    not(isNull(apexWorkItems.backlogItemId)),
  ];
  if (project) conditions.push(eq(apexWorkItems.project, project));
  const rows = await db
    .select({ backlogItemId: apexWorkItems.backlogItemId })
    .from(apexWorkItems)
    .where(and(...conditions));
  return rows.map((r) => r.backlogItemId!);
}

// â”€â”€ Analytics helpers (for Planning re-base) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function getBoardEventStats(project: string, fromIso?: string, toIso?: string) {
  const p = requireProject(project);
  const conditions = [eq(apexWorkItems.project, p)];
  if (fromIso) conditions.push(sql`${apexWorkItemEvents.createdAt} >= ${fromIso}`);
  if (toIso) conditions.push(sql`${apexWorkItemEvents.createdAt} <= ${toIso}`);

  const rows = await db
    .select({
      action: apexWorkItemEvents.action,
      count: sql<number>`count(*)::int`,
    })
    .from(apexWorkItemEvents)
    .innerJoin(apexWorkItems, eq(apexWorkItemEvents.workItemId, apexWorkItems.id))
    .where(and(...conditions))
    .groupBy(apexWorkItemEvents.action);

  return rows;
}

export async function listAssignedToUser(project: string, ownerOid: string): Promise<ApexWorkItem[]> {
  return listApexWorkItems({
    project,
    ownerId: ownerOid,
    types: ['PBI', 'TBI', 'Bug', 'Feature'],
  });
}

// Keep unused import referenced for link table readiness
void apexWorkItemLinks;
