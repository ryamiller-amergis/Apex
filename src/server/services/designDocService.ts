import fs from 'fs';
import path from 'path';
import { and, desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/drizzle';
import { designDocs, appUsers, chatThreads, prds, interviews } from '../db/schema';

const authorUser = alias(appUsers, 'author_user');
const designDocOwnerUser = alias(appUsers, 'design_doc_owner_user');
import type { ContentSnapshot, DesignDoc, DesignDocStatus, DesignDocSummary, ReviewDesignDocRequest, ValidationScorecard, ValidationScorecardGap } from '../../shared/types/interview';
import { readOutputDesignDoc, readOutputTechSpec, readOutputAssumptions, readOutputValidationScorecard, readOutputValidationScorecardMd, readAllOutputDesignDocFeatures, isThreadIdle, createThread as createChatThread, sendMessage, cancelRun } from './chatAgentService';
import { isAdminUser } from '../utils/rbacHelpers';
import { assignApprovers, recordApproverResponse, isAssignedApprover, isApprovalComplete, propagateDesignDocApprovers, notifyApproversDocumentReady } from './documentApprovalService';
import { getUnresolvedCount } from './reviewCommentService';
import { notifyAiCompletion } from './aiCompletionNotifier';
import { getSkillConfig } from './projectSettingsService';
import { getDefaultModel } from './appSettingsService';
import { getPrd } from './prdService';

const VALID_STATUSES: DesignDocStatus[] = ['interviewing', 'generating', 'validating', 'draft', 'pending_review', 'approved', 'revision_requested'];

async function cleanupWorkspace(threadId: string): Promise<void> {
  try {
    const row = await db.query.chatThreads.findFirst({
      where: eq(chatThreads.id, threadId),
      columns: { workspaceDir: true },
    });
    if (row?.workspaceDir) {
      fs.rmSync(row.workspaceDir, { recursive: true, force: true });
      console.log(`[watcher] Cleaned up workspace for thread ${threadId}`);
    }
  } catch { /* non-fatal */ }
}

function assertValidStatus(status: string): asserts status is DesignDocStatus {
  if (!VALID_STATUSES.includes(status as DesignDocStatus)) {
    const err = new Error(`Invalid design doc status: ${status}`);
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

function stripPrototypeArtifactsFromTechSpec(content: string): string {
  let cleaned = content;

  // Remove full HTML document dumps if they leak into generated tech specs.
  cleaned = cleaned.replace(/<!DOCTYPE\s+html[\s\S]*?<\/html>/gi, '');

  // Remove fenced HTML blocks that appear to be prototype payloads.
  cleaned = cleaned.replace(/```html[\s\S]*?```/gi, (block) => {
    if (/NEW_FEATURE|STATE:(?:default|empty|error|loading)|annotation-wrapper|time-entry-table|<body|<html/i.test(block)) {
      return '';
    }
    return block;
  });

  // Remove prototype-only comment markers in case they appear inline.
  cleaned = cleaned.replace(/<!--\s*NEW_FEATURE:(?:START|END)\s*-->/gi, '');
  cleaned = cleaned.replace(/<!--\s*STATE:[a-z_]+:(?:START|END)\s*-->/gi, '');

  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

export async function createDesignDoc(opts: {
  prdId: string;
  project: string;
  userId: string;
  chatThreadId?: string;
  qaChatThreadId?: string;
  title?: string;
  status?: DesignDocStatus;
  model?: string;
}): Promise<{ designDocId: string }> {
  const status = opts.status ?? (opts.qaChatThreadId && !opts.chatThreadId ? 'interviewing' : 'generating');
  const [row] = await db
    .insert(designDocs)
    .values({
      prdId: opts.prdId,
      project: opts.project,
      chatThreadId: opts.chatThreadId ?? null,
      qaChatThreadId: opts.qaChatThreadId ?? null,
      authorId: opts.userId,
      title: opts.title ?? 'Untitled Design Doc',
      model: opts.model ?? null,
      designContent: '',
      techSpecContent: '',
      assumptionsContent: '',
      status,
    })
    .returning({ id: designDocs.id });

  return { designDocId: row.id };
}

export async function listDesignDocs(
  filters?: { userId?: string; status?: DesignDocStatus; prdId?: string; project?: string },
): Promise<DesignDocSummary[]> {
  const conditions: ReturnType<typeof eq>[] = [];
  if (filters?.userId) conditions.push(eq(designDocs.authorId, filters.userId));
  if (filters?.status) conditions.push(eq(designDocs.status, filters.status));
  if (filters?.prdId) conditions.push(eq(designDocs.prdId, filters.prdId));
  if (filters?.project) conditions.push(eq(designDocs.project, filters.project));

  const rows = await db
    .select({
      designDoc: designDocs,
      reviewerDisplayName: appUsers.displayName,
      authorDisplayName: authorUser.displayName,
      prdTitle: prds.title,
      designDocOwnerId: interviews.designDocOwnerId,
      designDocOwnerDisplayName: designDocOwnerUser.displayName,
    })
    .from(designDocs)
    .leftJoin(appUsers, eq(designDocs.reviewerId, appUsers.oid))
    .leftJoin(authorUser, eq(designDocs.authorId, authorUser.oid))
    .leftJoin(prds, eq(designDocs.prdId, prds.id))
    .leftJoin(interviews, eq(prds.interviewId, interviews.id))
    .leftJoin(designDocOwnerUser, eq(interviews.designDocOwnerId, designDocOwnerUser.oid))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(designDocs.updatedAt));

  return rows.map(({ designDoc, reviewerDisplayName, authorDisplayName, prdTitle, designDocOwnerId, designDocOwnerDisplayName }) =>
    rowToSummary(designDoc, reviewerDisplayName, prdTitle, authorDisplayName, designDocOwnerId, designDocOwnerDisplayName),
  );
}

export async function getDesignDoc(id: string): Promise<DesignDoc | null> {
  const rows = await db
    .select({
      designDoc: designDocs,
      reviewerDisplayName: appUsers.displayName,
      authorDisplayName: authorUser.displayName,
      designDocOwnerId: interviews.designDocOwnerId,
      designDocOwnerDisplayName: designDocOwnerUser.displayName,
    })
    .from(designDocs)
    .leftJoin(appUsers, eq(designDocs.reviewerId, appUsers.oid))
    .leftJoin(authorUser, eq(designDocs.authorId, authorUser.oid))
    .leftJoin(prds, eq(designDocs.prdId, prds.id))
    .leftJoin(interviews, eq(prds.interviewId, interviews.id))
    .leftJoin(designDocOwnerUser, eq(interviews.designDocOwnerId, designDocOwnerUser.oid))
    .where(eq(designDocs.id, id))
    .limit(1);

  if (rows.length === 0) return null;
  const { designDoc: row, reviewerDisplayName, authorDisplayName, designDocOwnerId, designDocOwnerDisplayName } = rows[0];
  return {
    ...rowToSummary(row, reviewerDisplayName, undefined, authorDisplayName, designDocOwnerId, designDocOwnerDisplayName),
    designContent: row.designContent,
    techSpecContent: row.techSpecContent,
    assumptionsContent: row.assumptionsContent,
    proposedDesignContent: row.proposedDesignContent ?? null,
    proposedTechSpecContent: row.proposedTechSpecContent ?? null,
    proposedAssumptionsContent: row.proposedAssumptionsContent ?? null,
    fixCommentId: row.fixCommentId ?? null,
  };
}

export async function updateDesignDocContent(
  id: string,
  requestingUserId: string,
  opts: { designContent?: string; techSpecContent?: string; assumptionsContent?: string },
): Promise<void> {
  const row = await db.query.designDocs.findFirst({ where: eq(designDocs.id, id) });
  if (!row) throw notFound('Design doc not found');
  if (row.authorId !== requestingUserId && !(await isAdminUser(requestingUserId))) {
    throw forbidden('Only the author can edit design doc content');
  }
  if (row.status === 'approved') throw conflict('Approved design docs cannot be edited');

  const updates: Partial<typeof designDocs.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };

  if (opts.designContent !== undefined) updates.designContent = opts.designContent;
  if (opts.techSpecContent !== undefined) {
    updates.techSpecContent = stripPrototypeArtifactsFromTechSpec(opts.techSpecContent);
  }
  if (opts.assumptionsContent !== undefined) updates.assumptionsContent = opts.assumptionsContent;

  if (row.status === 'revision_requested') {
    updates.status = 'draft';
    updates.reviewerId = null;
    updates.reviewedAt = null;
  }

  await db.update(designDocs).set(updates).where(eq(designDocs.id, id));
}

export async function submitForReview(
  id: string,
  requestingUserId: string,
  opts?: { approverIds?: string[] },
): Promise<void> {
  const row = await db.query.designDocs.findFirst({ where: eq(designDocs.id, id) });
  if (!row) throw notFound('Design doc not found');
  if (row.authorId !== requestingUserId && !(await isAdminUser(requestingUserId))) {
    throw forbidden('Only the author can submit for review');
  }
  if (row.status !== 'draft' && row.status !== 'revision_requested') {
    throw conflict(`Cannot submit design doc from status '${row.status}'`);
  }
  if (!row.designContent && !row.techSpecContent && !row.assumptionsContent) {
    throw conflict('Design doc content must be non-empty before submitting for review');
  }

  let effectiveApproverIds = opts?.approverIds;
  if ((!effectiveApproverIds || effectiveApproverIds.length === 0) && row.prdId) {
    const prd = await db.query.prds.findFirst({
      where: eq(prds.id, row.prdId),
      columns: { interviewId: true },
    });
    if (prd?.interviewId) {
      const interview = await db.query.interviews.findFirst({
        where: eq(interviews.id, prd.interviewId),
        columns: { designDocApproverIds: true },
      });
      if (interview?.designDocApproverIds && interview.designDocApproverIds.length > 0) {
        effectiveApproverIds = interview.designDocApproverIds;
      }
    }
  }

  await db
    .update(designDocs)
    .set({
      status: 'pending_review',
      reviewerId: null,
      reviewedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(designDocs.id, id));

  if (effectiveApproverIds && effectiveApproverIds.length > 0) {
    await assignApprovers(id, 'design_doc', effectiveApproverIds, requestingUserId);
  }
}

export async function withdrawFromReview(id: string, requestingUserId: string): Promise<void> {
  const row = await db.query.designDocs.findFirst({ where: eq(designDocs.id, id) });
  if (!row) throw notFound('Design doc not found');
  if (row.authorId !== requestingUserId && !(await isAdminUser(requestingUserId))) {
    throw forbidden('Only the author can withdraw from review');
  }
  if (row.status !== 'pending_review') throw conflict(`Cannot withdraw design doc from status '${row.status}'`);

  await db
    .update(designDocs)
    .set({
      status: 'draft',
      reviewerId: null,
      reviewedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(designDocs.id, id));
}

export async function reviewDesignDoc(
  id: string,
  reviewerId: string,
  opts: ReviewDesignDocRequest,
): Promise<void> {
  const row = await db.query.designDocs.findFirst({ where: eq(designDocs.id, id) });
  if (!row) throw notFound('Design doc not found');
  if (row.status !== 'pending_review') throw conflict(`Cannot review design doc from status '${row.status}'`);
  if (row.authorId === reviewerId && !(await isAdminUser(reviewerId))) {
    throw forbidden('You cannot review your own design doc');
  }
  if (opts.action !== 'approve') {
    const err = new Error(`Invalid review action: ${opts.action}`);
    (err as any).status = 400;
    throw err;
  }

  const skillConfig = await getSkillConfig(row.project);
  if (skillConfig?.designDocValidationSkillPath) {
    if (row.validationScore === null || row.validationScore === undefined || row.validationScore < 90) {
      const err = new Error(`Validation score must be >= 90 to approve. Current score: ${row.validationScore ?? 'not scored'}`);
      (err as any).status = 409;
      throw err;
    }
  }

  const unresolvedCount = await getUnresolvedCount(id, 'design_doc');
  if (unresolvedCount > 0) {
    const err = new Error(`Cannot approve: ${unresolvedCount} unresolved review comment(s) remain`);
    (err as any).status = 400;
    throw err;
  }

  const admin = await isAdminUser(reviewerId);
  const assigned = await isAssignedApprover(id, 'design_doc', reviewerId);
  if (!assigned && !admin) {
    throw forbidden('You are not an assigned approver for this design doc');
  }

  if (assigned) {
    await recordApproverResponse(id, 'design_doc', reviewerId, 'approved');
  }

  if (!admin) {
    const { complete } = await isApprovalComplete(id, 'design_doc', row.project);
    if (!complete) {
      return;
    }
  }

  await db
    .update(designDocs)
    .set({
      status: 'approved',
      reviewerId,
      reviewedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(designDocs.id, id));
}

export async function syncDesignDocContent(
  id: string,
  opts: { designContent?: string; techSpecContent?: string; assumptionsContent?: string; finalStatus?: DesignDocStatus },
): Promise<void> {
  const updates: Partial<typeof designDocs.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };

  if (opts.designContent !== undefined) updates.designContent = opts.designContent;
  if (opts.techSpecContent !== undefined) {
    updates.techSpecContent = stripPrototypeArtifactsFromTechSpec(opts.techSpecContent);
  }
  if (opts.assumptionsContent !== undefined) updates.assumptionsContent = opts.assumptionsContent;
  if (opts.finalStatus !== undefined) updates.status = opts.finalStatus;

  await db
    .update(designDocs)
    .set(updates)
    .where(eq(designDocs.id, id));

  if (opts.finalStatus === 'pending_review') {
    notifyApproversDocumentReady(id, 'design_doc').catch((err) =>
      console.error(`[syncDesignDocContent] Failed to notify approvers (docId=${id})`, err),
    );
  }
}

const WATCHER_INTERVAL_MS = 5_000;
const WATCHER_MAX_ATTEMPTS = 360;

const activeDocWatchers = new Map<string, ReturnType<typeof setInterval>>();
const activeValidationWatchers = new Map<string, ReturnType<typeof setInterval>>();

function stopDocWatcher(designDocId: string): void {
  const handle = activeDocWatchers.get(designDocId);
  if (handle !== undefined) {
    clearInterval(handle);
    activeDocWatchers.delete(designDocId);
    console.log(`[designDocWatcher] Cancelled — designDocId=${designDocId}`);
  }
}

function stopValidationWatcher(designDocId: string): void {
  const handle = activeValidationWatchers.get(designDocId);
  if (handle !== undefined) {
    clearInterval(handle);
    activeValidationWatchers.delete(designDocId);
    console.log(`[validationWatcher] Cancelled — designDocId=${designDocId}`);
  }
}

/** Returns true when a validation watcher is already running for this doc. */
export function isValidationWatcherActive(designDocId: string): boolean {
  return activeValidationWatchers.has(designDocId);
}

function humanizeSlug(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Creates one design_docs row per feature found in the workspace, then nulls the seed
 * row's chatThreadId to signal that creation is complete (prevents double-processing by
 * the watcher). No-op if the seed row's chatThreadId has already been nulled.
 */
export async function syncPerFeatureDesignDocs(
  seedId: string,
  prdId: string,
  project: string,
  authorId: string,
  threadId: string,
): Promise<void> {
  const features = readAllOutputDesignDocFeatures(threadId);
  if (features.length === 0) {
    console.log(`[designDoc] syncPerFeatureDesignDocs: no complete feature triplets found (threadId=${threadId})`);
    return;
  }

  const skillConfig = await getSkillConfig(project);
  const finalStatus: DesignDocStatus = skillConfig?.designDocValidationSkillPath ? 'validating' : 'pending_review';
  const seedModelRow = await db.query.designDocs.findFirst({
    where: eq(designDocs.id, seedId),
    columns: { model: true },
  });
  const seedModel = seedModelRow?.model ?? null;

  // Load titles already persisted for this PRD so the watcher's early inserts are not duplicated
  const existingRows = await db
    .select({ title: designDocs.title })
    .from(designDocs)
    .where(and(eq(designDocs.prdId, prdId), eq(designDocs.project, project)));
  const existingTitles = new Set(existingRows.map((r) => r.title));

  const createdIds: string[] = [];
  for (const feat of features) {
    const title = humanizeSlug(feat.slug);
    if (existingTitles.has(title)) {
      console.log(`[designDoc] Skipping duplicate feature row "${title}" (already created by watcher)`);
      continue;
    }
    const [row] = await db
      .insert(designDocs)
      .values({
        prdId,
        project,
        chatThreadId: null,
        authorId,
        title,
        model: seedModel,
        designContent: feat.design,
        techSpecContent: stripPrototypeArtifactsFromTechSpec(feat.techSpec),
        assumptionsContent: feat.assumptions,
        status: finalStatus,
      })
      .returning({ id: designDocs.id });
    createdIds.push(row.id);
    existingTitles.add(title);
    console.log(`[designDoc] Created per-feature row "${title}" (id=${row.id}, status=${finalStatus})`);
    propagateDesignDocApprovers(prdId, row.id, authorId).catch((err) => {
      console.error(`[designDoc] propagateDesignDocApprovers failed (prdId=${prdId}, docId=${row.id})`, err);
    });
  }

  // Null the seed row's chatThreadId — marks it as processed so the watcher skips creation
  await db
    .update(designDocs)
    .set({ chatThreadId: null, updatedAt: new Date().toISOString() })
    .where(eq(designDocs.id, seedId));

  if (finalStatus === 'validating') {
    for (const id of createdIds) {
      autoStartValidation(id).catch((err) => {
        console.error(`[designDoc] autoStartValidation failed (id=${id})`, err);
      });
    }
  }

  notifyAiCompletion('design_doc_generated', seedId, {
    title: `${features.length} design doc${features.length > 1 ? 's' : ''}`,
  }).catch(err =>
    console.error(`[designDoc] AI notification failed for design_doc_generated (seedId=${seedId}):`, err),
  );
}

export function startDesignDocWatcher(seedDocId: string, chatThreadId: string): void {
  stopDocWatcher(seedDocId);
  let attempts = 0;
  const createdSlugs = new Set<string>();
  let prevFoundSlugsKey = '';

  console.log(`[designDocWatcher] Started — seedDocId=${seedDocId} threadId=${chatThreadId}`);

  const interval = setInterval(async () => {
    attempts += 1;

    if (attempts > WATCHER_MAX_ATTEMPTS) {
      clearInterval(interval);
      activeDocWatchers.delete(seedDocId);
      console.warn(`[designDocWatcher] Timed out — resetting to draft (seedDocId=${seedDocId}, threadId=${chatThreadId})`);
      await db.update(designDocs)
        .set({ status: 'draft', updatedAt: new Date().toISOString() })
        .where(and(eq(designDocs.id, seedDocId), eq(designDocs.status, 'generating')));
      return;
    }

    // If syncOutputToDb already processed this run (it nulls seed's chatThreadId), just cleanup
    const seedDoc = await db.query.designDocs.findFirst({
      where: eq(designDocs.id, seedDocId),
      columns: { id: true, chatThreadId: true, prdId: true, project: true, authorId: true, model: true },
    });
    if (!seedDoc || !seedDoc.chatThreadId) {
      clearInterval(interval);
      activeDocWatchers.delete(seedDocId);
      await cleanupWorkspace(chatThreadId);
      console.log(`[designDocWatcher] syncOutputToDb handled creation — workspace cleaned (seedDocId=${seedDocId})`);
      return;
    }

    const features = readAllOutputDesignDocFeatures(chatThreadId);
    const currentSlugsKey = features.map((f) => f.slug).sort().join(',');

    console.log(
      `[designDocWatcher] tick #${attempts} — found=${features.length} created=${createdSlugs.size} (seedDocId=${seedDocId})`,
    );

    // Create rows for any newly complete features
    const newFeatures = features.filter((f) => !createdSlugs.has(f.slug));
    if (newFeatures.length > 0) {
      try {
        const skillConfig = await getSkillConfig(seedDoc.project);
        const finalStatus: DesignDocStatus = skillConfig?.designDocValidationSkillPath ? 'validating' : 'pending_review';

        for (const feat of newFeatures) {
          const [row] = await db
            .insert(designDocs)
            .values({
              prdId: seedDoc.prdId,
              project: seedDoc.project,
              chatThreadId: null,
              authorId: seedDoc.authorId,
              title: humanizeSlug(feat.slug),
              model: seedDoc.model ?? null,
              designContent: feat.design,
              techSpecContent: stripPrototypeArtifactsFromTechSpec(feat.techSpec),
              assumptionsContent: feat.assumptions,
              status: finalStatus,
            })
            .returning({ id: designDocs.id });
          createdSlugs.add(feat.slug);
          console.log(`[designDocWatcher] Created feature row "${humanizeSlug(feat.slug)}" (id=${row.id})`);
          propagateDesignDocApprovers(seedDoc.prdId, row.id, seedDoc.authorId).catch((err) => {
            console.error(`[designDocWatcher] propagateDesignDocApprovers failed (prdId=${seedDoc.prdId}, docId=${row.id})`, err);
          });
          if (finalStatus === 'validating') {
            autoStartValidation(row.id).catch((err) => {
              console.error(`[designDocWatcher] autoStartValidation failed (id=${row.id})`, err);
            });
          }
        }
      } catch (err) {
        console.error(`[designDocWatcher] Error creating feature rows`, err);
      }
    }

    // Done: the agent thread must be idle (finished) AND we found at least one
    // feature AND the set was stable across two consecutive ticks.  Without the
    // idle check, slow agents that write features one-by-one will trigger a
    // premature "stable" detection and the watcher cleans up mid-generation.
    const agentFinished = isThreadIdle(chatThreadId);
    const allDone = agentFinished && createdSlugs.size > 0 && currentSlugsKey === prevFoundSlugsKey && currentSlugsKey !== '';
    prevFoundSlugsKey = currentSlugsKey;

    if (allDone) {
      try {
        await db
          .update(designDocs)
          .set({ chatThreadId: null, updatedAt: new Date().toISOString() })
          .where(eq(designDocs.id, seedDocId));
      } catch (err) {
        console.error(`[designDocWatcher] Error clearing seed row chatThreadId`, err);
      }
      clearInterval(interval);
      activeDocWatchers.delete(seedDocId);
      await cleanupWorkspace(chatThreadId);
      console.log(`[designDocWatcher] Done — ${createdSlugs.size} feature(s) created, workspace cleaned (seedDocId=${seedDocId})`);
    }
  }, WATCHER_INTERVAL_MS);

  activeDocWatchers.set(seedDocId, interval);
}

export async function deleteDesignDoc(id: string, requestingUserId: string): Promise<void> {
  const row = await db.query.designDocs.findFirst({ where: eq(designDocs.id, id) });
  if (!row) throw notFound('Design doc not found');
  if (row.authorId !== requestingUserId && !(await isAdminUser(requestingUserId))) {
    throw forbidden('Only the author can delete this design doc');
  }
  stopDocWatcher(id);
  stopValidationWatcher(id);
  await db.delete(designDocs).where(eq(designDocs.id, id));
}

function rowToSummary(
  row: typeof designDocs.$inferSelect,
  reviewerName?: string | null,
  prdTitle?: string | null,
  authorName?: string | null,
  designDocOwnerId?: string | null,
  designDocOwnerName?: string | null,
): DesignDocSummary {
  const effectiveOwnerId = designDocOwnerId ?? row.authorId;
  const effectiveOwnerName = designDocOwnerName ?? authorName ?? undefined;
  return {
    id: row.id,
    prdId: row.prdId,
    prdTitle: prdTitle ?? undefined,
    project: row.project,
    chatThreadId: row.chatThreadId,
    qaChatThreadId: row.qaChatThreadId ?? null,
    docAssistantThreadId: row.docAssistantThreadId ?? null,
    validationThreadId: row.validationThreadId ?? null,
    validationScore: row.validationScore ?? null,
    validationScorecard: (row.validationScorecard as ValidationScorecard | null) ?? null,
    validationReportMd: row.validationReportMd ?? null,
    validationPhase: row.validationPhase ?? null,
    fixBaseline: (row.fixBaseline as ContentSnapshot | null) ?? null,
    authorId: row.authorId,
    authorName: authorName ?? undefined,
    ownerId: effectiveOwnerId,
    ownerName: effectiveOwnerName,
    title: row.title,
    model: row.model ?? undefined,
    status: row.status as DesignDocStatus,
    reviewerId: row.reviewerId ?? undefined,
    reviewerName: reviewerName ?? undefined,
    reviewComment: row.reviewComment ?? undefined,
    reviewedAt: row.reviewedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function autoStartValidation(designDocId: string): Promise<void> {
  // #region agent log
  try{fs.appendFileSync('debug-d6e0f6.log',JSON.stringify({sessionId:'d6e0f6',location:'designDocService.ts:autoStartValidation:entry',message:'autoStartValidation called',data:{designDocId},timestamp:Date.now(),hypothesisId:'H-B'})+'\n');}catch(_){}
  // #endregion
  const doc = await getDesignDoc(designDocId);
  if (!doc) {
    // #region agent log
    try{fs.appendFileSync('debug-d6e0f6.log',JSON.stringify({sessionId:'d6e0f6',location:'designDocService.ts:autoStartValidation:no-doc',message:'autoStartValidation early exit: doc not found',data:{designDocId},timestamp:Date.now(),hypothesisId:'H-B'})+'\n');}catch(_){}
    // #endregion
    return;
  }

  const skillConfig = await getSkillConfig(doc.project);
  if (!skillConfig?.designDocValidationSkillPath) {
    // #region agent log
    try{fs.appendFileSync('debug-d6e0f6.log',JSON.stringify({sessionId:'d6e0f6',location:'designDocService.ts:autoStartValidation:no-skill',message:'autoStartValidation early exit: no skill config',data:{designDocId,project:doc.project,hasSkillConfig:!!skillConfig,validationSkillPath:skillConfig?.designDocValidationSkillPath??null},timestamp:Date.now(),hypothesisId:'H-B'})+'\n');}catch(_){}
    // #endregion
    return;
  }

  const globalModel = await getDefaultModel();
  const model = skillConfig.designDocValidationModel ?? globalModel;

  const prd = doc.prdId ? await getPrd(doc.prdId) : null;

  const context = [
    '# Design Doc Validation Context',
    `doc_id: ${designDocId}`,
    '',
    ...(prd ? ['## Source PRD', prd.content || '(empty)', ''] : []),
    '## Design',
    doc.designContent || '(empty)',
    '',
    '## Tech Spec',
    doc.techSpecContent || '(empty)',
    '',
    '## Assumptions',
    doc.assumptionsContent || '(empty)',
  ].join('\n');

  const thread = await createChatThread(doc.authorId, {
    project: doc.project,
    repo: skillConfig.skillRepo,
    branch: skillConfig.skillBranch ?? 'main',
    skillPath: skillConfig.designDocValidationSkillPath,
    freeformContext: context,
    model,
  });

  // #region agent log
  try{fs.appendFileSync('debug-d6e0f6.log',JSON.stringify({sessionId:'d6e0f6',location:'designDocService.ts:autoStartValidation:thread-created',message:'new validation thread created',data:{designDocId,newThreadId:thread.id,docStatus:doc.status,prevValidationThreadId:doc.validationThreadId??null,skillRepo:skillConfig.skillRepo,skillBranch:skillConfig.skillBranch??'main',skillPath:skillConfig.designDocValidationSkillPath,model},timestamp:Date.now(),hypothesisId:'H-A'})+'\n');}catch(_){}
  // #endregion

  // Stop any existing watcher before starting a new one
  stopValidationWatcher(designDocId);

  const statusAllowsValidation: DesignDocStatus[] = ['generating', 'pending_review', 'draft', 'revision_requested', 'validating'];
  const newStatus = statusAllowsValidation.includes(doc.status as DesignDocStatus) ? 'validating' : undefined;

  await db.update(designDocs)
    .set({
      validationThreadId: thread.id,
      validationScore: null,
      validationScorecard: null,
      validationReportMd: null,
      validationPhase: null,
      ...(newStatus ? { status: newStatus } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(designDocs.id, designDocId));

  // #region agent log
  try{fs.appendFileSync('debug-d6e0f6.log',JSON.stringify({sessionId:'d6e0f6',location:'designDocService.ts:autoStartValidation:db-updated',message:'DB updated, watcher starting',data:{designDocId,newThreadId:thread.id,newStatus:newStatus??'not-updated'},timestamp:Date.now(),hypothesisId:'H-A'})+'\n');}catch(_){}
  // #endregion

  startValidationWatcher(designDocId, thread.id);
}

const VALIDATION_WATCHER_INTERVAL_MS = 5_000;
const VALIDATION_WATCHER_MAX_ATTEMPTS = 720;

export function startValidationWatcher(designDocId: string, validationThreadId: string): void {
  stopValidationWatcher(designDocId);
  let attempts = 0;

  console.log(`[validationWatcher] Started — designDocId=${designDocId} threadId=${validationThreadId}`);

  const interval = setInterval(async () => {
    attempts += 1;

    if (attempts > VALIDATION_WATCHER_MAX_ATTEMPTS) {
      clearInterval(interval);
      activeValidationWatchers.delete(designDocId);
      console.warn(`[validationWatcher] Timed out (designDocId=${designDocId})`);
      // Reset stuck 'validating' status so the user can re-run
      await db.update(designDocs)
        .set({ status: 'draft', updatedAt: new Date().toISOString() })
        .where(and(eq(designDocs.id, designDocId), eq(designDocs.status, 'validating')));
      return;
    }

    // #region agent log
    if (attempts <= 3) {
      try{fs.appendFileSync('debug-d6e0f6.log',JSON.stringify({sessionId:'d6e0f6',location:'designDocService.ts:watcher:tick',message:`watcher tick #${attempts}`,data:{designDocId,validationThreadId,attempts},timestamp:Date.now(),hypothesisId:'H-D'})+'\n');}catch(_){}
    }
    // #endregion

    const scorecardRaw = readOutputValidationScorecard(validationThreadId);
    // #region agent log
    if (attempts <= 3) {
      try{fs.appendFileSync('debug-d6e0f6.log',JSON.stringify({sessionId:'d6e0f6',location:'designDocService.ts:watcher:scorecard-check',message:`watcher tick #${attempts} scorecard result`,data:{designDocId,validationThreadId,found:scorecardRaw!==null},timestamp:Date.now(),hypothesisId:'H-D'})+'\n');}catch(_){}
    }
    // #endregion

    if (!scorecardRaw) {
      // If the agent has completed or errored without producing a scorecard,
      // reset the doc status to draft so the user can re-run.
      // The `status = 'validating'` WHERE guard prevents downgrading an already-scored doc.
      if (isThreadIdle(validationThreadId)) {
        clearInterval(interval);
        activeValidationWatchers.delete(designDocId);
        console.warn(`[validationWatcher] Agent completed/errored without scorecard — resetting to draft (designDocId=${designDocId} threadId=${validationThreadId})`);
        // #region agent log
        try{fs.appendFileSync('debug-d6e0f6.log',JSON.stringify({sessionId:'d6e0f6',location:'designDocService.ts:watcher:agent-error-reset',message:'agent completed without scorecard, resetting to draft',data:{designDocId,validationThreadId,attempts},timestamp:Date.now(),hypothesisId:'H-A'})+'\n');}catch(_){}
        // #endregion
        await db.update(designDocs)
          .set({ status: 'draft', updatedAt: new Date().toISOString() })
          .where(and(eq(designDocs.id, designDocId), eq(designDocs.status, 'validating')));
      }
      return;
    }

    clearInterval(interval);
    activeValidationWatchers.delete(designDocId);

    try {
      // Guard: verify this watcher's thread is still the active validation thread.
      // A newer autoStartValidation call may have replaced validationThreadId,
      // in which case this result is stale and must be discarded.
      const currentDoc = await db.query.designDocs.findFirst({
        where: eq(designDocs.id, designDocId),
        columns: { validationThreadId: true },
      });
      if (currentDoc?.validationThreadId !== validationThreadId) {
        console.log(`[validationWatcher] Discarded stale result — thread ${validationThreadId} no longer active (designDocId=${designDocId})`);
        cleanupWorkspace(validationThreadId);
        return;
      }

      const scorecard = JSON.parse(scorecardRaw) as ValidationScorecard;
      const reportMd = readOutputValidationScorecardMd(validationThreadId) ?? undefined;
      await syncValidationResult(designDocId, scorecard, reportMd);
      console.log(`[validationWatcher] Scorecard synced — score=${scorecard.overall_score} is_ready=${scorecard.is_ready} (designDocId=${designDocId})`);
      cleanupWorkspace(validationThreadId);
    } catch (err) {
      console.error(`[validationWatcher] Failed to parse/sync scorecard (designDocId=${designDocId})`, err);
    }
  }, VALIDATION_WATCHER_INTERVAL_MS);

  activeValidationWatchers.set(designDocId, interval);
}

export function generateFallbackReport(scorecard: ValidationScorecard): string {
  const lines: string[] = [
    `# Validation Report`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Overall Score | **${scorecard.overall_score}%** |`,
    `| Verdict | ${scorecard.verdict.replace(/_/g, ' ')} |`,
    `| Phase | ${scorecard.review_phase} |`,
    `| Ready | ${scorecard.is_ready ? 'Yes' : 'No'} |`,
    '',
  ];

  if ((scorecard.features ?? []).length > 0) {
    lines.push('## Feature Scores', '');
    lines.push('| Feature | Design | Tech Spec | Assumptions | Overall | Verdict |');
    lines.push('|---------|--------|-----------|-------------|---------|---------|');
    for (const f of scorecard.features!) {
      lines.push(`| ${f.feature_title} | ${f.design_score}% | ${f.tech_spec_score}% | ${f.assumptions_score}% | ${f.overall_score}% | ${f.verdict} |`);
    }
    lines.push('');

    const allGaps = scorecard.features!.flatMap((f) => f.gaps.filter((g) => g.resolution === 'pending'));
    if (allGaps.length > 0) {
      lines.push('## Open Gaps', '');
      for (const gap of allGaps) {
        lines.push(`- **${gap.section}** (${gap.file}): ${gap.description} — Score: ${gap.score}/3`);
      }
      lines.push('');
    }
  }

  const crossCuttingEntries = Object.entries(scorecard.cross_cutting_checks ?? {});
  if (crossCuttingEntries.length > 0) {
    lines.push('## Cross-Cutting Checks', '');
    for (const [check, result] of crossCuttingEntries) {
      lines.push(`- **${check}**: ${result}`);
    }
    lines.push('');
  }

  if ((scorecard.accepted_gaps ?? []).length > 0) {
    lines.push('## Accepted Gaps', '');
    for (const g of scorecard.accepted_gaps!) lines.push(`- ${g}`);
    lines.push('');
  }

  if ((scorecard.deferred_gaps ?? []).length > 0) {
    lines.push('## Deferred Gaps', '');
    for (const g of scorecard.deferred_gaps!) lines.push(`- ${g}`);
    lines.push('');
  }

  return lines.join('\n');
}

export async function syncValidationResult(
  designDocId: string,
  scorecard: ValidationScorecard,
  reportMd?: string,
): Promise<void> {
  const newStatus: DesignDocStatus | undefined = scorecard.is_ready ? 'pending_review' : 'draft';
  const effectiveReportMd = reportMd ?? generateFallbackReport(scorecard);
  const updates: Partial<typeof designDocs.$inferInsert> = {
    validationScore: Math.round(scorecard.overall_score),
    validationScorecard: scorecard,
    validationPhase: scorecard.review_phase,
    validationReportMd: effectiveReportMd,
    updatedAt: new Date().toISOString(),
  };
  if (newStatus) updates.status = newStatus;

  await db.update(designDocs).set(updates).where(eq(designDocs.id, designDocId));

  notifyAiCompletion('design_doc_validation_complete', designDocId, {
    title: '',
    score: Math.round(scorecard.overall_score),
    passed: scorecard.is_ready,
  }).catch(err =>
    console.error(`[designDocValidation] AI notification failed (docId=${designDocId}):`, err),
  );

  if (newStatus === 'pending_review') {
    notifyApproversDocumentReady(designDocId, 'design_doc').catch((err) =>
      console.error(`[syncValidationResult] Failed to notify approvers (docId=${designDocId})`, err),
    );
  }
}

export async function cancelValidation(id: string, requestingUserId: string): Promise<void> {
  const row = await db.query.designDocs.findFirst({ where: eq(designDocs.id, id) });
  if (!row) throw notFound('Design doc not found');
  if (row.authorId !== requestingUserId && !(await isAdminUser(requestingUserId))) {
    throw forbidden('Only the author can cancel validation');
  }
  if (row.status !== 'validating') throw conflict(`Cannot cancel validation from status '${row.status}'`);

  // #region agent log
  try{fs.appendFileSync('debug-d6e0f6.log',JSON.stringify({sessionId:'d6e0f6',location:'designDocService.ts:cancelValidation',message:'cancelValidation called — old thread NOT SDK-cancelled',data:{designDocId:id,oldValidationThreadId:row.validationThreadId??null},timestamp:Date.now(),hypothesisId:'H-A'})+'\n');}catch(_){}
  // #endregion

  stopValidationWatcher(id);

  // Cancel the running SDK agent so it doesn't linger as a ghost run
  // and potentially trigger "already has active run" errors on re-runs.
  if (row.validationThreadId) {
    cancelRun(row.validationThreadId).catch((err: Error) => {
      console.warn(`[cancelValidation] Could not cancel agent run for thread ${row.validationThreadId}:`, err.message);
    });
  }

  await db.update(designDocs)
    .set({ status: 'draft', updatedAt: new Date().toISOString() })
    .where(eq(designDocs.id, id));
}

export async function markValidationReady(id: string, requestingUserId: string): Promise<void> {
  const row = await db.query.designDocs.findFirst({ where: eq(designDocs.id, id) });
  if (!row) throw notFound('Design doc not found');
  if (row.authorId !== requestingUserId && !(await isAdminUser(requestingUserId))) {
    throw forbidden('Only the author can mark validation as ready');
  }
  if (row.status !== 'validating') throw conflict(`Cannot mark ready from status '${row.status}'`);
  if (!row.validationScore || row.validationScore < 90) {
    const err = new Error(`Validation score must be >= 90. Current: ${row.validationScore ?? 'not scored'}`);
    (err as any).status = 409;
    throw err;
  }

  await db.update(designDocs)
    .set({ status: 'pending_review', updatedAt: new Date().toISOString() })
    .where(eq(designDocs.id, id));

  notifyApproversDocumentReady(id, 'design_doc').catch((err) =>
    console.error(`[markValidationReady] Failed to notify approvers (docId=${id})`, err),
  );
}

// ── Fix Validation Flow ───────────────────────────────────────────────────────

export async function triggerFixValidation(
  designDocId: string,
  userId: string,
): Promise<{ threadId: string }> {
  const doc = await getDesignDoc(designDocId);
  if (!doc) throw notFound('Design doc not found');

  if (doc.status !== 'draft' && doc.status !== 'revision_requested') {
    throw conflict(`Cannot fix validation from status '${doc.status}'`);
  }
  if (!doc.validationScorecard) {
    throw conflict('No validation scorecard available to fix');
  }

  // Baseline is written initially without fixThreadId; it gets updated with
  // the thread ID once the thread is created/reused (see below).
  const baseline: ContentSnapshot = {
    design: doc.designContent || '',
    techSpec: doc.techSpecContent || '',
    assumptions: doc.assumptionsContent || '',
    capturedAt: new Date().toISOString(),
  };

  // Create or reuse the doc assistant thread
  const skillConfig = await getSkillConfig(doc.project);
  const globalModel = await getDefaultModel();
  const model = skillConfig?.designDocAssistantModel ?? globalModel;

  const prd = doc.prdId ? await getPrd(doc.prdId) : null;

  // Only reuse the stored assistant thread if it belongs to the requesting user.
  // Reviewers with `interviews:view` can open the assistant panel and will write
  // their own thread ID into docAssistantThreadId; if a different user then tries
  // to run a fix, their poll of GET /api/chat/threads/:id would get a 404 because
  // threads are user-scoped.
  let threadId: string | null = null;
  if (doc.docAssistantThreadId) {
    const [ownerRow] = await db
      .select({ userId: chatThreads.userId })
      .from(chatThreads)
      .where(eq(chatThreads.id, doc.docAssistantThreadId))
      .limit(1);
    if (ownerRow?.userId === userId) {
      threadId = doc.docAssistantThreadId;
    }
  }

  if (!threadId) {
    const buildDocContext = (tId: string) => [
      '# Design Doc Assistant Context',
      `doc_id: ${designDocId}`,
      `thread_id: ${tId}`,
      `status: ${doc.status}`,
      '',
      '> Use the `update_design_doc` MCP tool to apply edits back to the database.',
      '> Pass the doc_id and thread_id values above when calling the tool.',
      '',
      ...(prd ? ['## Source PRD', prd.content || '(empty)', ''] : []),
      '## Design',
      doc.designContent || '(empty)',
      '',
      '## Tech Spec',
      doc.techSpecContent || '(empty)',
      '',
      '## Assumptions',
      doc.assumptionsContent || '(empty)',
    ].join('\n');

    const thread = await createChatThread(userId, {
      project: doc.project,
      repo: skillConfig?.skillRepo ?? doc.project,
      branch: skillConfig?.skillBranch ?? 'main',
      skillPath: skillConfig?.designDocAssistantSkillPath ?? undefined,
      freeformContext: buildDocContext('__THREAD_ID__'),
      model,
    }, { skipAutoKickoff: true });

    const contextPath = path.join(thread.workspaceDir, '.ai-pilot', 'kickoff-context.md');
    fs.writeFileSync(contextPath, buildDocContext(thread.id), 'utf-8');

    threadId = thread.id;

    await db.update(designDocs)
      .set({ docAssistantThreadId: thread.id, updatedAt: new Date().toISOString() })
      .where(eq(designDocs.id, designDocId));
  } else {
    // Refresh kickoff context so the assistant sees current content
    const [threadRow] = await db
      .select({ workspaceDir: chatThreads.workspaceDir })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId))
      .limit(1);
    if (threadRow?.workspaceDir) {
      const contextPath = path.join(threadRow.workspaceDir, '.ai-pilot', 'kickoff-context.md');
      const context = [
        '# Design Doc Assistant Context',
        `doc_id: ${designDocId}`,
        `thread_id: ${threadId}`,
        `status: ${doc.status}`,
        '',
        '> Use the `update_design_doc` MCP tool to apply edits back to the database.',
        '> Pass the doc_id and thread_id values above when calling the tool.',
        '',
        ...(prd ? ['## Source PRD', prd.content || '(empty)', ''] : []),
        '## Design',
        doc.designContent || '(empty)',
        '',
        '## Tech Spec',
        doc.techSpecContent || '(empty)',
        '',
        '## Assumptions',
        doc.assumptionsContent || '(empty)',
      ].join('\n');
      try {
        fs.writeFileSync(contextPath, context, 'utf-8');
      } catch { /* non-fatal */ }
    }
  }

  // Persist the baseline with the fix thread ID so recovery can find the
  // correct thread even if docAssistantThreadId is later overwritten.
  baseline.fixThreadId = threadId;
  await db.update(designDocs)
    .set({ fixBaseline: baseline, updatedAt: new Date().toISOString() })
    .where(eq(designDocs.id, designDocId));

  // Build the structured fix prompt from the validation scorecard
  const scorecard = doc.validationScorecard;

  // Group pending gaps by section so the AI can address each section systematically
  const gapsBySection: Record<string, ValidationScorecardGap[]> = {};
  for (const f of (scorecard.features ?? [])) {
    for (const g of f.gaps) {
      if (g.resolution !== 'pending') continue;
      const sec = g.section.toLowerCase();
      const key = sec.includes('tech') || sec.includes('spec') ? 'tech-spec'
        : sec.includes('assumption') ? 'assumptions'
        : 'design';
      (gapsBySection[key] ??= []).push(g);
    }
  }

  const sectionBlocks: string[] = [];
  const sectionNames: Record<string, string> = { 'design': 'Design', 'tech-spec': 'Tech Spec', 'assumptions': 'Assumptions' };
  const sectionContent: Record<string, string> = {
    'design': doc.designContent || '(empty)',
    'tech-spec': doc.techSpecContent || '(empty)',
    'assumptions': doc.assumptionsContent || '(empty)',
  };

  for (const [sectionKey, gaps] of Object.entries(gapsBySection) as [string, ValidationScorecardGap[]][]) {
    sectionBlocks.push([
      `### ${sectionNames[sectionKey] ?? sectionKey} Section`,
      '',
      `**Current content:**`,
      '```markdown',
      sectionContent[sectionKey],
      '```',
      '',
      `**Gaps to fix in this section (${gaps.length}):**`,
      '',
      ...gaps.map((g, i) => [
        `#### Gap ${i + 1}: ${g.description}`,
        `- **Gap ID:** ${g.id}`,
        `- **Current Score:** ${g.score}/3`,
        `- **Target (what a 3 looks like):** ${g.what_3_looks_like}`,
        '',
      ].join('\n')),
    ].join('\n'));
  }

  const sectionsToUpdate = Object.keys(gapsBySection);
  const pendingGaps = Object.values(gapsBySection).flat();

  const scoreDeficit = 90 - scorecard.overall_score;

  const prompt = [
    '# Fix Validation Gaps',
    '',
    `The validation scorecard scored this design doc at **${scorecard.overall_score}%** (needs ≥90%). The score must increase by at least ${scoreDeficit} percentage points. There are ${pendingGaps.length} gaps across ${sectionsToUpdate.length} section(s) that must be fixed.`,
    '',
    '## ⚠️ MOST IMPORTANT INSTRUCTION — YOU MUST CALL THE TOOL',
    '',
    '**Your changes are ONLY saved if you call `update_design_doc`.** If you skip the tool call, NOTHING is persisted and the fix fails entirely.',
    '',
    `You MUST call \`update_design_doc\` once for EACH section that has gaps: ${sectionsToUpdate.map(s => `"${s}"`).join(', ')}.`,
    `Every call requires: doc_id="${designDocId}", thread_id="${threadId}", the section name, and the FULL updated markdown content.`,
    '',
    'Do NOT describe changes without calling the tool. Do NOT output a summary first and then "plan to call" the tool. Call the tool IMMEDIATELY for each section as you finish rewriting it.',
    '',
    '## How Scoring Works',
    '',
    'Each gap is scored 1-3. A score of 1 means the topic is absent or superficial, 2 means partially addressed, and 3 means fully addressed with specifics. The overall percentage is derived from the average of all gap scores. To push above 90%, every gap currently scored 1 or 2 must reach a 3.',
    '',
    '**What it takes to earn a 3:** The "what a 3 looks like" description for each gap is the EXACT rubric the validator uses. You must write content that directly and completely satisfies that description — not just acknowledge it, but provide the actual details, plans, tables, or specifications it calls for.',
    '',
    '## Your Task',
    '',
    'For EACH section listed below:',
    '1. Read the current content and all gaps for that section.',
    '2. Write a COMPLETE, UPDATED version of the section that addresses EVERY gap to a score of 3.',
    '3. The updated content must be **substantially improved** — add missing details, add new subsections, expand thin areas, add specifics where the current content is vague.',
    '4. **Immediately call `update_design_doc`** with the full section content.',
    '',
    '**CRITICAL RULES:**',
    '- Each call must contain the ENTIRE section content (not a patch — the tool replaces the whole section).',
    '- Do NOT just add a sentence or two. Each gap requires substantive content additions — paragraphs, bullet lists, tables, diagrams, or detailed specifications as appropriate.',
    '- Match the "what a 3 looks like" description for every gap EXACTLY. If it says "detailed migration plan," write a real multi-step migration plan with rollback steps. If it says "specific error handling strategy," write actual error codes, retry logic, and fallback behavior.',
    '- Preserve all existing content that is correct — only add or improve, do not remove valid content.',
    '',
    '## Sections & Gaps',
    '',
    ...sectionBlocks,
    '',
    '## Required: Per-Gap Change Report',
    '',
    'After making ALL `update_design_doc` calls, you MUST output a change report as the LAST thing in your response.',
    'Use EXACTLY this format (the system parses this programmatically to show inline diffs):',
    '',
    '```json',
    '<!-- GAP_CHANGES_START -->',
    JSON.stringify({
      gap_changes: pendingGaps.slice(0, 2).map((g) => ({
        gap_id: g.id,
        what_changed: '(one-sentence summary of what you changed for this gap)',
        old_text: '(REQUIRED: copy the EXACT original text from "Current content" that you replaced — the specific paragraph or block. Use "" only if this was entirely new content with no original to replace)',
        new_text: '(REQUIRED: copy the EXACT new text you wrote as the replacement. This will be diffed against old_text for the reviewer)',
      })),
    }, null, 2).replace(/\]$/, '  ...\n]'),
    '<!-- GAP_CHANGES_END -->',
    '```',
    '',
    `Include an entry for ALL ${pendingGaps.length} gaps, not just the examples above.`,
    '',
    '**old_text and new_text are MANDATORY for every gap.** They are shown as an inline diff to the reviewer:',
    '- `old_text`: The exact verbatim text from the "Current content" shown above that you modified or replaced. Copy it character-for-character.',
    '- `new_text`: The exact verbatim text you wrote in its place. Copy it character-for-character from what you passed to `update_design_doc`.',
    '- If you added entirely new content (no original text was replaced), set `old_text` to `""` and put the new content in `new_text`.',
    '- These fields MUST be non-empty strings (except old_text for pure additions). The reviewer depends on them to see exactly what changed.',
  ].join('\n');

  // Fire-and-forget: sendMessage streams the full agent run (blocks until done).
  // We return the threadId immediately so the client can poll thread status.
  void sendMessage(threadId, prompt).catch((err) => {
    console.error(`[designDoc] fix-validation sendMessage error for thread ${threadId}:`, err);
  });

  return { threadId };
}

export async function acceptFixValidation(designDocId: string): Promise<void> {
  const row = await db.query.designDocs.findFirst({ where: eq(designDocs.id, designDocId) });
  if (!row) throw notFound('Design doc not found');

  await db.update(designDocs)
    .set({ fixBaseline: null, updatedAt: new Date().toISOString() })
    .where(eq(designDocs.id, designDocId));

  notifyAiCompletion('design_doc_fix_complete', designDocId, { title: row.title }).catch(err =>
    console.error(`[designDocFix] AI notification failed (docId=${designDocId}):`, err),
  );

  await autoStartValidation(designDocId);
}

// Ensure assertValidStatus is used (suppress unused warning)
void assertValidStatus;
