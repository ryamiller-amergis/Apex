import fs from 'fs';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { designDocs, appUsers, chatThreads } from '../db/schema';
import type { DesignDoc, DesignDocStatus, DesignDocSummary, ReviewDesignDocRequest, ValidationScorecard } from '../../shared/types/interview';
import { readOutputDesignDoc, readOutputTechSpec, readOutputAssumptions, readOutputValidationScorecard, readOutputValidationScorecardMd, createThread as createChatThread } from './chatAgentService';
import { isAdminUser } from '../utils/rbacHelpers';
import { getSkillConfig } from './projectSettingsService';
import { getDefaultModel } from './appSettingsService';
import { getPrd } from './prdService';

const VALID_STATUSES: DesignDocStatus[] = ['interviewing', 'generating', 'validating', 'draft', 'pending_review', 'approved', 'rejected', 'revision_requested'];

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

export async function createDesignDoc(opts: {
  prdId: string;
  project: string;
  userId: string;
  chatThreadId?: string;
  qaChatThreadId?: string;
  title?: string;
  status?: DesignDocStatus;
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
    .select({ designDoc: designDocs, reviewerDisplayName: appUsers.displayName })
    .from(designDocs)
    .leftJoin(appUsers, eq(designDocs.reviewerId, appUsers.oid))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(designDocs.updatedAt));

  return rows.map(({ designDoc, reviewerDisplayName }) => rowToSummary(designDoc, reviewerDisplayName));
}

export async function getDesignDoc(id: string): Promise<DesignDoc | null> {
  const rows = await db
    .select({ designDoc: designDocs, reviewerDisplayName: appUsers.displayName })
    .from(designDocs)
    .leftJoin(appUsers, eq(designDocs.reviewerId, appUsers.oid))
    .where(eq(designDocs.id, id))
    .limit(1);

  if (rows.length === 0) return null;
  const { designDoc: row, reviewerDisplayName } = rows[0];
  return {
    ...rowToSummary(row, reviewerDisplayName),
    designContent: row.designContent,
    techSpecContent: row.techSpecContent,
    assumptionsContent: row.assumptionsContent,
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
  if (opts.techSpecContent !== undefined) updates.techSpecContent = opts.techSpecContent;
  if (opts.assumptionsContent !== undefined) updates.assumptionsContent = opts.assumptionsContent;

  if (row.status === 'revision_requested' || row.status === 'rejected') {
    updates.status = 'draft';
    updates.reviewerId = null;
    updates.reviewComment = null;
    updates.reviewedAt = null;
  }

  await db.update(designDocs).set(updates).where(eq(designDocs.id, id));
}

export async function submitForReview(id: string, requestingUserId: string): Promise<void> {
  const row = await db.query.designDocs.findFirst({ where: eq(designDocs.id, id) });
  if (!row) throw notFound('Design doc not found');
  if (row.authorId !== requestingUserId && !(await isAdminUser(requestingUserId))) {
    throw forbidden('Only the author can submit for review');
  }
  if (row.status !== 'draft' && row.status !== 'revision_requested' && row.status !== 'rejected') {
    throw conflict(`Cannot submit design doc from status '${row.status}'`);
  }
  if (!row.designContent && !row.techSpecContent && !row.assumptionsContent) {
    throw conflict('Design doc content must be non-empty before submitting for review');
  }

  await db
    .update(designDocs)
    .set({
      status: 'pending_review',
      reviewerId: null,
      reviewComment: null,
      reviewedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(designDocs.id, id));
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
      reviewComment: null,
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
  if ((opts.action === 'reject' || opts.action === 'request_revision') && !opts.comment) {
    const err = new Error('A comment is required when rejecting or requesting revision');
    (err as any).status = 400;
    throw err;
  }
  if (opts.action === 'approve') {
    const skillConfig = await getSkillConfig(row.project);
    if (skillConfig?.designDocValidationSkillPath) {
      if (row.validationScore === null || row.validationScore === undefined || row.validationScore < 90) {
        const err = new Error(`Validation score must be >= 90 to approve. Current score: ${row.validationScore ?? 'not scored'}`);
        (err as any).status = 409;
        throw err;
      }
    }
  }

  const statusMap: Record<ReviewDesignDocRequest['action'], DesignDocStatus> = {
    approve: 'approved',
    reject: 'rejected',
    request_revision: 'revision_requested',
  };

  await db
    .update(designDocs)
    .set({
      status: statusMap[opts.action],
      reviewerId,
      reviewComment: opts.comment ?? null,
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
  if (opts.techSpecContent !== undefined) updates.techSpecContent = opts.techSpecContent;
  if (opts.assumptionsContent !== undefined) updates.assumptionsContent = opts.assumptionsContent;
  if (opts.finalStatus !== undefined) updates.status = opts.finalStatus;

  await db
    .update(designDocs)
    .set(updates)
    .where(eq(designDocs.id, id));
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

export function startDesignDocWatcher(designDocId: string, chatThreadId: string): void {
  stopDocWatcher(designDocId);
  let attempts = 0;
  let designFound = false;
  let techSpecFound = false;
  let assumptionsFound = false;

  console.log(`[designDocWatcher] Started — designDocId=${designDocId} threadId=${chatThreadId}`);

  const interval = setInterval(async () => {
    attempts += 1;

    if (attempts > WATCHER_MAX_ATTEMPTS) {
      clearInterval(interval);
      activeDocWatchers.delete(designDocId);
      console.warn(`[designDocWatcher] Timed out waiting for design doc output (designDocId=${designDocId}, threadId=${chatThreadId})`);
      return;
    }

    const designContent = designFound ? null : readOutputDesignDoc(chatThreadId);
    const techSpecContent = techSpecFound ? null : readOutputTechSpec(chatThreadId);
    const assumptionsContent = assumptionsFound ? null : readOutputAssumptions(chatThreadId);

    const syncOpts: Parameters<typeof syncDesignDocContent>[1] = {};
    let anyNewFile = false;

    if (!designFound && designContent !== null) {
      designFound = true;
      anyNewFile = true;
      syncOpts.designContent = designContent;
    }
    if (!techSpecFound && techSpecContent !== null) {
      techSpecFound = true;
      anyNewFile = true;
      syncOpts.techSpecContent = techSpecContent;
    }
    if (!assumptionsFound && assumptionsContent !== null) {
      assumptionsFound = true;
      anyNewFile = true;
      syncOpts.assumptionsContent = assumptionsContent;
    }

    const allFound = designFound && techSpecFound && assumptionsFound;

    console.log(
      `[designDocWatcher] tick #${attempts} — design=${designFound} techSpec=${techSpecFound} assumptions=${assumptionsFound} (designDocId=${designDocId})`,
    );

    if (anyNewFile) {
      if (allFound) {
        try {
          const docRow = await db.query.designDocs.findFirst({
            where: eq(designDocs.id, designDocId),
          });
          const skillConfig = docRow ? await getSkillConfig(docRow.project) : null;
          if (skillConfig?.designDocValidationSkillPath) {
            syncOpts.finalStatus = 'validating';
          } else {
            syncOpts.finalStatus = 'pending_review';
          }
        } catch {
          syncOpts.finalStatus = 'pending_review';
        }
      }
      try {
        await syncDesignDocContent(designDocId, syncOpts);
        if (allFound) {
          console.log(`[designDocWatcher] All files ready — design doc is now ${syncOpts.finalStatus} (designDocId=${designDocId})`);
          if (syncOpts.finalStatus === 'validating') {
            autoStartValidation(designDocId).catch((err) => {
              console.error(`[designDocWatcher] autoStartValidation failed (designDocId=${designDocId})`, err);
            });
          }
        }
      } catch (err) {
        console.error(`[designDocWatcher] Failed to sync design doc content (designDocId=${designDocId})`, err);
      }
    }

    if (allFound) {
      clearInterval(interval);
      activeDocWatchers.delete(designDocId);
      cleanupWorkspace(chatThreadId);
    }
  }, WATCHER_INTERVAL_MS);

  activeDocWatchers.set(designDocId, interval);
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

function rowToSummary(row: typeof designDocs.$inferSelect, reviewerName?: string | null): DesignDocSummary {
  return {
    id: row.id,
    prdId: row.prdId,
    project: row.project,
    chatThreadId: row.chatThreadId,
    qaChatThreadId: row.qaChatThreadId ?? null,
    docAssistantThreadId: row.docAssistantThreadId ?? null,
    validationThreadId: row.validationThreadId ?? null,
    validationScore: row.validationScore ?? null,
    validationScorecard: (row.validationScorecard as ValidationScorecard | null) ?? null,
    validationReportMd: row.validationReportMd ?? null,
    validationPhase: row.validationPhase ?? null,
    authorId: row.authorId,
    title: row.title,
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
  const doc = await getDesignDoc(designDocId);
  if (!doc) return;

  const skillConfig = await getSkillConfig(doc.project);
  if (!skillConfig?.designDocValidationSkillPath) return;

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

  const statusAllowsValidation: DesignDocStatus[] = ['generating', 'pending_review', 'draft', 'revision_requested', 'rejected'];
  const newStatus = statusAllowsValidation.includes(doc.status as DesignDocStatus) ? 'validating' : undefined;

  await db.update(designDocs)
    .set({
      validationThreadId: thread.id,
      ...(newStatus ? { status: newStatus } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(designDocs.id, designDocId));

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
      return;
    }

    const scorecardRaw = readOutputValidationScorecard(validationThreadId);
    if (!scorecardRaw) return;

    clearInterval(interval);
    activeValidationWatchers.delete(designDocId);

    try {
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

export async function syncValidationResult(
  designDocId: string,
  scorecard: ValidationScorecard,
  reportMd?: string,
): Promise<void> {
  const newStatus = scorecard.is_ready ? 'pending_review' : undefined;
  const updates: Partial<typeof designDocs.$inferInsert> = {
    validationScore: scorecard.overall_score,
    validationScorecard: scorecard,
    validationPhase: scorecard.review_phase,
    updatedAt: new Date().toISOString(),
  };
  if (reportMd !== undefined) updates.validationReportMd = reportMd;
  if (newStatus) updates.status = newStatus;

  await db.update(designDocs).set(updates).where(eq(designDocs.id, designDocId));
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
}

// Ensure assertValidStatus is used (suppress unused warning)
void assertValidStatus;
