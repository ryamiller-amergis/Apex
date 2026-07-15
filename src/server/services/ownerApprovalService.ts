import { eq, and } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { documentOwnerApprovals, interviews, prds, designDocs, designPrototypes } from '../db/schema';
import type { DocumentOwnerApproval, OwnerApprovalDocumentType, OwnerApprovalStatus } from '../../shared/types/approvals';

export async function getOwnerApproval(
  documentId: string,
  documentType: OwnerApprovalDocumentType,
): Promise<DocumentOwnerApproval | null> {
  const row = await db.query.documentOwnerApprovals.findFirst({
    where: and(
      eq(documentOwnerApprovals.documentId, documentId),
      eq(documentOwnerApprovals.documentType, documentType),
    ),
  });
  if (!row) return null;
  return {
    id: row.id,
    documentId: row.documentId,
    documentType: row.documentType as OwnerApprovalDocumentType,
    ownerUserId: row.ownerUserId,
    status: row.status,
    comment: row.comment,
    respondedAt: row.respondedAt,
    createdAt: row.createdAt,
  };
}

export async function recordOwnerApproval(
  documentId: string,
  documentType: OwnerApprovalDocumentType,
  ownerUserId: string,
  status: OwnerApprovalStatus,
  comment?: string,
): Promise<DocumentOwnerApproval> {
  const now = new Date().toISOString();
  const [row] = await db
    .insert(documentOwnerApprovals)
    .values({
      documentId,
      documentType,
      ownerUserId,
      status,
      comment: comment ?? null,
      respondedAt: now,
    })
    .onConflictDoUpdate({
      target: [documentOwnerApprovals.documentId, documentOwnerApprovals.documentType],
      set: {
        ownerUserId,
        status,
        comment: comment ?? null,
        respondedAt: now,
      },
    })
    .returning();

  return {
    id: row.id,
    documentId: row.documentId,
    documentType: row.documentType as OwnerApprovalDocumentType,
    ownerUserId: row.ownerUserId,
    status: row.status,
    comment: row.comment,
    respondedAt: row.respondedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Resolve the document owner from the interviews table.
 * All three document types join through prds → interviews to find the owner.
 */
export async function isDocumentOwner(
  documentId: string,
  documentType: OwnerApprovalDocumentType,
  userId: string,
): Promise<boolean> {
  const ownerId = await resolveDocumentOwnerId(documentId, documentType);
  return ownerId === userId;
}

export async function resolveDocumentOwnerId(
  documentId: string,
  documentType: OwnerApprovalDocumentType,
): Promise<string | null> {
  switch (documentType) {
    case 'prd': {
      const prdRow = await db.query.prds.findFirst({
        where: eq(prds.id, documentId),
        columns: { interviewId: true },
      });
      if (!prdRow?.interviewId) return null;
      const interviewRow = await db.query.interviews.findFirst({
        where: eq(interviews.id, prdRow.interviewId),
        columns: { prdOwnerId: true },
      });
      return interviewRow?.prdOwnerId ?? null;
    }
    case 'test_case': {
      const prdRow = await db.query.prds.findFirst({
        where: eq(prds.id, documentId),
        columns: { interviewId: true },
      });
      if (!prdRow?.interviewId) return null;
      const interviewRow = await db.query.interviews.findFirst({
        where: eq(interviews.id, prdRow.interviewId),
        columns: { testCaseOwnerId: true },
      });
      return interviewRow?.testCaseOwnerId ?? null;
    }
    case 'design_prototype': {
      // documentId is a prototypeId — resolve through prototype → prd → interview
      const protoRow = await db.query.designPrototypes.findFirst({
        where: eq(designPrototypes.id, documentId),
        columns: { prdId: true },
      });
      if (!protoRow?.prdId) return null;
      const prdRow = await db.query.prds.findFirst({
        where: eq(prds.id, protoRow.prdId),
        columns: { interviewId: true },
      });
      if (!prdRow?.interviewId) return null;
      const interviewRow = await db.query.interviews.findFirst({
        where: eq(interviews.id, prdRow.interviewId),
        columns: { designPrototypeOwnerId: true },
      });
      return interviewRow?.designPrototypeOwnerId ?? null;
    }
    case 'design_doc': {
      const docRow = await db.query.designDocs.findFirst({
        where: eq(designDocs.id, documentId),
        columns: { prdId: true },
      });
      if (!docRow?.prdId) return null;
      const prdRow = await db.query.prds.findFirst({
        where: eq(prds.id, docRow.prdId),
        columns: { interviewId: true },
      });
      if (!prdRow?.interviewId) return null;
      const interviewRow = await db.query.interviews.findFirst({
        where: eq(interviews.id, prdRow.interviewId),
        columns: { designDocOwnerId: true },
      });
      return interviewRow?.designDocOwnerId ?? null;
    }
  }
}
