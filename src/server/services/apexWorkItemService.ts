import { and, asc, desc, eq, inArray, ne, not, isNull, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  appUsers,
  apexWorkItems,
  apexWorkItemCollaborators,
  apexWorkItemEvents,
  featureRequests,
  userProjectAssignments,
} from '../db/schema';
import { createNotification } from './notificationService';
import { getSuperAdminEmails } from '../utils/superAdmin';
import type {
  ApexWorkItem,
  ApexWorkItemDraft,
  ApexWorkItemEvent,
  ApexWorkItemFacets,
  ApexWorkItemFilters,
  ApexWorkItemStatus,
  ApexWorkItemType,
  AcceptanceCriterion,
  CreateApexWorkItemDTO,
  CreateFromDraftsDTO,
  GenerateFromFeatureRequestDTO,
  MaterializeFromPrdDTO,
  MoveApexWorkItemDTO,
  UpdateApexWorkItemDTO,
  WorkItemOwnerSummary,
} from '../../shared/types/apexWorkItem';

// ── Helpers ──────────────────────────────────────────────────────────────────

function httpError(msg: string, status = 400): Error {
  const e = new Error(msg);
  (e as Error & { status?: number }).status = status;
  return e;
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

async function resolveOwnerSummary(oid: string): Promise<WorkItemOwnerSummary> {
  const row = await db.query.appUsers.findFirst({ where: eq(appUsers.oid, oid) });
  if (!row) throw httpError(`User ${oid} not found`, 404);
  return toOwnerSummary(row);
}

async function resolveActorName(actorId: string): Promise<string> {
  const row = await db.query.appUsers.findFirst({ where: eq(appUsers.oid, actorId) });
  return row?.displayName ?? row?.email ?? actorId;
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
  status: ApexWorkItemStatus,
): Promise<void> {
  const rows = await tx
    .select({ id: apexWorkItems.id })
    .from(apexWorkItems)
    .where(eq(apexWorkItems.status, status))
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

async function toApexWorkItem(
  row: typeof apexWorkItems.$inferSelect,
  includeEvents = false,
): Promise<ApexWorkItem> {
  const owner = await resolveOwnerSummary(row.ownerOid);
  const collaborators = await loadCollaborators(row.id);
  const events = includeEvents ? await loadEvents(row.id) : undefined;
  return {
    id: row.id,
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
    sourceType: (row.sourceType ?? 'standalone') as ApexWorkItem['sourceType'],
    prdId: row.prdId ?? null,
    backlogItemId: row.backlogItemId ?? null,
    featureRequestId: row.featureRequestId ?? null,
    epicId: row.epicId ?? null,
    epicTitle: row.epicTitle ?? null,
    featureId: row.featureId ?? null,
    featureTitle: row.featureTitle ?? null,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(events !== undefined ? { events } : {}),
  };
}

// ── Eligible owners ───────────────────────────────────────────────────────────

export async function listEligibleOwners(): Promise<WorkItemOwnerSummary[]> {
  const adminEmails = getSuperAdminEmails().map((e) => e.toLowerCase());
  const apexAssignees = await db
    .select({ oid: appUsers.oid, displayName: appUsers.displayName, email: appUsers.email })
    .from(appUsers)
    .innerJoin(userProjectAssignments, eq(userProjectAssignments.userId, appUsers.oid))
    .where(eq(userProjectAssignments.project, 'Apex'));
  return apexAssignees
    .filter((u) => adminEmails.includes((u.email ?? '').toLowerCase()))
    .map(toOwnerSummary);
}

// ── Filter facets ─────────────────────────────────────────────────────────────

export async function listFilterFacets(): Promise<ApexWorkItemFacets> {
  const rows = await db
    .selectDistinct({ epicTitle: apexWorkItems.epicTitle, featureTitle: apexWorkItems.featureTitle })
    .from(apexWorkItems);
  const epicTitles = [...new Set(rows.map((r) => r.epicTitle).filter(Boolean) as string[])].sort();
  const featureTitles = [...new Set(rows.map((r) => r.featureTitle).filter(Boolean) as string[])].sort();
  const owners = await listEligibleOwners();
  return { epicTitles, featureTitles, owners };
}

// ── List ──────────────────────────────────────────────────────────────────────

export async function listApexWorkItems(filters: ApexWorkItemFilters = {}): Promise<ApexWorkItem[]> {
  const conditions = [];

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
  if (filters.search) {
    const term = `%${filters.search.toLowerCase()}%`;
    conditions.push(
      sql`(lower(${apexWorkItems.title}) like ${term} or lower(cast(${apexWorkItems.itemNumber} as text)) like ${term})`,
    );
  }

  const rows = await db
    .select()
    .from(apexWorkItems)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(apexWorkItems.status), asc(apexWorkItems.position));

  return Promise.all(rows.map((r) => toApexWorkItem(r)));
}

// ── Get by id ─────────────────────────────────────────────────────────────────

export async function getApexWorkItem(id: string): Promise<ApexWorkItem> {
  const row = await db.query.apexWorkItems.findFirst({ where: eq(apexWorkItems.id, id) });
  if (!row) throw httpError('Work item not found', 404);
  return toApexWorkItem(row, true);
}

// ── Create (standalone) ───────────────────────────────────────────────────────

export async function createApexWorkItem(
  actorId: string,
  dto: CreateApexWorkItemDTO,
): Promise<ApexWorkItem> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(apexWorkItems)
      .values({
        title: dto.title,
        outcome: dto.outcome,
        type: dto.type,
        status: dto.status ?? 'idea',
        ownerOid: dto.ownerId,
        acceptanceCriteria: dto.acceptanceCriteria ? acWithIds(dto.acceptanceCriteria) : [],
        branch: dto.branch ?? null,
        prUrl: dto.prUrl ?? null,
        position: 9999,
        sourceType: dto.sourceType ?? 'standalone',
        prdId: dto.prdId ?? null,
        backlogItemId: dto.backlogItemId ?? null,
        featureRequestId: dto.featureRequestId ?? null,
        epicId: dto.epicId ?? null,
        epicTitle: dto.epicTitle ?? null,
        featureId: dto.featureId ?? null,
        featureTitle: dto.featureTitle ?? null,
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
    await reRankColumn(tx, row.status as ApexWorkItemStatus);

    return toApexWorkItem(row);
  });
}

// ── Process 1 — Materialize from PRD ─────────────────────────────────────────

export async function materializeFromPrd(
  actorId: string,
  dto: MaterializeFromPrdDTO,
): Promise<ApexWorkItem[]> {
  if (!dto.backlogItemIds.length) throw httpError('No backlog items selected');

  const existing = await db
    .select({ backlogItemId: apexWorkItems.backlogItemId })
    .from(apexWorkItems)
    .where(
      and(
        eq(apexWorkItems.prdId, dto.prdId),
        not(isNull(apexWorkItems.backlogItemId)),
      ),
    );
  const alreadyMaterialized = new Set(existing.map((r) => r.backlogItemId));
  const newIds = dto.backlogItemIds.filter((id) => !alreadyMaterialized.has(id));
  if (!newIds.length) throw httpError('All selected items are already on the board', 409);

  throw httpError('backlogItems metadata must be supplied via API payload — use materializeFromPrdWithItems', 400);
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

export async function materializeFromPrdWithItems(
  actorId: string,
  dto: MaterializeFromPrdDTO & { items: BacklogItemMeta[] },
): Promise<ApexWorkItem[]> {
  if (!dto.items.length) throw httpError('No items to materialize');

  const existing = await db
    .select({ backlogItemId: apexWorkItems.backlogItemId })
    .from(apexWorkItems)
    .where(
      and(
        eq(apexWorkItems.prdId, dto.prdId),
        not(isNull(apexWorkItems.backlogItemId)),
      ),
    );
  const alreadyMaterialized = new Set(existing.map((r) => r.backlogItemId));
  const newItems = dto.items.filter((i) => !alreadyMaterialized.has(i.id));
  if (!newItems.length) throw httpError('All selected items are already on the board', 409);

  return db.transaction(async (tx) => {
    const created: ApexWorkItem[] = [];
    for (const item of newItems) {
      const [row] = await tx
        .insert(apexWorkItems)
        .values({
          title: item.title,
          outcome: item.description,
          type: item.type,
          status: 'ready',
          ownerOid: dto.ownerId,
          acceptanceCriteria: item.acceptanceCriteria.map((text, i) => ({
            id: `ac-${Date.now()}-${i}`,
            text,
            done: false,
          })),
          position: 9999,
          sourceType: 'prd',
          prdId: dto.prdId,
          backlogItemId: item.id,
          featureRequestId: null,
          epicId: item.epicId ?? null,
          epicTitle: item.epicTitle ?? null,
          featureId: item.featureId ?? null,
          featureTitle: item.featureTitle ?? null,
          createdBy: actorId,
          updatedBy: actorId,
        })
        .returning();

      await appendEvent(tx, row.id, actorId, 'created', {
        details: { sourceType: 'prd', prdId: dto.prdId, backlogItemId: item.id },
      });

      created.push(await toApexWorkItem(row));
    }
    await reRankColumn(tx, 'ready');
    return created;
  });
}

// ── Process 2 — AI generate drafts from Feature Request ──────────────────────

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
    '  PBI → end-user role; TBI → developer/system role; Bug → affected user role',
    '- type: PBI for user-facing, TBI for technical, Bug for defect',
    '- acceptanceCriteria: 2-4 items; EACH item MUST use Given: / When: / Then: (with colons) on separate lines',
    '- Example outcome: "As a mobile HCP\\nI want to request a shift swap\\nSo that I can cover an unexpected conflict"',
    '- Example AC: "Given: a signed-in HCP\\nWhen: they submit a swap request\\nThen: the replacement receives a notification"',
    '- Do not use bare checklist phrases for AC — always Given:/When:/Then:',
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}

export async function generateDraftsFromFeatureRequest(
  dto: GenerateFromFeatureRequestDTO,
): Promise<ApexWorkItemDraft[]> {
  const fr = await db.query.featureRequests.findFirst({
    where: eq(featureRequests.id, dto.featureRequestId),
  });
  if (!fr) throw httpError('Feature request not found', 404);

  // Build the prompt
  const prompt = buildGenerateDraftPrompt(fr, dto.grain);

  // Use Cursor SDK if available, otherwise return placeholder drafts
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
      type: (['PBI', 'TBI', 'Bug'].includes(d.type) ? d.type : 'PBI') as ApexWorkItemType,
      acceptanceCriteria: (d.acceptanceCriteria ?? []).map((text) => ({ text, done: false })),
    }));
  } catch {
    // Fallback drafts when SDK unavailable
    const given = fr.request?.trim() || fr.title;
    const benefit = fr.advantage?.trim() || 'I can complete this work efficiently';
    return [
      {
        id: `draft-${Date.now()}-0`,
        title: fr.title,
        outcome: [
          'As a user',
          `I want ${given.slice(0, 160)}`,
          `So that ${benefit}`,
        ].join('\n'),
        type: 'PBI',
        acceptanceCriteria: [
          {
            text: [
              `Given: a user working on "${fr.title}"`,
              `When: they complete the requested behavior (${given.slice(0, 160)})`,
              fr.advantage
                ? `Then: the outcome is achieved — ${fr.advantage}`
                : 'Then: the feature behaves as described and key steps are verifiable end-to-end',
            ].join('\n'),
            done: false,
          },
        ],
      },
    ];
  }
}

export async function createFromDrafts(
  actorId: string,
  dto: CreateFromDraftsDTO,
): Promise<ApexWorkItem[]> {
  const fr = await db.query.featureRequests.findFirst({
    where: eq(featureRequests.id, dto.featureRequestId),
  });
  if (!fr) throw httpError('Feature request not found', 404);

  return db.transaction(async (tx) => {
    const created: ApexWorkItem[] = [];
    for (const draft of dto.drafts) {
      const [row] = await tx
        .insert(apexWorkItems)
        .values({
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

    await reRankColumn(tx, 'ready');

    // FR status sync: first linked work item → planned
    const existingCount = await db
      .select({ id: apexWorkItems.id })
      .from(apexWorkItems)
      .where(
        and(
          eq(apexWorkItems.featureRequestId, dto.featureRequestId),
          not(inArray(apexWorkItems.id, created.map((c) => c.id))),
        ),
      );
    if (existingCount.length === 0 && fr.status !== 'declined') {
      await tx
        .update(featureRequests)
        .set({ status: 'planned', updatedAt: new Date().toISOString() })
        .where(eq(featureRequests.id, dto.featureRequestId));
    }

    return created;
  });
}

// ── Update ────────────────────────────────────────────────────────────────────

export async function updateApexWorkItem(
  id: string,
  actorId: string,
  dto: UpdateApexWorkItemDTO,
): Promise<ApexWorkItem> {
  const existing = await db.query.apexWorkItems.findFirst({ where: eq(apexWorkItems.id, id) });
  if (!existing) throw httpError('Work item not found', 404);

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
  if (dto.acceptanceCriteria !== undefined) { set.acceptanceCriteria = dto.acceptanceCriteria; }

  const ownerChanged = dto.ownerId !== undefined && dto.ownerId !== existing.ownerOid;
  if (dto.ownerId !== undefined) { set.ownerOid = dto.ownerId; }

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
    } else if (Object.keys(details).length) {
      await appendEvent(tx, id, actorId, 'updated', { details });
    }
  });

  // Notify new owner (fire-and-forget, skip if assigning to self)
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
  return toApexWorkItem(updated!);
}

// ── Move ──────────────────────────────────────────────────────────────────────

export async function moveApexWorkItem(
  id: string,
  actorId: string,
  dto: MoveApexWorkItemDTO,
): Promise<ApexWorkItem> {
  const existing = await db.query.apexWorkItems.findFirst({ where: eq(apexWorkItems.id, id) });
  if (!existing) throw httpError('Work item not found', 404);

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

    // Re-rank both columns
    await reRankColumn(tx, fromStatus);
    if (fromStatus !== toStatus) await reRankColumn(tx, toStatus);
  });

  // If this item's FR has all linked items Done, mark FR as done
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

  // If moved OUT of done and FR was auto-set to done, revert to planned
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

  const updated = await db.query.apexWorkItems.findFirst({ where: eq(apexWorkItems.id, id) });
  return toApexWorkItem(updated!);
}

// ── Materialized item ids for a PRD (for idempotent badge display) ────────────

export async function getMaterializedItemIds(prdId: string): Promise<string[]> {
  const rows = await db
    .select({ backlogItemId: apexWorkItems.backlogItemId })
    .from(apexWorkItems)
    .where(and(eq(apexWorkItems.prdId, prdId), not(isNull(apexWorkItems.backlogItemId))));
  return rows.map((r) => r.backlogItemId!);
}
