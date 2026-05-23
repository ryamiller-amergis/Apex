import fs from 'fs';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { prds, appUsers, chatThreads } from '../db/schema';
import type { Prd, PrdStatus, PrdSummary, ReviewPrdRequest } from '../../shared/types/interview';
import { readOutputPrd, readOutputBacklog } from './chatAgentService';
import { isAdminUser } from '../utils/rbacHelpers';

const VALID_PRD_STATUSES: PrdStatus[] = ['generating', 'draft', 'pending_review', 'approved', 'rejected', 'revision_requested'];

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
    .select({ prd: prds, reviewerDisplayName: appUsers.displayName })
    .from(prds)
    .leftJoin(appUsers, eq(prds.reviewerId, appUsers.oid))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(prds.updatedAt));

  return rows.map(({ prd, reviewerDisplayName }) => rowToPrdSummary(prd, reviewerDisplayName));
}

export async function getPrd(id: string): Promise<Prd | null> {
  const rows = await db
    .select({ prd: prds, reviewerDisplayName: appUsers.displayName })
    .from(prds)
    .leftJoin(appUsers, eq(prds.reviewerId, appUsers.oid))
    .where(eq(prds.id, id))
    .limit(1);

  if (rows.length === 0) return null;
  const { prd: row, reviewerDisplayName } = rows[0];
  return {
    ...rowToPrdSummary(row, reviewerDisplayName),
    content: row.content,
    backlogJson: row.backlogJson ?? undefined,
  };
}

export async function updatePrdContent(
  id: string,
  requestingUserId: string,
  content: string,
): Promise<void> {
  const row = await db.query.prds.findFirst({ where: eq(prds.id, id) });
  if (!row) throw notFound('PRD not found');
  if (row.authorId !== requestingUserId && !(await isAdminUser(requestingUserId))) {
    throw forbidden('Only the author can edit PRD content');
  }
  if (row.status === 'approved') throw conflict('Approved PRDs cannot be edited');

  const updates: Partial<typeof prds.$inferInsert> = {
    content,
    updatedAt: new Date().toISOString(),
  };

  if (row.status === 'revision_requested' || row.status === 'rejected') {
    updates.status = 'draft';
    updates.reviewerId = null;
    updates.reviewComment = null;
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
  if (row.authorId !== requestingUserId) throw forbidden('Only the author can update backlog');
  if (row.status === 'approved') throw conflict('Approved PRDs cannot be edited');

  await db
    .update(prds)
    .set({ backlogJson: backlog as any, updatedAt: new Date().toISOString() })
    .where(eq(prds.id, id));
}

export async function submitForReview(id: string, requestingUserId: string): Promise<void> {
  const row = await db.query.prds.findFirst({ where: eq(prds.id, id) });
  if (!row) throw notFound('PRD not found');
  if (row.authorId !== requestingUserId && !(await isAdminUser(requestingUserId))) {
    throw forbidden('Only the author can submit for review');
  }
  if (row.status !== 'draft' && row.status !== 'revision_requested' && row.status !== 'rejected') {
    throw conflict(`Cannot submit PRD from status '${row.status}'`);
  }
  if (!row.content) throw conflict('PRD content must be non-empty before submitting for review');

  await db
    .update(prds)
    .set({
      status: 'pending_review',
      reviewerId: null,
      reviewComment: null,
      reviewedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(prds.id, id));
}

export async function withdrawFromReview(id: string, requestingUserId: string): Promise<void> {
  const row = await db.query.prds.findFirst({ where: eq(prds.id, id) });
  if (!row) throw notFound('PRD not found');
  if (row.authorId !== requestingUserId && !(await isAdminUser(requestingUserId))) {
    throw forbidden('Only the author can withdraw from review');
  }
  if (row.status !== 'pending_review') throw conflict(`Cannot withdraw PRD from status '${row.status}'`);

  await db
    .update(prds)
    .set({
      status: 'draft',
      reviewerId: null,
      reviewComment: null,
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
      reviewComment: null,
      reviewedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(prds.id, id));
}

export async function reviewPrd(
  id: string,
  reviewerId: string,
  opts: ReviewPrdRequest,
): Promise<void> {
  const row = await db.query.prds.findFirst({ where: eq(prds.id, id) });
  if (!row) throw notFound('PRD not found');
  if (row.status !== 'pending_review') throw conflict(`Cannot review PRD from status '${row.status}'`);
  if (row.authorId === reviewerId && !(await isAdminUser(reviewerId))) {
    throw forbidden('You cannot review your own PRD');
  }
  if ((opts.action === 'reject' || opts.action === 'request_revision') && !opts.comment) {
    const err = new Error('A comment is required when rejecting or requesting revision');
    (err as any).status = 400;
    throw err;
  }

  const statusMap: Record<ReviewPrdRequest['action'], PrdStatus> = {
    approve: 'approved',
    reject: 'rejected',
    request_revision: 'revision_requested',
  };

  await db
    .update(prds)
    .set({
      status: statusMap[opts.action],
      reviewerId,
      reviewComment: opts.comment ?? null,
      reviewedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(prds.id, id));
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
      console.warn(`[prdWatcher] Timed out waiting for PRD output (prdId=${prdId}, threadId=${chatThreadId})`);
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

function rowToPrdSummary(row: typeof prds.$inferSelect, reviewerName?: string | null): PrdSummary {
  return {
    id: row.id,
    interviewId: row.interviewId,
    chatThreadId: row.chatThreadId ?? '',
    authorId: row.authorId,
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

export async function deletePrd(id: string, requestingUserId: string): Promise<void> {
  const row = await db.query.prds.findFirst({ where: eq(prds.id, id) });
  if (!row) throw notFound('PRD not found');
  if (row.authorId !== requestingUserId && !(await isAdminUser(requestingUserId))) {
    throw forbidden('Only the author can delete this PRD');
  }
  stopPrdWatcher(id);
  await db.delete(prds).where(eq(prds.id, id));
}

// Ensure assertValidPrdStatus is used (suppress unused warning)
void assertValidPrdStatus;
