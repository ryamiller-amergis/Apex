import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  reviewComments,
  reviewReplies,
  appUsers,
  prds,
  designDocs,
  adrs,
  interviews,
  documentApproverAssignments,
} from '../db/schema';
import { createNotification } from './notificationService';
import { isAssignedApprover } from './documentApprovalService';
import type {
  TextSelector,
  ReviewComment,
  ReviewReply,
  ReviewCommentWithReplies,
  ReviewDocumentType,
  ReviewSectionKey,
} from '../../shared/types/reviewComments';

// ── Helpers ──────────────────────────────────────────────────────────────────

function badRequest(msg: string): Error {
  const err = new Error(msg);
  (err as any).status = 400;
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

async function getDocumentAuthorId(
  documentId: string,
  documentType: ReviewDocumentType,
): Promise<string> {
  if (documentType === 'prd') {
    const rows = await db
      .select({ authorId: prds.authorId })
      .from(prds)
      .where(eq(prds.id, documentId))
      .limit(1);
    if (!rows[0]) throw notFound('PRD not found');
    return rows[0].authorId;
  }
  if (documentType === 'design_doc') {
    const rows = await db
      .select({ authorId: designDocs.authorId })
      .from(designDocs)
      .where(eq(designDocs.id, documentId))
      .limit(1);
    if (!rows[0]) throw notFound('Design doc not found');
    return rows[0].authorId;
  }
  const rows = await db
    .select({ authorId: adrs.authorId })
    .from(adrs)
    .where(eq(adrs.id, documentId))
    .limit(1);
  if (!rows[0]) throw notFound('ADR not found');
  return rows[0].authorId;
}

async function getDocumentOwnerIds(
  documentId: string,
  documentType: ReviewDocumentType,
): Promise<string[]> {
  const authorId = await getDocumentAuthorId(documentId, documentType);
  if (documentType !== 'prd') return [authorId];

  const rows = await db
    .select({ prdOwnerId: interviews.prdOwnerId })
    .from(prds)
    .innerJoin(interviews, eq(prds.interviewId, interviews.id))
    .where(eq(prds.id, documentId))
    .limit(1);

  const ownerId = rows[0]?.prdOwnerId;
  if (ownerId && ownerId !== authorId) return [authorId, ownerId];
  return [authorId];
}

async function getDocumentTitle(
  documentId: string,
  documentType: ReviewDocumentType,
): Promise<string> {
  if (documentType === 'prd') {
    const rows = await db.select({ title: prds.title }).from(prds).where(eq(prds.id, documentId)).limit(1);
    return rows[0]?.title ?? 'Untitled PRD';
  }
  if (documentType === 'design_doc') {
    const rows = await db.select({ title: designDocs.title }).from(designDocs).where(eq(designDocs.id, documentId)).limit(1);
    return rows[0]?.title ?? 'Untitled Design Doc';
  }
  const rows = await db.select({ title: adrs.title }).from(adrs).where(eq(adrs.id, documentId)).limit(1);
  return rows[0]?.title ?? 'Untitled ADR';
}

function documentLink(documentId: string, documentType: ReviewDocumentType): string {
  return documentType === 'prd'
    ? `/backlog/prd/${documentId}`
    : documentType === 'adr'
      ? `/adr/${documentId}`
      : `/backlog/design-doc/${documentId}`;
}

// ── Row → shared type mappers ────────────────────────────────────────────────

function toReviewComment(
  row: typeof reviewComments.$inferSelect,
  authorDisplayName?: string | null,
): ReviewComment {
  return {
    id: row.id,
    documentId: row.documentId,
    documentType: row.documentType as ReviewDocumentType,
    sectionKey: row.sectionKey as ReviewSectionKey,
    authorUserId: row.authorUserId,
    authorDisplayName: authorDisplayName ?? undefined,
    body: row.body,
    selector: {
      exact: row.selectorExact,
      prefix: row.selectorPrefix,
      suffix: row.selectorSuffix,
      start: row.selectorStart,
      end: row.selectorEnd,
    },
    status: row.status as ReviewComment['status'],
    resolvedBy: row.resolvedBy ?? null,
    resolvedAt: row.resolvedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toReviewReply(
  row: typeof reviewReplies.$inferSelect,
  authorDisplayName?: string | null,
): ReviewReply {
  return {
    id: row.id,
    commentId: row.commentId,
    authorUserId: row.authorUserId,
    authorDisplayName: authorDisplayName ?? undefined,
    body: row.body,
    createdAt: row.createdAt,
  };
}

// ── Auto-status transition ───────────────────────────────────────────────────

async function autoTransitionToRevisionRequested(
  documentId: string,
  documentType: ReviewDocumentType,
): Promise<void> {
  const [existing] = await db
    .select({ value: count() })
    .from(reviewComments)
    .where(
      and(
        eq(reviewComments.documentId, documentId),
        eq(reviewComments.documentType, documentType),
        eq(reviewComments.status, 'open'),
      ),
    );

  if ((existing?.value ?? 0) === 1 && documentType !== 'adr') {
    const table = documentType === 'prd' ? prds : designDocs;
    await db
      .update(table)
      .set({ status: 'revision_requested', updatedAt: new Date().toISOString() })
      .where(eq(table.id, documentId));
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function createComment(
  documentId: string,
  documentType: ReviewDocumentType,
  sectionKey: ReviewSectionKey,
  authorUserId: string,
  body: string,
  selector: TextSelector,
): Promise<ReviewComment> {
  if (!body.trim()) throw badRequest('Comment body is required');

  const [row] = await db
    .insert(reviewComments)
    .values({
      documentId,
      documentType,
      sectionKey,
      authorUserId,
      body,
      selectorExact: selector.exact,
      selectorPrefix: selector.prefix,
      selectorSuffix: selector.suffix,
      selectorStart: selector.start,
      selectorEnd: selector.end,
    })
    .returning();

  await autoTransitionToRevisionRequested(documentId, documentType);

  const ownerIds = await getDocumentOwnerIds(documentId, documentType);
  const recipientIds = ownerIds.filter((id) => id !== authorUserId);
  if (recipientIds.length > 0) {
    const docTitle = await getDocumentTitle(documentId, documentType);
    const link = documentLink(documentId, documentType);
    Promise.allSettled(
      recipientIds.map((id) =>
        createNotification(id, {
          type: 'user-action',
          title: 'New review comment on your document',
          body: `A reviewer left a comment on "${docTitle}"`,
          link,
        }),
      ),
    ).catch((err) => console.error('[reviewComments] notification error:', err));
  }

  const authorRow = await db
    .select({ displayName: appUsers.displayName })
    .from(appUsers)
    .where(eq(appUsers.oid, authorUserId))
    .limit(1);

  return toReviewComment(row, authorRow[0]?.displayName);
}

export async function addReply(
  commentId: string,
  authorUserId: string,
  body: string,
): Promise<ReviewReply> {
  if (!body.trim()) throw badRequest('Reply body is required');

  const comment = await db.query.reviewComments.findFirst({
    where: eq(reviewComments.id, commentId),
  });
  if (!comment) throw notFound('Comment not found');

  // Fetch existing replies BEFORE inserting so we can collect prior participants
  const priorReplies = await db
    .select({ authorUserId: reviewReplies.authorUserId })
    .from(reviewReplies)
    .where(eq(reviewReplies.commentId, commentId));

  const [row] = await db
    .insert(reviewReplies)
    .values({ commentId, authorUserId, body })
    .returning();

  const docType = comment.documentType as ReviewDocumentType;
  const ownerIds = await getDocumentOwnerIds(comment.documentId, docType);
  const docTitle = await getDocumentTitle(comment.documentId, docType);
  const link = documentLink(comment.documentId, docType);

  // Build the full set of thread participants: document owners + original commenter + all prior repliers
  const participantSet = new Set<string>([
    ...ownerIds,
    comment.authorUserId,
    ...priorReplies.map((r) => r.authorUserId),
  ]);
  // Never notify the person who just replied
  participantSet.delete(authorUserId);

  await Promise.allSettled(
    [...participantSet].map((recipientId) =>
      createNotification(recipientId, {
        type: 'user-action',
        title: 'New reply on a review comment',
        body: `Someone replied on a comment in "${docTitle}"`,
        link,
      }),
    ),
  );

  const authorRow = await db
    .select({ displayName: appUsers.displayName })
    .from(appUsers)
    .where(eq(appUsers.oid, authorUserId))
    .limit(1);

  return toReviewReply(row, authorRow[0]?.displayName);
}

export async function resolveComment(
  commentId: string,
  userId: string,
): Promise<void> {
  const comment = await db.query.reviewComments.findFirst({
    where: eq(reviewComments.id, commentId),
  });
  if (!comment) throw notFound('Comment not found');

  const docType = comment.documentType as ReviewDocumentType;
  const ownerIds = await getDocumentOwnerIds(comment.documentId, docType);
  if (!ownerIds.includes(userId)) {
    const approver = await isAssignedApprover(comment.documentId, docType, userId);
    if (!approver) {
      throw forbidden('Only the document author, owner, or assigned approver can resolve comments');
    }
  }

  await db
    .update(reviewComments)
    .set({
      status: 'resolved',
      resolvedBy: userId,
      resolvedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(reviewComments.id, commentId));
}

export async function reopenComment(
  commentId: string,
  userId: string,
): Promise<void> {
  const comment = await db.query.reviewComments.findFirst({
    where: eq(reviewComments.id, commentId),
  });
  if (!comment) throw notFound('Comment not found');

  const docType = comment.documentType as ReviewDocumentType;
  const ownerIds = await getDocumentOwnerIds(comment.documentId, docType);
  if (!ownerIds.includes(userId)) {
    const approver = await isAssignedApprover(comment.documentId, docType, userId);
    if (!approver) {
      throw forbidden('Only the document author, owner, or assigned approver can reopen comments');
    }
  }

  await db
    .update(reviewComments)
    .set({
      status: 'open',
      resolvedBy: null,
      resolvedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(reviewComments.id, commentId));
}

export async function getComments(
  documentId: string,
  documentType: ReviewDocumentType,
): Promise<ReviewCommentWithReplies[]> {
  const commentRows = await db
    .select({
      comment: reviewComments,
      authorDisplayName: appUsers.displayName,
    })
    .from(reviewComments)
    .innerJoin(appUsers, eq(reviewComments.authorUserId, appUsers.oid))
    .where(
      and(
        eq(reviewComments.documentId, documentId),
        eq(reviewComments.documentType, documentType),
      ),
    )
    .orderBy(asc(reviewComments.createdAt));

  if (commentRows.length === 0) return [];

  const commentIds = commentRows.map((r) => r.comment.id);

  const allReplies = await db
    .select({
      reply: reviewReplies,
      authorDisplayName: appUsers.displayName,
    })
    .from(reviewReplies)
    .innerJoin(appUsers, eq(reviewReplies.authorUserId, appUsers.oid))
    .where(inArray(reviewReplies.commentId, commentIds))
    .orderBy(asc(reviewReplies.createdAt));

  const repliesByCommentId = new Map<string, ReviewReply[]>();
  for (const r of allReplies) {
    const list = repliesByCommentId.get(r.reply.commentId) ?? [];
    list.push(toReviewReply(r.reply, r.authorDisplayName));
    repliesByCommentId.set(r.reply.commentId, list);
  }

  return commentRows.map((r) => ({
    ...toReviewComment(r.comment, r.authorDisplayName),
    replies: repliesByCommentId.get(r.comment.id) ?? [],
  }));
}

export async function getUnresolvedCount(
  documentId: string,
  documentType: ReviewDocumentType,
): Promise<number> {
  const [result] = await db
    .select({ value: count() })
    .from(reviewComments)
    .where(
      and(
        eq(reviewComments.documentId, documentId),
        eq(reviewComments.documentType, documentType),
        eq(reviewComments.status, 'open'),
      ),
    );

  return result?.value ?? 0;
}

export async function deleteComment(
  commentId: string,
  userId: string,
): Promise<void> {
  const comment = await db.query.reviewComments.findFirst({
    where: eq(reviewComments.id, commentId),
  });
  if (!comment) throw notFound('Comment not found');

  if (comment.authorUserId !== userId) {
    const docType = comment.documentType as ReviewDocumentType;
    const ownerIds = await getDocumentOwnerIds(comment.documentId, docType);
    if (!ownerIds.includes(userId)) {
      const approver = await isAssignedApprover(comment.documentId, docType, userId);
      if (!approver) {
        throw forbidden('Only the comment author, document owner, or assigned approver can delete a comment');
      }
    }
  }

  await db.delete(reviewComments).where(eq(reviewComments.id, commentId));
}
