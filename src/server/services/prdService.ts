import fs from 'fs';
import { and, desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/drizzle';
import { prds, appUsers, chatThreads, interviews } from '../db/schema';

const authorUser = alias(appUsers, 'author_user');
const prdOwnerUser = alias(appUsers, 'prd_owner_user');
import type { Prd, PrdStatus, PrdSummary, ReviewPrdRequest } from '../../shared/types/interview';
import type { CreatePrdAdoItemsRequest, CreatePrdAdoItemsResponse, SelectedBacklogEpic, SelectedBacklogFeature, SelectedBacklogPBI, GlobalBusinessRule } from '../../shared/types/interview';
import { readOutputPrd, readOutputBacklog } from './chatAgentService';
import { isAdminUser } from '../utils/rbacHelpers';
import { assignApprovers, recordApproverResponse, isAssignedApprover, isApprovalComplete } from './documentApprovalService';
import { getUnresolvedCount } from './reviewCommentService';
import { AzureDevOpsService } from '../services/azureDevOps';
import { listDesignDocs } from '../services/designDocService';
import { stampAdoIds } from '../../shared/utils/backlogTransform';

const VALID_PRD_STATUSES: PrdStatus[] = ['generating', 'draft', 'pending_review', 'approved', 'revision_requested'];

async function cleanupWorkspace(threadId: string): Promise<void> {
  try {
    const row = await db.query.chatThreads.findFirst({
      where: eq(chatThreads.id, threadId),
      columns: { workspaceDir: true },
    });
    if (row?.workspaceDir) {
      fs.rmSync(row.workspaceDir, { recursive: true, force: true });
      console.log(`[prdWatcher] Cleaned up workspace for thread ${threadId}`);
    }
  } catch { /* non-fatal */ }
}

function assertValidPrdStatus(status: string): asserts status is PrdStatus {
  if (!VALID_PRD_STATUSES.includes(status as PrdStatus)) {
    const err = new Error(`Invalid PRD status: ${status}`);
    (err as any).status = 400;
    throw err;
  }
}

function conflict(msg: string): Error {
  const err = new Error(msg);
  (err as any).status = 409;
  return err;
}

function forbidden(msg: string): Error {
  const err = new Error(msg);
  (err as any).status = 403;
  return err;
}

function notFound(msg: string): Error {
  const err = new Error(msg);
  (err as any).status = 404;
  return err;
}

async function getPrdOwnerId(interviewId: string | null): Promise<string | null> {
  if (!interviewId) return null;
  const rows = await db
    .select({ prdOwnerId: interviews.prdOwnerId })
    .from(interviews)
    .where(eq(interviews.id, interviewId))
    .limit(1);
  return rows[0]?.prdOwnerId ?? null;
}

export async function createPrd(opts: {
  interviewId: string;
  project: string;
  userId: string;
  chatThreadId: string;
  title?: string;
}): Promise<{ prdId: string; threadId: string }> {
  const [row] = await db
    .insert(prds)
    .values({
      interviewId: opts.interviewId,
      project: opts.project,
      chatThreadId: opts.chatThreadId,
      authorId: opts.userId,
      title: opts.title ?? 'Untitled PRD',
      content: '',
      status: 'generating',
    })
    .returning({ id: prds.id });

  return { prdId: row.id, threadId: opts.chatThreadId };
}

export async function listPrds(
  filters?: { userId?: string; status?: PrdStatus; interviewId?: string; project?: string },
): Promise<PrdSummary[]> {
  const conditions: ReturnType<typeof eq>[] = [];
  if (filters?.userId) conditions.push(eq(prds.authorId, filters.userId));
  if (filters?.status) conditions.push(eq(prds.status, filters.status));
  if (filters?.interviewId) conditions.push(eq(prds.interviewId, filters.interviewId));
  if (filters?.project) conditions.push(eq(prds.project, filters.project));

  const rows = await db
    .select({
      prd: prds,
      reviewerDisplayName: appUsers.displayName,
      authorDisplayName: authorUser.displayName,
      prdOwnerId: interviews.prdOwnerId,
      prdOwnerDisplayName: prdOwnerUser.displayName,
    })
    .from(prds)
    .leftJoin(appUsers, eq(prds.reviewerId, appUsers.oid))
    .leftJoin(authorUser, eq(prds.authorId, authorUser.oid))
    .leftJoin(interviews, eq(prds.interviewId, interviews.id))
    .leftJoin(prdOwnerUser, eq(interviews.prdOwnerId, prdOwnerUser.oid))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(prds.updatedAt));

  return rows.map(({ prd, reviewerDisplayName, authorDisplayName, prdOwnerId, prdOwnerDisplayName }) =>
    rowToPrdSummary(prd, reviewerDisplayName, authorDisplayName, prdOwnerId, prdOwnerDisplayName),
  );
}

export async function getPrd(id: string): Promise<Prd | null> {
  const rows = await db
    .select({
      prd: prds,
      reviewerDisplayName: appUsers.displayName,
      authorDisplayName: authorUser.displayName,
      prdOwnerId: interviews.prdOwnerId,
      prdOwnerDisplayName: prdOwnerUser.displayName,
    })
    .from(prds)
    .leftJoin(appUsers, eq(prds.reviewerId, appUsers.oid))
    .leftJoin(authorUser, eq(prds.authorId, authorUser.oid))
    .leftJoin(interviews, eq(prds.interviewId, interviews.id))
    .leftJoin(prdOwnerUser, eq(interviews.prdOwnerId, prdOwnerUser.oid))
    .where(eq(prds.id, id))
    .limit(1);

  if (rows.length === 0) return null;
  const { prd: row, reviewerDisplayName, authorDisplayName, prdOwnerId, prdOwnerDisplayName } = rows[0];
  return {
    ...rowToPrdSummary(row, reviewerDisplayName, authorDisplayName, prdOwnerId, prdOwnerDisplayName),
    content: row.content,
    backlogJson: row.backlogJson ?? undefined,
    prdAssistantThreadId: row.prdAssistantThreadId ?? null,
    proposedContent: row.proposedContent ?? null,
    proposedBacklogJson: row.proposedBacklogJson ?? undefined,
  };
}

export async function updatePrdContent(
  id: string,
  requestingUserId: string,
  content: string,
): Promise<void> {
  const row = await db.query.prds.findFirst({ where: eq(prds.id, id) });
  if (!row) throw notFound('PRD not found');
  const ownerId = await getPrdOwnerId(row.interviewId);
  if (row.authorId !== requestingUserId && ownerId !== requestingUserId && !(await isAdminUser(requestingUserId))) {
    throw forbidden('Only the author or owner can edit PRD content');
  }
  if (row.status === 'approved') throw conflict('Approved PRDs cannot be edited');

  const updates: Partial<typeof prds.$inferInsert> = {
    content,
    updatedAt: new Date().toISOString(),
  };

  if (row.status === 'revision_requested') {
    updates.status = 'draft';
    updates.reviewerId = null;
    updates.reviewedAt = null;
  }

  await db.update(prds).set(updates).where(eq(prds.id, id));
}

export async function updatePrdBacklog(
  id: string,
  requestingUserId: string,
  backlog: unknown,
): Promise<void> {
  const row = await db.query.prds.findFirst({ where: eq(prds.id, id) });
  if (!row) throw notFound('PRD not found');
  const ownerId = await getPrdOwnerId(row.interviewId);
  if (row.authorId !== requestingUserId && ownerId !== requestingUserId) {
    throw forbidden('Only the author or owner can update backlog');
  }
  if (row.status === 'approved') throw conflict('Approved PRDs cannot be edited');

  await db
    .update(prds)
    .set({ backlogJson: backlog as any, updatedAt: new Date().toISOString() })
    .where(eq(prds.id, id));
}

export async function submitForReview(
  id: string,
  requestingUserId: string,
  opts?: { prdApproverIds?: string[]; designDocApproverIds?: string[]; designPrototypeApproverIds?: string[] },
): Promise<void> {
  const row = await db.query.prds.findFirst({ where: eq(prds.id, id) });
  if (!row) throw notFound('PRD not found');
  const ownerId = await getPrdOwnerId(row.interviewId);
  if (row.authorId !== requestingUserId && ownerId !== requestingUserId && !(await isAdminUser(requestingUserId))) {
    throw forbidden('Only the author or owner can submit for review');
  }
  if (row.status !== 'draft' && row.status !== 'revision_requested') {
    throw conflict(`Cannot submit PRD from status '${row.status}'`);
  }
  if (!row.content) throw conflict('PRD content must be non-empty before submitting for review');

  let effectivePrdApproverIds = opts?.prdApproverIds;
  let effectiveDdApproverIds = opts?.designDocApproverIds;
  let effectivePrototypeApproverIds = opts?.designPrototypeApproverIds;

  if ((!effectivePrdApproverIds || effectivePrdApproverIds.length === 0) && row.interviewId) {
    const interview = await db.query.interviews.findFirst({
      where: eq(interviews.id, row.interviewId),
      columns: { prdApproverIds: true, designDocApproverIds: true, designPrototypeApproverIds: true },
    });
    if (interview?.prdApproverIds && interview.prdApproverIds.length > 0) {
      effectivePrdApproverIds = interview.prdApproverIds;
    }
    if (!effectiveDdApproverIds || effectiveDdApproverIds.length === 0) {
      effectiveDdApproverIds = interview?.designDocApproverIds ?? undefined;
    }
    if (!effectivePrototypeApproverIds || effectivePrototypeApproverIds.length === 0) {
      effectivePrototypeApproverIds = interview?.designPrototypeApproverIds ?? undefined;
    }
  }

  const updates: Partial<typeof prds.$inferInsert> = {
    status: 'pending_review',
    reviewerId: null,
    reviewedAt: null,
    updatedAt: new Date().toISOString(),
  };

  if (effectiveDdApproverIds && effectiveDdApproverIds.length > 0) {
    updates.designDocApproverIds = effectiveDdApproverIds;
  }

  if (effectivePrototypeApproverIds && effectivePrototypeApproverIds.length > 0) {
    updates.designPrototypeApproverIds = effectivePrototypeApproverIds;
  }

  await db.update(prds).set(updates).where(eq(prds.id, id));

  if (effectivePrdApproverIds && effectivePrdApproverIds.length > 0) {
    await assignApprovers(id, 'prd', effectivePrdApproverIds, requestingUserId);
  }
}

export async function withdrawFromReview(id: string, requestingUserId: string): Promise<void> {
  const row = await db.query.prds.findFirst({ where: eq(prds.id, id) });
  if (!row) throw notFound('PRD not found');
  const ownerId = await getPrdOwnerId(row.interviewId);
  if (row.authorId !== requestingUserId && ownerId !== requestingUserId && !(await isAdminUser(requestingUserId))) {
    throw forbidden('Only the author or owner can withdraw from review');
  }
  if (row.status !== 'pending_review') throw conflict(`Cannot withdraw PRD from status '${row.status}'`);

  await db
    .update(prds)
    .set({
      status: 'draft',
      reviewerId: null,
      reviewedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(prds.id, id));
}

export async function reopenForReview(id: string): Promise<void> {
  const row = await db.query.prds.findFirst({ where: eq(prds.id, id) });
  if (!row) throw notFound('PRD not found');

  await db
    .update(prds)
    .set({
      status: 'pending_review',
      reviewerId: null,
      reviewedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(prds.id, id));
}

export async function reviewPrd(
  id: string,
  reviewerId: string,
  opts: ReviewPrdRequest,
): Promise<{ approved: boolean }> {
  const row = await db.query.prds.findFirst({ where: eq(prds.id, id) });
  if (!row) throw notFound('PRD not found');
  if (row.status !== 'pending_review') throw conflict(`Cannot review PRD from status '${row.status}'`);
  if (row.authorId === reviewerId && !(await isAdminUser(reviewerId))) {
    throw forbidden('You cannot review your own PRD');
  }
  if (opts.action !== 'approve') {
    const err = new Error(`Invalid review action: ${opts.action}`);
    (err as any).status = 400;
    throw err;
  }

  const unresolvedCount = await getUnresolvedCount(id, 'prd');
  if (unresolvedCount > 0) {
    const err = new Error(`Cannot approve: ${unresolvedCount} unresolved review comment(s) remain`);
    (err as any).status = 400;
    throw err;
  }

  const admin = await isAdminUser(reviewerId);
  const assigned = await isAssignedApprover(id, 'prd', reviewerId);
  if (!assigned && !admin) {
    throw forbidden('You are not an assigned approver for this PRD');
  }

  if (assigned) {
    await recordApproverResponse(id, 'prd', reviewerId, 'approved');
  }

  if (!admin) {
    const { complete } = await isApprovalComplete(id, 'prd', row.project);
    if (!complete) {
      return { approved: false };
    }
  }

  await db
    .update(prds)
    .set({
      status: 'approved',
      reviewerId,
      reviewedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(prds.id, id));

  return { approved: opts.action === 'approve' };
}

export async function syncPrdContent(
  id: string,
  content: string,
  backlogJson?: unknown,
  finalStatus: PrdStatus = 'pending_review',
): Promise<void> {
  await db
    .update(prds)
    .set({
      content,
      status: finalStatus,
      ...(backlogJson !== undefined ? { backlogJson: backlogJson as any } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(prds.id, id));
}

const WATCHER_INTERVAL_MS = 5_000;
const WATCHER_MAX_ATTEMPTS = 360;

const activePrdWatchers = new Map<string, ReturnType<typeof setInterval>>();

function stopPrdWatcher(prdId: string): void {
  const handle = activePrdWatchers.get(prdId);
  if (handle !== undefined) {
    clearInterval(handle);
    activePrdWatchers.delete(prdId);
    console.log(`[prdWatcher] Cancelled — prdId=${prdId}`);
  }
}

export function startPrdWatcher(prdId: string, chatThreadId: string): void {
  stopPrdWatcher(prdId);
  let attempts = 0;
  console.log(`[prdWatcher] Started — prdId=${prdId} threadId=${chatThreadId}`);

  const interval = setInterval(async () => {
    attempts += 1;

    if (attempts > WATCHER_MAX_ATTEMPTS) {
      clearInterval(interval);
      activePrdWatchers.delete(prdId);
      console.warn(`[prdWatcher] Timed out waiting for PRD output — resetting to draft (prdId=${prdId}, threadId=${chatThreadId})`);
      await db.update(prds)
        .set({ status: 'draft', updatedAt: new Date().toISOString() })
        .where(and(eq(prds.id, prdId), eq(prds.status, 'generating')));
      return;
    }

    const content = readOutputPrd(chatThreadId);
    const backlog = readOutputBacklog(chatThreadId);

    console.log(
      `[prdWatcher] tick #${attempts} — prdFile=${content !== null ? `found (${String(content).length} chars)` : 'missing'} backlogFile=${backlog !== null ? 'found' : 'missing'} (prdId=${prdId})`,
    );

    if (content !== null && backlog !== null) {
      clearInterval(interval);
      activePrdWatchers.delete(prdId);
      console.log(`[prdWatcher] Both files ready — syncing to DB (prdId=${prdId})`);
      try {
        await syncPrdContent(prdId, content, backlog);
        console.log(`[prdWatcher] Sync complete — PRD is now pending_review (prdId=${prdId})`);
        cleanupWorkspace(chatThreadId);
      } catch (err) {
        console.error(`[prdWatcher] Failed to sync PRD content (prdId=${prdId})`, err);
      }
    }
  }, WATCHER_INTERVAL_MS);

  activePrdWatchers.set(prdId, interval);
}

function rowToPrdSummary(
  row: typeof prds.$inferSelect,
  reviewerName?: string | null,
  authorName?: string | null,
  prdOwnerId?: string | null,
  prdOwnerName?: string | null,
): PrdSummary {
  const effectiveOwnerId = prdOwnerId ?? row.authorId;
  const effectiveOwnerName = prdOwnerName ?? authorName ?? undefined;
  return {
    id: row.id,
    interviewId: row.interviewId,
    chatThreadId: row.chatThreadId ?? '',
    authorId: row.authorId,
    authorName: authorName ?? undefined,
    ownerId: effectiveOwnerId,
    ownerName: effectiveOwnerName,
    project: row.project,
    title: row.title,
    status: row.status as PrdStatus,
    reviewerId: row.reviewerId ?? undefined,
    reviewerName: reviewerName ?? undefined,
    reviewComment: row.reviewComment ?? undefined,
    reviewedAt: row.reviewedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── HTML helpers for rich ADO descriptions ───────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function htmlSection(heading: string, items: string[]): string {
  if (!items.length) return '';
  const listItems = items.map(i => `<li>${esc(i)}</li>`).join('');
  return `<p><strong>${esc(heading)}</strong></p><ul>${listItems}</ul>`;
}

function htmlParagraph(text: string): string {
  return text ? `<p>${esc(text)}</p>` : '';
}

function buildEpicDescriptionHtml(
  epic: SelectedBacklogEpic,
  globalBusinessRules?: GlobalBusinessRule[],
): string {
  let html = htmlParagraph(epic.description ?? '');

  if (epic.successMetrics && epic.successMetrics.length > 0) {
    html += htmlSection('Success Metrics', epic.successMetrics);
  }

  if (globalBusinessRules && globalBusinessRules.length > 0) {
    const brItems = globalBusinessRules.map(br => {
      const base = `${br.id}: ${br.rule}`;
      return br.appliesTo ? `${base} (Applies to: ${br.appliesTo})` : base;
    });
    html += `<p><strong>Business Rules</strong></p><ul>${brItems.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
  }

  if (epic.assumptions && epic.assumptions.length > 0) {
    html += htmlSection('Assumptions', epic.assumptions);
  }

  if (epic.dependencies && epic.dependencies.length > 0) {
    html += htmlSection('Dependencies', epic.dependencies);
  }

  if (epic.outOfScope && epic.outOfScope.length > 0) {
    html += htmlSection('Out of Scope', epic.outOfScope);
  }

  return html;
}

function buildFeatureDescriptionHtml(feature: SelectedBacklogFeature): string {
  let html = htmlParagraph(feature.description ?? '');

  if (feature.affectedPersonas && feature.affectedPersonas.length > 0) {
    html += htmlSection('Affected Personas', feature.affectedPersonas);
  }

  if (feature.dependencies && feature.dependencies.length > 0) {
    html += htmlSection('Dependencies', feature.dependencies);
  }

  if (feature.outOfScope && feature.outOfScope.length > 0) {
    html += htmlSection('Out of Scope', feature.outOfScope);
  }

  return html;
}

function buildPbiDescriptionHtml(pbi: SelectedBacklogPBI): string {
  let html = '';

  const us = pbi.userStory;
  if (us && (us.persona || us.iWant || us.soThat)) {
    const parts: string[] = [];
    if (us.persona) parts.push(`As <em>${esc(us.persona)}</em>`);
    if (us.iWant)   parts.push(`I want to ${esc(us.iWant)}`);
    if (us.soThat)  parts.push(`so that ${esc(us.soThat)}`);
    html += `<p><strong>User Story</strong></p><p>${parts.join(', ')}.</p>`;
  }

  if (pbi.description) {
    html += htmlParagraph(pbi.description);
  }

  if (pbi.businessRules && pbi.businessRules.length > 0) {
    html += htmlSection('Business Rules', pbi.businessRules);
  }

  const nfr = pbi.nonFunctionalRequirements;
  if (nfr) {
    if (Array.isArray(nfr) && nfr.length > 0) {
      html += htmlSection('Non-Functional Requirements', nfr);
    } else if (!Array.isArray(nfr)) {
      const nfrItems = Object.entries(nfr).map(([k, v]) => `${k}: ${v}`);
      if (nfrItems.length > 0) html += htmlSection('Non-Functional Requirements', nfrItems);
    }
  }

  if (pbi.definitionOfDone && pbi.definitionOfDone.length > 0) {
    html += htmlSection('Definition of Done', pbi.definitionOfDone);
  }

  if (pbi.outOfScope && pbi.outOfScope.length > 0) {
    html += htmlSection('Out of Scope', pbi.outOfScope);
  }

  if (pbi.dependsOn && pbi.dependsOn.length > 0) {
    html += htmlSection('Depends On', pbi.dependsOn);
  }

  return html;
}

function buildAcceptanceCriteriaHtml(
  criteria: Array<{ given?: string; when?: string; then?: string }>,
): string {
  const items = criteria
    .map(ac => {
      const parts: string[] = [];
      if (ac.given) parts.push(`<strong>Given</strong> ${esc(ac.given)}`);
      if (ac.when)  parts.push(`<strong>When</strong> ${esc(ac.when)}`);
      if (ac.then)  parts.push(`<strong>Then</strong> ${esc(ac.then)}`);
      return `<li>${parts.join(' ')}</li>`;
    })
    .join('');
  return `<ul>${items}</ul>`;
}

// ── Service function ──────────────────────────────────────────────────────────

export async function createPrdAdoWorkItems(
  prdId: string,
  userId: string,
  req: CreatePrdAdoItemsRequest,
): Promise<CreatePrdAdoItemsResponse> {
  const prd = await getPrd(prdId);
  if (!prd) throw notFound('PRD not found');
  if (prd.status !== 'approved') {
    throw conflict('PRD must be approved before creating ADO work items');
  }

  const designDocs = await listDesignDocs({ prdId });
  const approvedDesignDocs = designDocs.filter(d => d.status === 'approved');
  if (approvedDesignDocs.length === 0) {
    const err = new Error('At least one approved design doc is required before creating ADO work items');
    (err as any).status = 422;
    throw err;
  }

  const adoService = new AzureDevOpsService(req.project, req.areaPath);

  const response: CreatePrdAdoItemsResponse = {
    success: true,
    created: { epics: [], features: [], pbis: [] },
    totalCreated: 0,
  };

  for (const epic of req.selectedItems.epics) {
    const epicDescHtml = buildEpicDescriptionHtml(epic, req.globalBusinessRules);
    const epicResult = await adoService.createWorkItemForPrd({
      type: 'Epic',
      title: epic.title,
      description: epicDescHtml || undefined,
      priority: epic.priority,
    });
    response.created.epics.push({ title: epic.title, adoId: epicResult.id, adoUrl: epicResult.url });
    response.totalCreated += 1;

    if (epic.features) {
      for (const feature of epic.features) {
        const featureDescHtml = buildFeatureDescriptionHtml(feature);
        const featureResult = await adoService.createWorkItemForPrd({
          type: 'Feature',
          title: feature.title,
          description: featureDescHtml || undefined,
          priority: feature.priority,
          parentId: epicResult.id,
        });
        response.created.features.push({ title: feature.title, adoId: featureResult.id, adoUrl: featureResult.url });
        response.totalCreated += 1;

        if (feature.items) {
          for (const pbi of feature.items) {
            const pbiDescHtml = buildPbiDescriptionHtml(pbi);
            const acHtml =
              pbi.acceptanceCriteria && pbi.acceptanceCriteria.length > 0
                ? buildAcceptanceCriteriaHtml(pbi.acceptanceCriteria)
                : undefined;

            const pbiResult = await adoService.createWorkItemForPrd({
              type: 'Product Backlog Item',
              title: pbi.title,
              description: pbiDescHtml || undefined,
              acceptanceCriteriaHtml: acHtml,
              priority: pbi.priority,
              parentId: featureResult.id,
            });
            response.created.pbis.push({ title: pbi.title, adoId: pbiResult.id, adoUrl: pbiResult.url });
            response.totalCreated += 1;
          }
        }
      }
    }
  }

  const updatedBacklogJson = stampAdoIds(prd.backlogJson, response);
  await db
    .update(prds)
    .set({ backlogJson: updatedBacklogJson as any, updatedAt: new Date().toISOString() })
    .where(eq(prds.id, prdId));

  return response;
}

/**
 * Verify every adoWorkItemId stored in backlogJson against ADO.
 * Any IDs that no longer exist in ADO are cleared from the backlogJson.
 * Returns the count of IDs that were cleared.
 */
export async function syncPrdAdoStatus(prdId: string): Promise<{ cleared: number; updatedBacklog: unknown }> {
  const prd = await getPrd(prdId);
  if (!prd || !prd.backlogJson) return { cleared: 0, updatedBacklog: null };

  type AnyNode = { adoWorkItemId?: number; adoWorkItemUrl?: string; features?: AnyNode[]; items?: AnyNode[] };
  const backlog = prd.backlogJson as { epics?: AnyNode[] };
  const epics = backlog.epics ?? [];

  // Collect all stored ADO IDs
  const storedIds: number[] = [];
  for (const epic of epics) {
    if (epic.adoWorkItemId) storedIds.push(epic.adoWorkItemId);
    for (const feat of epic.features ?? []) {
      if (feat.adoWorkItemId) storedIds.push(feat.adoWorkItemId);
      for (const item of feat.items ?? []) {
        if (item.adoWorkItemId) storedIds.push(item.adoWorkItemId);
      }
    }
  }

  if (storedIds.length === 0) return { cleared: 0, updatedBacklog: backlog };

  const adoService = new AzureDevOpsService(prd.project);
  const deletedIds = await adoService.findDeletedWorkItemIds(storedIds);

  if (deletedIds.length === 0) return { cleared: 0, updatedBacklog: backlog };

  const deletedSet = new Set(deletedIds);

  // Clear stale IDs from the backlog tree
  const clearNode = (node: AnyNode) => {
    if (node.adoWorkItemId && deletedSet.has(node.adoWorkItemId)) {
      delete node.adoWorkItemId;
      delete node.adoWorkItemUrl;
    }
  };

  for (const epic of epics) {
    clearNode(epic);
    for (const feat of epic.features ?? []) {
      clearNode(feat);
      for (const item of feat.items ?? []) {
        clearNode(item);
      }
    }
  }

  await db
    .update(prds)
    .set({ backlogJson: backlog as any, updatedAt: new Date().toISOString() })
    .where(eq(prds.id, prdId));

  return { cleared: deletedIds.length, updatedBacklog: backlog };
}

export async function deletePrd(id: string, requestingUserId: string): Promise<void> {
  const row = await db.query.prds.findFirst({ where: eq(prds.id, id) });
  if (!row) throw notFound('PRD not found');
  const ownerId = await getPrdOwnerId(row.interviewId);
  if (row.authorId !== requestingUserId && ownerId !== requestingUserId && !(await isAdminUser(requestingUserId))) {
    throw forbidden('Only the author or owner can delete this PRD');
  }
  stopPrdWatcher(id);
  await db.delete(prds).where(eq(prds.id, id));
}

// Ensure assertValidPrdStatus is used (suppress unused warning)
void assertValidPrdStatus;
