import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { designDocs, appUsers } from '../db/schema';
import type { DesignDoc, DesignDocStatus, DesignDocSummary, ReviewDesignDocRequest } from '../../shared/types/interview';
import { readOutputDesignDoc, readOutputTechSpec, readOutputAssumptions } from './chatAgentService';
import { isAdminUser } from '../utils/rbacHelpers';

const VALID_STATUSES: DesignDocStatus[] = ['interviewing', 'generating', 'draft', 'pending_review', 'approved', 'rejected', 'revision_requested'];

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

export function startDesignDocWatcher(designDocId: string, chatThreadId: string): void {
  let attempts = 0;
  let designFound = false;
  let techSpecFound = false;
  let assumptionsFound = false;

  console.log(`[designDocWatcher] Started — designDocId=${designDocId} threadId=${chatThreadId}`);

  const interval = setInterval(async () => {
    attempts += 1;

    if (attempts > WATCHER_MAX_ATTEMPTS) {
      clearInterval(interval);
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
        syncOpts.finalStatus = 'pending_review';
      }
      try {
        await syncDesignDocContent(designDocId, syncOpts);
        if (allFound) {
          console.log(`[designDocWatcher] All files ready — design doc is now pending_review (designDocId=${designDocId})`);
        }
      } catch (err) {
        console.error(`[designDocWatcher] Failed to sync design doc content (designDocId=${designDocId})`, err);
      }
    }

    if (allFound) {
      clearInterval(interval);
    }
  }, WATCHER_INTERVAL_MS);
}

export async function deleteDesignDoc(id: string, requestingUserId: string): Promise<void> {
  const row = await db.query.designDocs.findFirst({ where: eq(designDocs.id, id) });
  if (!row) throw notFound('Design doc not found');
  if (row.authorId !== requestingUserId && !(await isAdminUser(requestingUserId))) {
    throw forbidden('Only the author can delete this design doc');
  }
  await db.delete(designDocs).where(eq(designDocs.id, id));
}

function rowToSummary(row: typeof designDocs.$inferSelect, reviewerName?: string | null): DesignDocSummary {
  return {
    id: row.id,
    prdId: row.prdId,
    project: row.project,
    chatThreadId: row.chatThreadId,
    qaChatThreadId: row.qaChatThreadId ?? null,
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

// Ensure assertValidStatus is used (suppress unused warning)
void assertValidStatus;
