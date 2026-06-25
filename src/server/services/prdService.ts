import fs from 'fs';
import { and, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/drizzle';
import { prds, appUsers, chatThreads, interviews, testCases, designDocs, designPrototypes, reviewComments, documentApproverAssignments } from '../db/schema';

const authorUser = alias(appUsers, 'author_user');
const prdOwnerUser = alias(appUsers, 'prd_owner_user');
import type { Prd, PrdStatus, PrdSummary, PrdValidationBaseline, ReviewPrdRequest, TestCaseSummary, ValidationScorecard } from '../../shared/types/interview';
import type { CreatePrdAdoItemsRequest, CreatePrdAdoItemsResponse, SelectedBacklogEpic, SelectedBacklogFeature, SelectedBacklogPBI, GlobalBusinessRule, DependencyGraphNode } from '../../shared/types/interview';
import { readOutputPrd, readOutputBacklog, sendMessage, createThread as createChatThread } from './chatAgentService';
import { notifyAiCompletion } from './aiCompletionNotifier';
import { createNotification } from './notificationService';
import { isAdminUser } from '../utils/rbacHelpers';
import { assignApprovers, recordApproverResponse, isAssignedApprover, isApprovalComplete, notifyApproversDocumentReady } from './documentApprovalService';
import { getUnresolvedCount } from './reviewCommentService';
import { AzureDevOpsService } from '../services/azureDevOps';
import { adoWriteFromToken } from '../services/adoFactory';
import { listDesignDocs } from '../services/designDocService';
import { extractFeatures } from '../services/designPrototypeService';
import { stampAdoIds } from '../../shared/utils/backlogTransform';
import { derivePrdReadiness } from '../../shared/utils/prdReadiness';
import { BACKLOG_USER_TYPE_CONVENTIONS_MD } from '../../shared/utils/backlogUserTypeConventions';
import { getTestCases, listLatestTestCaseSummariesForPrds } from './testCaseService';
import { getSkillConfig, resolveSkillConfig, getSkillSettingsName } from './projectSettingsService';
import { getDefaultModel } from './appSettingsService';
import {
  autoStartDocumentValidation,
  cancelDocumentValidation,
  generateFallbackReport,
  isDocumentValidationWatcherActive,
  startDocumentValidationWatcher,
  stopDocumentValidationWatcher,
  type DocumentValidationAdapter,
} from './documentValidationService';

const VALID_PRD_STATUSES: PrdStatus[] = ['generating', 'draft', 'validating', 'pending_review', 'reviewer_approved', 'approved', 'revision_requested'];

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

async function notifyOwnerPendingApproval(
  prdId: string,
  title: string,
  interviewId: string | null,
): Promise<void> {
  try {
    const ownerId = await getPrdOwnerId(interviewId);
    if (!ownerId) return;
    await createNotification(ownerId, {
      type: 'user-action',
      title: 'PRD is pending your final approval',
      body: `"${title}" has passed reviewer approval and needs your approval`,
      link: `/backlog/prd/${prdId}`,
    });
  } catch (err) {
    console.error(`[notifyOwnerPendingApproval] Failed (prdId=${prdId}):`, err);
  }
}

async function resolveOwnerEmail(oid: string | null | undefined): Promise<string | undefined> {
  if (!oid) return undefined;
  try {
    const rows = await db
      .select({ email: appUsers.email })
      .from(appUsers)
      .where(eq(appUsers.oid, oid))
      .limit(1);
    return rows[0]?.email ?? undefined;
  } catch {
    return undefined;
  }
}

function buildStepsXml(steps: Array<string | { action: string; expected?: string }>): string {
  if (!steps || steps.length === 0) return '';
  const stepElements = steps.map((step, i) => {
    const action = typeof step === 'string' ? step : (step.action ?? '');
    const expected = typeof step === 'string' ? '' : (step.expected ?? '');
    const escapedAction = action.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escapedExpected = expected.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<step id="${i + 1}" type="ActionStep"><parameterizedString isformatted="true">${escapedAction}</parameterizedString><parameterizedString isformatted="true">${escapedExpected}</parameterizedString></step>`;
  });
  return `<steps id="0" last="${steps.length}">${stepElements.join('')}</steps>`;
}

/**
 * Best-effort read of an interview's conversation as a plain-text transcript,
 * used to ground persona/user-type enrichment in the BA's own words. Returns
 * null when the interview, its thread, or any messages are unavailable.
 */
async function readInterviewTranscript(interviewId: string): Promise<string | null> {
  try {
    const interview = await db.query.interviews.findFirst({
      where: eq(interviews.id, interviewId),
      columns: { chatThreadId: true },
    });
    if (!interview?.chatThreadId) return null;

    const { getThreadAsync } = await import('./chatAgentService');
    const thread = await getThreadAsync(interview.chatThreadId);
    if (!thread) return null;

    const lines: string[] = [];
    for (const msg of thread.messages) {
      if (msg.role === 'user' && msg.text && msg.text !== 'Begin.') {
        lines.push(`BA: ${msg.text}`);
      } else if (msg.role === 'agent' && msg.text) {
        lines.push(`Interviewer: ${msg.text}`);
      }
    }
    return lines.length > 0 ? lines.join('\n\n') : null;
  } catch {
    return null;
  }
}

export async function createPrd(opts: {
  interviewId: string;
  project: string;
  userId: string;
  chatThreadId: string;
  title?: string;
  model?: string;
  skillSettingsId?: string | null;
}): Promise<{ prdId: string; threadId: string }> {
  const [row] = await db
    .insert(prds)
    .values({
      interviewId: opts.interviewId,
      project: opts.project,
      chatThreadId: opts.chatThreadId,
      authorId: opts.userId,
      title: opts.title ?? 'Untitled PRD',
      model: opts.model ?? null,
      skillSettingsId: opts.skillSettingsId ?? null,
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

  const latestTestCases = await listLatestTestCaseSummariesForPrds(
    rows.map(({ prd }) => prd.id),
  );

  const projects = [...new Set(rows.map(({ prd }) => prd.project))];
  const thresholdByProject = new Map<string, number | null>();
  await Promise.all(projects.map(async (p) => {
    const cfg = await getSkillConfig(p);
    thresholdByProject.set(p, cfg?.prdValidationScoreThreshold ?? null);
  }));

  const uniqueSettingsIds = [...new Set(rows.map(({ prd }) => prd.skillSettingsId).filter(Boolean))] as string[];
  const settingsNameEntries = await Promise.all(uniqueSettingsIds.map(async (id) => [id, await getSkillSettingsName(id)] as const));
  const settingsNameMap = new Map(settingsNameEntries);

  return rows.map(({ prd, reviewerDisplayName, authorDisplayName, prdOwnerId, prdOwnerDisplayName }) => ({
    ...rowToPrdSummary(
      prd,
      reviewerDisplayName,
      authorDisplayName,
      prdOwnerId,
      prdOwnerDisplayName,
      latestTestCases.get(prd.id) ?? null,
      prd.skillSettingsId ? settingsNameMap.get(prd.skillSettingsId) ?? null : null,
    ),
    validationScoreThreshold: thresholdByProject.get(prd.project) ?? null,
  }));
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
  const [latestTestCase, skillConfig, skillSettingsName] = await Promise.all([
    getTestCases(id),
    resolveSkillConfig({ project: row.project, settingsId: row.skillSettingsId ?? undefined }),
    getSkillSettingsName(row.skillSettingsId),
  ]);
  return {
    ...rowToPrdSummary(row, reviewerDisplayName, authorDisplayName, prdOwnerId, prdOwnerDisplayName, latestTestCase, skillSettingsName),
    content: row.content,
    backlogJson: row.backlogJson ?? undefined,
    prdAssistantThreadId: row.prdAssistantThreadId ?? null,
    proposedContent: row.proposedContent ?? null,
    proposedBacklogJson: row.proposedBacklogJson ?? undefined,
    designDocApproverIds: row.designDocApproverIds ?? undefined,
    validationThreadId: row.validationThreadId ?? null,
    validationScore: row.validationScore ?? null,
    validationScorecard: (row.validationScorecard as ValidationScorecard | null) ?? null,
    validationReportMd: row.validationReportMd ?? null,
    validationPhase: row.validationPhase ?? null,
    fixBaseline: (row.fixBaseline as PrdValidationBaseline | null) ?? null,
    prdValidationEnabled: !!skillConfig?.prdValidationSkillPath,
    validationScoreThreshold: skillConfig?.prdValidationScoreThreshold ?? null,
    fixCommentId: row.fixCommentId ?? null,
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
  opts?: {
    prdApproverIds?: string[];
    designDocApproverIds?: string[];
    designPrototypeApproverIds?: string[];
    qaApproverIds?: string[];
  },
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
  const skillConfig = await resolveSkillConfig({ project: row.project, settingsId: row.skillSettingsId ?? undefined });
  const readiness = derivePrdReadiness(
    {
      status: row.status as PrdStatus,
      content: row.content,
      validationScore: row.validationScore,
      validationScorecard: row.validationScorecard as ValidationScorecard | null,
    },
    await getTestCases(id),
    skillConfig?.prdValidationScoreThreshold ?? undefined,
  );
  if (!readiness.readyForReviewActions) {
    throw conflict(readiness.blockingReason ?? 'PRD QA readiness must complete before review');
  }

  let effectivePrdApproverIds = opts?.prdApproverIds;
  let effectiveDdApproverIds = opts?.designDocApproverIds;
  let effectivePrototypeApproverIds = opts?.designPrototypeApproverIds;
  let effectiveQaApproverIds = opts?.qaApproverIds;

  if ((!effectivePrdApproverIds || effectivePrdApproverIds.length === 0) && row.interviewId) {
    const interview = await db.query.interviews.findFirst({
      where: eq(interviews.id, row.interviewId),
      columns: { prdApproverIds: true, designDocApproverIds: true, designPrototypeApproverIds: true, testCaseApproverIds: true },
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
    if (!effectiveQaApproverIds || effectiveQaApproverIds.length === 0) {
      effectiveQaApproverIds = interview?.testCaseApproverIds ?? undefined;
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

  if (effectiveQaApproverIds && effectiveQaApproverIds.length > 0) {
    await assignApprovers(id, 'test_case', effectiveQaApproverIds, requestingUserId);
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
  const reviewSkillConfig = await resolveSkillConfig({ project: row.project, settingsId: row.skillSettingsId ?? undefined });
  const readiness = derivePrdReadiness(
    {
      status: row.status as PrdStatus,
      content: row.content,
      validationScore: row.validationScore,
      validationScorecard: row.validationScorecard as ValidationScorecard | null,
    },
    await getTestCases(id),
    reviewSkillConfig?.prdValidationScoreThreshold ?? undefined,
  );
  if (!readiness.readyForReviewActions) {
    throw conflict(readiness.blockingReason ?? 'PRD QA readiness must complete before approval');
  }
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
  let assigned = await isAssignedApprover(id, 'prd', reviewerId);
  if (!assigned && !admin) {
    if (row.interviewId) {
      const interview = await db.query.interviews.findFirst({
        where: eq(interviews.id, row.interviewId),
        columns: { prdApproverIds: true },
      });
      if (interview?.prdApproverIds?.includes(reviewerId)) {
        await db.insert(documentApproverAssignments)
          .values(interview.prdApproverIds.map((uid) => ({
            documentId: id,
            documentType: 'prd' as const,
            approverUserId: uid,
            assignedBy: reviewerId,
          })))
          .onConflictDoNothing();
        assigned = true;
      }
    }
    if (!assigned) {
      throw forbidden('You are not an assigned approver for this PRD');
    }
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

  notifyOwnerPendingApproval(id, row.title, row.interviewId).catch((err) =>
    console.error(`[reviewPrd] Failed to notify owner (prdId=${id}):`, err),
  );

  return { approved: false };
}

export async function syncPrdContent(
  id: string,
  content: string,
  backlogJson?: unknown,
  finalStatus: PrdStatus = 'draft',
): Promise<void> {
  // Auto-infer an existing-page `route` per feature so the design-prototype generator
  // can run in EXTEND mode for features that modify existing MaxView pages. Best-effort:
  // inference failures or a missing inventory leave the backlog unchanged.
  let resolvedBacklog = backlogJson;
  if (backlogJson !== undefined && backlogJson !== null) {
    try {
      const { inferRoutesForBacklog } = await import('./designSystemService');
      const { backlog } = await inferRoutesForBacklog(backlogJson);
      resolvedBacklog = backlog;
    } catch (err) {
      console.warn(`[prdService] Route inference skipped for PRD ${id}:`, err);
    }

    // Populate per-feature / per-PBI userTypes + personaBehaviors from the persona
    // knowledge captured in the interview, so the design-prototype generator can
    // render role-aware UI. Best-effort: failures leave the (route-inferred)
    // backlog unchanged. Routes are handled by the inference pass above.
    try {
      const prdRow = await db.query.prds.findFirst({
        where: eq(prds.id, id),
        columns: { project: true, interviewId: true, skillSettingsId: true },
      });
      const { resolveSkillConfig: resolve } = await import('./projectSettingsService');
      const skillConfig = prdRow?.project ? await resolve({ project: prdRow.project, settingsId: prdRow.skillSettingsId ?? undefined }) : null;
      const transcript = prdRow?.interviewId ? await readInterviewTranscript(prdRow.interviewId) : null;
      const { enrichBacklogPersonasWithBedrock } = await import('./bedrockService');
      resolvedBacklog = await enrichBacklogPersonasWithBedrock(
        resolvedBacklog,
        skillConfig?.prdReviewBedrockModelId ?? null,
        skillConfig?.prdReviewBedrockMaxTokens ?? null,
        transcript,
      );
    } catch (err) {
      console.warn(`[prdService] Persona enrichment skipped for PRD ${id}:`, err);
    }
  }

  await db
    .update(prds)
    .set({
      content,
      status: finalStatus,
      ...(resolvedBacklog !== undefined ? { backlogJson: resolvedBacklog as any } : {}),
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
        console.log(`[prdWatcher] Sync complete — PRD is now draft (prdId=${prdId})`);
        try {
          const { triggerTestCaseGeneration } = await import('./testCaseService');
          const testCaseStarted = await triggerTestCaseGeneration(prdId, chatThreadId);
          if (!testCaseStarted) cleanupWorkspace(chatThreadId);
        } catch (err) {
          console.error(`[prdWatcher] Auto test-case generation failed (prdId=${prdId})`, err);
          cleanupWorkspace(chatThreadId);
        }
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
  latestTestCase?: TestCaseSummary | null,
  skillSettingsName?: string | null,
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
    model: row.model ?? undefined,
    skillSettingsId: row.skillSettingsId ?? null,
    skillSettingsName: skillSettingsName ?? null,
    status: row.status as PrdStatus,
    reviewerId: row.reviewerId ?? undefined,
    reviewerName: reviewerName ?? undefined,
    reviewComment: row.reviewComment ?? undefined,
    reviewedAt: row.reviewedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    latestTestCase: latestTestCase ?? null,
  };
}

// ── Title normalization for fuzzy matching ────────────────────────────────────

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
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
  adoBearerToken?: string | null,
): Promise<CreatePrdAdoItemsResponse> {
  const prd = await getPrd(prdId);
  if (!prd) throw notFound('PRD not found');
  if (prd.status !== 'approved') {
    throw conflict('PRD must be approved before creating ADO work items');
  }

  const designDocSummaries = await listDesignDocs({ prdId });
  const approvedDesignDocSummaries = designDocSummaries.filter(d => d.status === 'approved');
  if (approvedDesignDocSummaries.length === 0) {
    const err = new Error('At least one approved design doc is required before creating ADO work items');
    (err as any).status = 422;
    throw err;
  }

  // Load full design doc content for approved docs
  const approvedDocIds = approvedDesignDocSummaries.map(d => d.id);
  const fullDesignDocs = approvedDocIds.length > 0
    ? await db
        .select()
        .from(designDocs)
        .where(and(eq(designDocs.prdId, prdId), eq(designDocs.status, 'approved')))
        .limit(500)
    : [];

  // Load interview owner data once
  const interviewRow = prd.interviewId
    ? await db
        .select({
          designDocOwnerId: interviews.designDocOwnerId,
          testCaseApproverIds: interviews.testCaseApproverIds,
        })
        .from(interviews)
        .where(eq(interviews.id, prd.interviewId))
        .limit(1)
        .then(rows => rows[0] ?? null)
    : null;

  const prdOwnerOid = await getPrdOwnerId(prd.interviewId ?? null);
  const [prdOwnerEmail, designDocOwnerEmail] = await Promise.all([
    resolveOwnerEmail(prdOwnerOid),
    resolveOwnerEmail(interviewRow?.designDocOwnerId),
  ]);
  const qaReviewerOid = (interviewRow?.testCaseApproverIds as string[] | null | undefined)?.[0];
  const qaReviewerEmail = await resolveOwnerEmail(qaReviewerOid) ?? designDocOwnerEmail;

  // Load test cases JSON for this PRD
  const testCaseRecord = await getTestCases(prdId);
  const testCasesJson = (testCaseRecord as any)?.testCasesJson ?? null;

  // Flat list of features from the backlog for design-doc matching
  const backlogFeatures = extractFeatures(prd.backlogJson);

  // Attribute the ADO work items to the logged-in user (hard-fail in production if
  // no per-user token; PAT fallback in non-production). Token is resolved at the
  // route layer and threaded in.
  const adoService = adoWriteFromToken(adoBearerToken ?? null, req.project, req.areaPath);

  const response: CreatePrdAdoItemsResponse = {
    success: true,
    created: { epics: [], features: [], pbis: [], tasks: [], testCases: [] },
    totalCreated: 0,
  };

  // Maps for dependency second pass and test case linking.
  // itemIdToAdoId tracks backlog IDs for both PBIs and TBIs so cross-type
  // dependsOn references (e.g. TBI-001 → TBI-002, PBI → TBI-003) resolve.
  const titleToAdoId = new Map<string, number>();
  const itemIdToAdoId = new Map<string, number>();

  for (const epic of req.selectedItems.epics) {
    const epicDescHtml = buildEpicDescriptionHtml(epic, req.globalBusinessRules);
    const epicResult = await adoService.createWorkItemForPrd({
      type: 'Epic',
      title: epic.title,
      description: epicDescHtml || undefined,
      priority: epic.priority,
      assignedTo: prdOwnerEmail,
    });
    response.created.epics.push({
      title: epic.title, adoId: epicResult.id, adoUrl: epicResult.url,
      dependsOn: epic.dependencies,
    });
    titleToAdoId.set(epic.title, epicResult.id);
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
          assignedTo: designDocOwnerEmail,
        });
        response.created.features.push({
          title: feature.title, adoId: featureResult.id, adoUrl: featureResult.url,
          dependsOn: feature.dependencies,
        });
        titleToAdoId.set(feature.title, featureResult.id);
        response.totalCreated += 1;

        // Attach design doc files to the Feature.
        // Primary: match by designDocId stamped on the backlog feature.
        // Fallback (legacy): single-doc PRD → attach to all; multi-doc → featureIndex or title.
        const matchedDoc =
          (feature.designDocId && fullDesignDocs.find(doc => doc.id === feature.designDocId))
          || (designDocSummaries.length === 1
            ? fullDesignDocs[0]
            : fullDesignDocs.find(doc => {
                if (doc.featureIndex != null) {
                  return backlogFeatures[doc.featureIndex]?.title === feature.title;
                }
                const docNorm = normalizeTitle(doc.title);
                const featNorm = normalizeTitle(feature.title);
                if (docNorm === featNorm) return true;
                if (docNorm.length >= 4 && featNorm.length >= 4) {
                  if (docNorm.includes(featNorm) || featNorm.includes(docNorm)) return true;
                }
                return false;
              }))
          || undefined;
        if (matchedDoc) {
          const attachments: Array<{ fileName: string; content: string }> = [];
          if (matchedDoc.designContent) attachments.push({ fileName: 'design.md', content: matchedDoc.designContent });
          if (matchedDoc.techSpecContent) attachments.push({ fileName: 'tech-spec.md', content: matchedDoc.techSpecContent });
          if (matchedDoc.assumptionsContent) attachments.push({ fileName: 'assumptions.md', content: matchedDoc.assumptionsContent });

          if (matchedDoc.designPrototypeId) {
            try {
              const protoRows = await db
                .select({ mockHtml: designPrototypes.mockHtml })
                .from(designPrototypes)
                .where(eq(designPrototypes.id, matchedDoc.designPrototypeId))
                .limit(1);
              const mockHtml = protoRows[0]?.mockHtml;
              if (mockHtml) attachments.push({ fileName: 'prototype.html', content: mockHtml });
            } catch (err) {
              console.warn(`[prdAdoWorkItems] Could not load prototype for doc ${matchedDoc.id}:`, err);
            }
          }

          for (const { fileName, content } of attachments) {
            try {
              const { url: attachUrl } = await adoService.uploadAttachment(fileName, content);
              await adoService.addAttachmentToWorkItem(featureResult.id, attachUrl, fileName);
            } catch (err) {
              console.warn(`[prdAdoWorkItems] Could not attach ${fileName} to Feature #${featureResult.id}:`, err);
            }
          }
        }

        if (feature.items) {
          for (const item of feature.items) {
            if (item.type === 'TBI') {
              const tbiDescHtml = buildPbiDescriptionHtml(item);
              const acHtml =
                item.acceptanceCriteria && item.acceptanceCriteria.length > 0
                  ? buildAcceptanceCriteriaHtml(item.acceptanceCriteria)
                  : undefined;
              const tbiResult = await adoService.createWorkItemForPrd({
                type: 'Technical Backlog Item',
                title: item.title,
                description: tbiDescHtml || undefined,
                acceptanceCriteriaHtml: acHtml,
                priority: item.priority,
                parentId: featureResult.id,
                assignedTo: designDocOwnerEmail,
              });
              response.created.tasks.push({
                title: item.title, adoId: tbiResult.id, adoUrl: tbiResult.url,
                id: item.id, dependsOn: item.dependsOn,
              });
              titleToAdoId.set(item.title, tbiResult.id);
              if (item.id) itemIdToAdoId.set(item.id, tbiResult.id);
              response.totalCreated += 1;
            } else {
              const pbiDescHtml = buildPbiDescriptionHtml(item);
              const acHtml =
                item.acceptanceCriteria && item.acceptanceCriteria.length > 0
                  ? buildAcceptanceCriteriaHtml(item.acceptanceCriteria)
                  : undefined;

              const pbiResult = await adoService.createWorkItemForPrd({
                type: 'Product Backlog Item',
                title: item.title,
                description: pbiDescHtml || undefined,
                acceptanceCriteriaHtml: acHtml,
                priority: item.priority,
                parentId: featureResult.id,
                assignedTo: designDocOwnerEmail,
              });
              response.created.pbis.push({
                title: item.title, adoId: pbiResult.id, adoUrl: pbiResult.url,
                id: item.id, dependsOn: item.dependsOn,
              });
              titleToAdoId.set(item.title, pbiResult.id);
              if (item.id) itemIdToAdoId.set(item.id, pbiResult.id);
              response.totalCreated += 1;
            }
          }
        }
      }
    }
  }

  // Second pass — dependency links
  for (const epic of req.selectedItems.epics) {
    if (epic.dependencies && epic.dependencies.length > 0) {
      const epicAdoId = titleToAdoId.get(epic.title);
      if (epicAdoId) {
        const predIds = epic.dependencies.flatMap(dep => {
          const id = titleToAdoId.get(dep);
          return id != null ? [id] : [];
        });
        if (predIds.length > 0) {
          await adoService.addDependencyLinks(epicAdoId, predIds).catch(err =>
            console.warn(`[prdAdoWorkItems] Could not add dependency links for Epic "${epic.title}":`, err),
          );
        }
      }
    }

    for (const feature of epic.features ?? []) {
      if (feature.dependencies && feature.dependencies.length > 0) {
        const featAdoId = titleToAdoId.get(feature.title);
        if (featAdoId) {
          const predIds = feature.dependencies.flatMap(dep => {
            const id = titleToAdoId.get(dep);
            return id != null ? [id] : [];
          });
          if (predIds.length > 0) {
            await adoService.addDependencyLinks(featAdoId, predIds).catch(err =>
              console.warn(`[prdAdoWorkItems] Could not add dependency links for Feature "${feature.title}":`, err),
            );
          }
        }
      }

      for (const item of feature.items ?? []) {
        if (item.dependsOn && item.dependsOn.length > 0) {
          const itemAdoId = titleToAdoId.get(item.title);
          if (itemAdoId) {
            const predIds = item.dependsOn.flatMap(dep => {
              const byTitle = titleToAdoId.get(dep);
              if (byTitle != null) return [byTitle];
              const byId = itemIdToAdoId.get(dep);
              return byId != null ? [byId] : [];
            });
            if (predIds.length > 0) {
              await adoService.addDependencyLinks(itemAdoId, predIds).catch(err =>
                console.warn(`[prdAdoWorkItems] Could not add dependency links for item "${item.title}":`, err),
              );
            }
          }
        }
      }
    }
  }

  // Resolve dependsOnAdoIds on each created item and build dependency graph
  const resolveDeps = (deps: string[] | undefined): number[] => {
    if (!deps || deps.length === 0) return [];
    return deps.flatMap(dep => {
      const byTitle = titleToAdoId.get(dep);
      if (byTitle != null) return [byTitle];
      const byId = itemIdToAdoId.get(dep);
      return byId != null ? [byId] : [];
    });
  };

  const dependencyGraph: DependencyGraphNode[] = [];
  for (const item of response.created.epics) {
    item.dependsOnAdoIds = resolveDeps(item.dependsOn);
    dependencyGraph.push({ adoId: item.adoId, title: item.title, type: 'Epic', predecessorAdoIds: item.dependsOnAdoIds });
  }
  for (const item of response.created.features) {
    item.dependsOnAdoIds = resolveDeps(item.dependsOn);
    dependencyGraph.push({ adoId: item.adoId, title: item.title, type: 'Feature', predecessorAdoIds: item.dependsOnAdoIds });
  }
  for (const item of response.created.pbis) {
    item.dependsOnAdoIds = resolveDeps(item.dependsOn);
    dependencyGraph.push({ adoId: item.adoId, title: item.title, type: 'PBI', predecessorAdoIds: item.dependsOnAdoIds });
  }
  for (const item of response.created.tasks) {
    item.dependsOnAdoIds = resolveDeps(item.dependsOn);
    dependencyGraph.push({ adoId: item.adoId, title: item.title, type: 'TBI', predecessorAdoIds: item.dependsOnAdoIds });
  }
  response.dependencyGraph = dependencyGraph;

  // Create test cases for each PBI
  if (testCasesJson) {
    const root = testCasesJson as Record<string, unknown>;
    const suites = Array.isArray(root.suites) ? root.suites as Record<string, unknown>[] : [];
    for (const suite of suites) {
      const pbiId = String(suite.pbiId ?? suite.pbi_id ?? suite.workItemId ?? suite.work_item_id ?? '');
      const pbiAdoId = pbiId ? itemIdToAdoId.get(pbiId) : undefined;
      if (!pbiAdoId) continue;

      const cases = Array.isArray(suite.testCases)
        ? suite.testCases as Record<string, unknown>[]
        : Array.isArray(suite.test_cases)
          ? suite.test_cases as Record<string, unknown>[]
          : Array.isArray(suite.cases)
            ? suite.cases as Record<string, unknown>[]
            : [];

      for (const tc of cases) {
        const tcTitle = String(tc.title ?? tc.name ?? '');
        if (!tcTitle) continue;
        const steps = Array.isArray(tc.steps) ? tc.steps as Array<string | { action: string; expected?: string }> : [];
        try {
          const tcResult = await adoService.createTestCaseWorkItem({
            title: tcTitle,
            stepsHtml: buildStepsXml(steps),
            parentId: pbiAdoId,
            assignedTo: qaReviewerEmail,
          });
          response.created.testCases.push({ title: tcTitle, adoId: tcResult.id, adoUrl: tcResult.url });
          response.totalCreated += 1;
        } catch (err) {
          console.warn(`[prdAdoWorkItems] Could not create test case "${tcTitle}" for PBI #${pbiAdoId}:`, err);
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

export async function updatePrdDesignDocApprovers(id: string, designDocApproverIds: string[]): Promise<void> {
  await db
    .update(prds)
    .set({ designDocApproverIds, updatedAt: new Date().toISOString() })
    .where(eq(prds.id, id));
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

/**
 * Promote proposed PRD content/backlog to live, resolve related review comments,
 * sync backlog test-case counts, and re-run validation when configured.
 */
export async function applyProposedPrdChanges(
  prdId: string,
  options: { resolvedBy: string; fixCommentId?: string | null },
): Promise<{ applied: boolean }> {
  const prdRow = await db.query.prds.findFirst({
    where: eq(prds.id, prdId),
    columns: {
      proposedContent: true,
      proposedBacklogJson: true,
      fixCommentId: true,
    },
  });
  if (!prdRow) throw notFound('PRD not found');

  const hasProposed =
    prdRow.proposedContent != null || prdRow.proposedBacklogJson != null;
  if (!hasProposed) return { applied: false };

  const fixCommentId =
    options.fixCommentId !== undefined ? options.fixCommentId : prdRow.fixCommentId;
  const backlogWillUpdate = prdRow.proposedBacklogJson != null;

  await db.execute(sql`
    UPDATE prds
    SET content = COALESCE(proposed_content, content),
        backlog_json = COALESCE(proposed_backlog_json, backlog_json),
        proposed_content = NULL,
        proposed_backlog_json = NULL,
        fix_comment_id = NULL,
        updated_at = NOW()
    WHERE id = ${prdId}
  `);

  if (backlogWillUpdate) {
    const { syncPrdBacklogTestCaseCounts } = await import('./testCaseService');
    await syncPrdBacklogTestCaseCounts(prdId);
  }

  const now = new Date().toISOString();
  if (fixCommentId) {
    await db
      .update(reviewComments)
      .set({ status: 'resolved', resolvedBy: options.resolvedBy, resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(reviewComments.id, fixCommentId),
          eq(reviewComments.documentId, prdId),
          eq(reviewComments.documentType, 'prd'),
          eq(reviewComments.status, 'open'),
        ),
      );
  } else {
    await db
      .update(reviewComments)
      .set({ status: 'resolved', resolvedBy: options.resolvedBy, resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(reviewComments.documentId, prdId),
          eq(reviewComments.documentType, 'prd'),
          eq(reviewComments.status, 'open'),
        ),
      );
  }

  void autoStartPrdValidation(prdId).catch((err) =>
    console.error(`[prd] autoStartPrdValidation after apply-proposed failed (prdId=${prdId})`, err),
  );

  return { applied: true };
}

/** Resolve a PRD review comment, applying any pending proposed edits first. */
export async function resolvePrdCommentWithApply(
  commentId: string,
  resolvedBy: string,
): Promise<void> {
  const comment = await db.query.reviewComments.findFirst({
    where: eq(reviewComments.id, commentId),
  });
  if (!comment) throw notFound('Comment not found');

  if (comment.documentType !== 'prd') {
    const { resolveComment } = await import('./reviewCommentService');
    await resolveComment(commentId, resolvedBy);
    return;
  }

  const { applied } = await applyProposedPrdChanges(comment.documentId, {
    resolvedBy,
    fixCommentId: commentId,
  });

  if (!applied) {
    const { resolveComment } = await import('./reviewCommentService');
    await resolveComment(commentId, resolvedBy);
  }
}

// ── PRD Validation ────────────────────────────────────────────────────────────

const activePrdValidationWatchers = new Map<string, boolean>();

export async function arePrdValidationArtifactsReady(prdId: string): Promise<boolean> {
  const prdRow = await db.query.prds.findFirst({
    where: eq(prds.id, prdId),
    columns: { content: true, backlogJson: true },
  });
  if (!prdRow || !prdRow.content || !prdRow.backlogJson) return false;

  const tc = await db.query.testCases.findFirst({
    where: and(eq(testCases.prdId, prdId), eq(testCases.status, 'ready')),
    columns: { id: true },
  });
  return !!tc;
}

function createPrdValidationAdapter(prd: Prd): DocumentValidationAdapter {
  return {
    getDocumentId: () => prd.id,
    getProject: () => prd.project,
    getSkillSettingsId: () => prd.skillSettingsId ?? null,
    getAuthorId: () => prd.authorId,
    getValidationThreadId: () => prd.validationThreadId ?? null,
    getStatus: () => prd.status,
    getSkillPath: (skillConfig) => skillConfig.prdValidationSkillPath,
    getModel: (skillConfig, globalModel) => skillConfig.prdValidationModel ?? globalModel,
    buildValidationContext: (_skillConfig) => {
      const testCaseInfo = prd.latestTestCase;
      return [
        '# PRD Spec Review Validation Context',
        `prd_id: ${prd.id}`,
        '',
        '## PRD Content',
        prd.content || '(empty)',
        '',
        '## Backlog JSON',
        '```json',
        JSON.stringify(prd.backlogJson ?? {}, null, 2),
        '```',
        '',
        BACKLOG_USER_TYPE_CONVENTIONS_MD,
        '',
        '## Test Cases',
        testCaseInfo ? '(test cases available — referenced by PBI ID in backlog)' : '(no test cases)',
      ].join('\n');
    },
    updateDbForValidationStart: async (threadId: string) => {
      await db.update(prds)
        .set({
          validationThreadId: threadId,
          validationScore: null,
          validationScorecard: null,
          validationReportMd: null,
          validationPhase: null,
          status: 'validating',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(prds.id, prd.id));
    },
    updateDbForValidationResult: async (scorecard: ValidationScorecard, reportMd: string) => {
      const newStatus: PrdStatus = scorecard.is_ready ? 'pending_review' : 'draft';
      await db.update(prds)
        .set({
          validationScore: Math.round(scorecard.overall_score),
          validationScorecard: scorecard,
          validationPhase: scorecard.review_phase,
          validationReportMd: reportMd,
          status: newStatus,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(prds.id, prd.id));
      notifyAiCompletion('prd_validation_complete', prd.id, {
        title: prd.title,
        score: Math.round(scorecard.overall_score),
        passed: scorecard.is_ready,
      }).catch(err =>
        console.error(`[prdValidation] AI notification failed (prdId=${prd.id}):`, err),
      );
      if (newStatus === 'pending_review') {
        notifyApproversDocumentReady(prd.id, 'prd').catch((err) =>
          console.error(`[prdValidation] Failed to notify approvers (prdId=${prd.id})`, err),
        );
      }
    },
    updateDbForValidationTimeout: async () => {
      await db.update(prds)
        .set({ status: 'draft', updatedAt: new Date().toISOString() })
        .where(and(eq(prds.id, prd.id), eq(prds.status, 'validating')));
    },
    updateDbForValidationError: async () => {
      await db.update(prds)
        .set({ status: 'draft', updatedAt: new Date().toISOString() })
        .where(and(eq(prds.id, prd.id), eq(prds.status, 'validating')));
    },
    isCurrentValidationThread: async (threadId: string) => {
      const current = await db.query.prds.findFirst({
        where: eq(prds.id, prd.id),
        columns: { validationThreadId: true },
      });
      return current?.validationThreadId === threadId;
    },
  };
}

export async function autoStartPrdValidation(prdId: string): Promise<void> {
  const prd = await getPrd(prdId);
  if (!prd) return;

  const skillConfig = await resolveSkillConfig({ project: prd.project, settingsId: prd.skillSettingsId ?? undefined });
  if (!skillConfig?.prdValidationSkillPath) return;

  const ready = await arePrdValidationArtifactsReady(prdId);
  if (!ready) return;

  const adapter = createPrdValidationAdapter(prd);
  await autoStartDocumentValidation(adapter);
}

export async function cancelPrdValidation(prdId: string, requestingUserId: string): Promise<void> {
  const row = await db.query.prds.findFirst({ where: eq(prds.id, prdId) });
  if (!row) throw notFound('PRD not found');
  if (row.authorId !== requestingUserId && !(await isAdminUser(requestingUserId))) {
    throw forbidden('Only the author can cancel validation');
  }
  if (row.status !== 'validating') throw conflict(`Cannot cancel validation from status '${row.status}'`);

  await cancelDocumentValidation(prdId, row.validationThreadId ?? null);
  await db.update(prds)
    .set({ status: 'draft', updatedAt: new Date().toISOString() })
    .where(eq(prds.id, prdId));
}

export async function syncPrdValidationResult(prdId: string): Promise<{ score: number | null; is_ready: boolean } | null> {
  const prd = await getPrd(prdId);
  if (!prd || !prd.validationThreadId) return null;

  const { readOutputValidationScorecard, readOutputValidationScorecardMd } = await import('./chatAgentService');
  const scorecardRaw = readOutputValidationScorecard(prd.validationThreadId);
  if (!scorecardRaw) {
    if (prd.validationScorecard && prd.status !== 'validating') {
      return { score: prd.validationScore ?? null, is_ready: prd.validationScorecard.is_ready };
    }
    return null;
  }

  const scorecard = JSON.parse(scorecardRaw) as ValidationScorecard;
  const reportMd = readOutputValidationScorecardMd(prd.validationThreadId) ?? generateFallbackReport(scorecard);
  const newStatus: PrdStatus = scorecard.is_ready ? 'pending_review' : 'draft';

  await db.update(prds)
    .set({
      validationScore: Math.round(scorecard.overall_score),
      validationScorecard: scorecard,
      validationPhase: scorecard.review_phase,
      validationReportMd: reportMd,
      status: newStatus,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(prds.id, prdId));

  return { score: scorecard.overall_score, is_ready: scorecard.is_ready };
}

export async function markPrdValidationReady(prdId: string, requestingUserId: string): Promise<void> {
  const row = await db.query.prds.findFirst({ where: eq(prds.id, prdId) });
  if (!row) throw notFound('PRD not found');
  if (row.authorId !== requestingUserId && !(await isAdminUser(requestingUserId))) {
    throw forbidden('Only the author can mark validation as ready');
  }
  if (!row.validationScore || row.validationScore < 90) {
    const err = new Error(`Validation score must be >= 90. Current: ${row.validationScore ?? 'not scored'}`);
    (err as any).status = 409;
    throw err;
  }

  await db.update(prds)
    .set({ status: 'pending_review', updatedAt: new Date().toISOString() })
    .where(eq(prds.id, prdId));

  notifyApproversDocumentReady(prdId, 'prd').catch((err) =>
    console.error(`[markPrdValidationReady] Failed to notify approvers (prdId=${prdId})`, err),
  );
}

export async function triggerFixPrdValidation(
  prdId: string,
  userId: string,
): Promise<{ threadId: string }> {
  const prd = await getPrd(prdId);
  if (!prd) throw notFound('PRD not found');

  if (prd.status !== 'draft' && prd.status !== 'revision_requested') {
    throw conflict(`Cannot fix validation from status '${prd.status}'`);
  }
  if (!prd.validationScorecard) {
    throw conflict('No validation scorecard available to fix');
  }

  const baseline: PrdValidationBaseline = {
    content: prd.content || '',
    backlogJson: prd.backlogJson,
    capturedAt: new Date().toISOString(),
  };

  const skillConfig = await resolveSkillConfig({ project: prd.project, settingsId: prd.skillSettingsId ?? undefined });
  const globalModel = await getDefaultModel();
  const model = skillConfig?.prdAssistantModel ?? globalModel;

  let threadId = prd.prdAssistantThreadId ?? null;

  if (!threadId) {
    const context = [
      '# PRD Assistant Context',
      `prd_id: ${prdId}`,
      '',
      '> Use the `update_prd` MCP tool to apply edits back to the database.',
      '',
      '## PRD Content',
      prd.content || '(empty)',
      '',
      '## Backlog JSON',
      '```json',
      JSON.stringify(prd.backlogJson ?? {}, null, 2),
      '```',
    ].join('\n');

    const thread = await createChatThread(userId, {
      project: prd.project,
      repo: skillConfig?.skillRepo ?? prd.project,
      branch: skillConfig?.skillBranch ?? 'main',
      skillPath: skillConfig?.prdAssistantSkillPath ?? undefined,
      freeformContext: context,
      model,
    }, { skipAutoKickoff: true });

    threadId = thread.id;
    await db.update(prds)
      .set({ prdAssistantThreadId: thread.id, updatedAt: new Date().toISOString() })
      .where(eq(prds.id, prdId));
  }

  baseline.fixThreadId = threadId;
  await db.update(prds)
    .set({ fixBaseline: baseline, updatedAt: new Date().toISOString() })
    .where(eq(prds.id, prdId));

  const scorecard = prd.validationScorecard;
  const gapSources = (scorecard.files ?? scorecard.features ?? []) as Array<{ gaps?: Array<{ id: string; section: string; score: number; description: string; what_3_looks_like: string; resolution: string }> }>;
  const pendingGaps = gapSources.flatMap((f) => (f.gaps ?? []).filter((g) => g.resolution === 'pending'));
  const scoreDeficit = 90 - scorecard.overall_score;

  const prompt = [
    '# Fix PRD Validation Gaps',
    '',
    `The validation scorecard scored this PRD at **${scorecard.overall_score}%** (needs ≥90%). The score must increase by at least ${scoreDeficit} percentage points. There are ${pendingGaps.length} gap(s) that must be fixed.`,
    '',
    '## Your Task',
    '',
    'Fix all pending gaps in the PRD content to achieve a score >= 90%. Use the `update_prd` MCP tool to save your changes.',
    '',
    BACKLOG_USER_TYPE_CONVENTIONS_MD,
    '',
    '## Gaps to Fix',
    '',
    ...pendingGaps.map((g, i) => [
      `### Gap ${i + 1}: ${g.description}`,
      `- **Gap ID:** ${g.id}`,
      `- **Section:** ${g.section}`,
      `- **Current Score:** ${g.score}/3`,
      `- **Target (what a 3 looks like):** ${g.what_3_looks_like}`,
      '',
    ].join('\n')),
  ].join('\n');

  void sendMessage(threadId, prompt).catch((err) => {
    console.error(`[prd] fix-validation sendMessage error for thread ${threadId}:`, err);
  });

  return { threadId };
}

export async function acceptFixPrdValidation(prdId: string): Promise<void> {
  const row = await db.query.prds.findFirst({ where: eq(prds.id, prdId) });
  if (!row) throw notFound('PRD not found');

  await db.update(prds)
    .set({ fixBaseline: null, updatedAt: new Date().toISOString() })
    .where(eq(prds.id, prdId));

  notifyAiCompletion('prd_fix_complete', prdId, { title: row.title }).catch(err =>
    console.error(`[prdFix] AI notification failed (prdId=${prdId}):`, err),
  );

  await autoStartPrdValidation(prdId);
}

export async function revertPrdSection(prdId: string, requestingUserId: string): Promise<void> {
  const row = await db.query.prds.findFirst({ where: eq(prds.id, prdId) });
  if (!row) throw notFound('PRD not found');
  if (row.authorId !== requestingUserId && !(await isAdminUser(requestingUserId))) {
    throw forbidden('Only the author can revert sections');
  }

  const baseline = row.fixBaseline as PrdValidationBaseline | null;
  if (!baseline) throw conflict('No baseline to revert to');

  await db.update(prds)
    .set({
      content: baseline.content,
      backlogJson: baseline.backlogJson as any,
      fixBaseline: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(prds.id, prdId));
}

export function isPrdValidationWatcherActive(prdId: string): boolean {
  return isDocumentValidationWatcherActive(prdId);
}

export async function rehydratePrdValidationWatcher(prdId: string, validationThreadId: string): Promise<void> {
  const prd = await getPrd(prdId);
  if (!prd) return;
  const adapter = createPrdValidationAdapter(prd);
  startDocumentValidationWatcher(adapter, validationThreadId);
}
