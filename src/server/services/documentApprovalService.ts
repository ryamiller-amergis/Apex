import { db } from '../db/drizzle';
import {
  documentApproverAssignments,
  projectSkillSettings,
  prds,
  designDocs,
  appUsers,
} from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { getApproversForDocument } from './projectSettingsService';
import { createNotification } from './notificationService';
import type {
  DocumentApproverAssignment,
  ApprovalMode,
  ApprovalCompletionResult,
  ApproverResponseStatus,
} from '../../shared/types/approvals';
import type { ProjectApprover } from '../../shared/types/projectSettings';

async function getProjectForDocument(
  documentId: string,
  documentType: 'prd' | 'design_doc',
): Promise<string> {
  if (documentType === 'prd') {
    const rows = await db
      .select({ project: prds.project })
      .from(prds)
      .where(eq(prds.id, documentId))
      .limit(1);
    if (!rows[0]) throw new Error(`PRD not found: ${documentId}`);
    return rows[0].project;
  }
  const rows = await db
    .select({ project: designDocs.project })
    .from(designDocs)
    .where(eq(designDocs.id, documentId))
    .limit(1);
  if (!rows[0]) throw new Error(`Design doc not found: ${documentId}`);
  return rows[0].project;
}

async function getDocumentTitle(documentId: string, documentType: 'prd' | 'design_doc'): Promise<string> {
  if (documentType === 'prd') {
    const rows = await db.select({ title: prds.title }).from(prds).where(eq(prds.id, documentId)).limit(1);
    return rows[0]?.title ?? 'Untitled PRD';
  }
  const rows = await db.select({ title: designDocs.title }).from(designDocs).where(eq(designDocs.id, documentId)).limit(1);
  return rows[0]?.title ?? 'Untitled Design Doc';
}

async function notifyAssignedApprovers(
  documentId: string,
  documentType: 'prd' | 'design_doc',
  approverUserIds: string[],
): Promise<void> {
  if (approverUserIds.length === 0) return;
  const docTitle = await getDocumentTitle(documentId, documentType);
  await Promise.allSettled(
    approverUserIds.map((userId) =>
      createNotification(userId, {
        type: 'user-action',
        title: documentType === 'prd'
          ? 'You have been assigned as a PRD reviewer'
          : 'You have been assigned as a design doc approver',
        body: `Review requested for: ${docTitle}`,
        link: documentType === 'prd'
          ? `/backlog/prd/${documentId}`
          : `/backlog/design-doc/${documentId}`,
      }),
    ),
  );
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function assignApprovers(
  documentId: string,
  documentType: 'prd' | 'design_doc',
  approverUserIds: string[],
  assignedBy: string,
): Promise<DocumentApproverAssignment[]> {
  if (approverUserIds.length === 0) return getAssignments(documentId, documentType);

  const project = await getProjectForDocument(documentId, documentType);
  const pool = await getApproversForDocument(project, documentType);
  const poolUserIds = new Set(pool.map((a) => a.userId));
  const invalid = approverUserIds.filter((id) => !poolUserIds.has(id));
  if (invalid.length > 0) {
    throw new Error(
      `Users not in the ${documentType} approver pool for project "${project}": ${invalid.join(', ')}`,
    );
  }

  await db
    .insert(documentApproverAssignments)
    .values(
      approverUserIds.map((userId) => ({
        documentId,
        documentType,
        approverUserId: userId,
        assignedBy,
      })),
    )
    .onConflictDoNothing();

  notifyAssignedApprovers(documentId, documentType, approverUserIds).catch((err) =>
    console.error('Failed to send approver assignment notifications', err),
  );

  return getAssignments(documentId, documentType);
}

export async function getAssignments(
  documentId: string,
  documentType: 'prd' | 'design_doc',
): Promise<DocumentApproverAssignment[]> {
  const rows = await db
    .select({
      id: documentApproverAssignments.id,
      documentId: documentApproverAssignments.documentId,
      documentType: documentApproverAssignments.documentType,
      approverUserId: documentApproverAssignments.approverUserId,
      approverDisplayName: appUsers.displayName,
      status: documentApproverAssignments.status,
      comment: documentApproverAssignments.comment,
      respondedAt: documentApproverAssignments.respondedAt,
      assignedAt: documentApproverAssignments.assignedAt,
      assignedBy: documentApproverAssignments.assignedBy,
    })
    .from(documentApproverAssignments)
    .innerJoin(appUsers, eq(documentApproverAssignments.approverUserId, appUsers.oid))
    .where(
      and(
        eq(documentApproverAssignments.documentId, documentId),
        eq(documentApproverAssignments.documentType, documentType),
      ),
    );

  return rows.map(({ approverDisplayName, documentType: dt, status, ...rest }) => ({
    ...rest,
    documentType: dt as 'prd' | 'design_doc',
    approverDisplayName: approverDisplayName ?? undefined,
    status: status as ApproverResponseStatus,
  }));
}

export async function recordApproverResponse(
  documentId: string,
  documentType: 'prd' | 'design_doc',
  approverUserId: string,
  status: 'approved' | 'revision_requested',
  comment?: string,
): Promise<void> {
  const result = await db
    .update(documentApproverAssignments)
    .set({
      status,
      comment: comment ?? null,
      respondedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(documentApproverAssignments.documentId, documentId),
        eq(documentApproverAssignments.documentType, documentType),
        eq(documentApproverAssignments.approverUserId, approverUserId),
      ),
    )
    .returning({ id: documentApproverAssignments.id });

  if (result.length === 0) {
    throw new Error(
      `No assignment found for approver "${approverUserId}" on ${documentType} "${documentId}"`,
    );
  }
}

export async function isApprovalComplete(
  documentId: string,
  documentType: 'prd' | 'design_doc',
  project: string,
): Promise<ApprovalCompletionResult> {
  const settings = await db
    .select({ approvalMode: projectSkillSettings.approvalMode })
    .from(projectSkillSettings)
    .where(eq(projectSkillSettings.project, project))
    .limit(1);

  const mode: ApprovalMode = settings[0]?.approvalMode ?? 'any_one';

  const assignments = await getAssignments(documentId, documentType);
  if (assignments.length === 0) return { complete: true, mode };

  if (mode === 'any_one') {
    return { complete: assignments.some((a) => a.status === 'approved'), mode };
  }

  return { complete: assignments.every((a) => a.status === 'approved'), mode };
}

export async function isAssignedApprover(
  documentId: string,
  documentType: 'prd' | 'design_doc',
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: documentApproverAssignments.id })
    .from(documentApproverAssignments)
    .where(
      and(
        eq(documentApproverAssignments.documentId, documentId),
        eq(documentApproverAssignments.documentType, documentType),
        eq(documentApproverAssignments.approverUserId, userId),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

export async function reassignApprovers(
  documentId: string,
  documentType: 'prd' | 'design_doc',
  approverUserIds: string[],
  reassignedBy: string,
): Promise<DocumentApproverAssignment[]> {
  const previousPending = await db
    .select({ approverUserId: documentApproverAssignments.approverUserId })
    .from(documentApproverAssignments)
    .where(
      and(
        eq(documentApproverAssignments.documentId, documentId),
        eq(documentApproverAssignments.documentType, documentType),
        eq(documentApproverAssignments.status, 'pending'),
      ),
    );
  const previousPendingIds = new Set(previousPending.map((r) => r.approverUserId));

  await db
    .delete(documentApproverAssignments)
    .where(
      and(
        eq(documentApproverAssignments.documentId, documentId),
        eq(documentApproverAssignments.documentType, documentType),
        eq(documentApproverAssignments.status, 'pending'),
      ),
    );

  if (approverUserIds.length === 0) {
    return getAssignments(documentId, documentType);
  }

  const project = await getProjectForDocument(documentId, documentType);
  const pool = await getApproversForDocument(project, documentType);
  const poolUserIds = new Set(pool.map((a) => a.userId));
  const invalid = approverUserIds.filter((id) => !poolUserIds.has(id));
  if (invalid.length > 0) {
    throw new Error(
      `Users not in the ${documentType} approver pool for project "${project}": ${invalid.join(', ')}`,
    );
  }

  const existingResponded = await db
    .select({ approverUserId: documentApproverAssignments.approverUserId })
    .from(documentApproverAssignments)
    .where(
      and(
        eq(documentApproverAssignments.documentId, documentId),
        eq(documentApproverAssignments.documentType, documentType),
      ),
    );
  const respondedIds = new Set(existingResponded.map((r) => r.approverUserId));
  const newApproverIds = approverUserIds.filter((id) => !respondedIds.has(id));

  if (newApproverIds.length > 0) {
    await db
      .insert(documentApproverAssignments)
      .values(
        newApproverIds.map((userId) => ({
          documentId,
          documentType,
          approverUserId: userId,
          assignedBy: reassignedBy,
        })),
      )
      .onConflictDoNothing();
  }

  const trulyNewIds = newApproverIds.filter((id) => !previousPendingIds.has(id));
  notifyAssignedApprovers(documentId, documentType, trulyNewIds).catch((err) =>
    console.error('Failed to send approver reassignment notifications', err),
  );

  return getAssignments(documentId, documentType);
}

export async function getAvailableApprovers(
  project: string,
  documentType: 'prd' | 'design_doc',
  excludeUserId?: string,
): Promise<ProjectApprover[]> {
  const approvers = await getApproversForDocument(project, documentType);
  if (excludeUserId) {
    return approvers.filter((a) => a.userId !== excludeUserId);
  }
  return approvers;
}

export async function propagateDesignDocApprovers(
  prdId: string,
  designDocId: string,
  assignedBy: string,
): Promise<void> {
  const rows = await db
    .select({ designDocApproverIds: prds.designDocApproverIds })
    .from(prds)
    .where(eq(prds.id, prdId))
    .limit(1);

  const approverIds = rows[0]?.designDocApproverIds;
  if (approverIds && approverIds.length > 0) {
    await assignApprovers(designDocId, 'design_doc', approverIds, assignedBy);
  }
}

export async function notifyApproversDocumentReady(
  documentId: string,
  documentType: 'prd' | 'design_doc',
): Promise<void> {
  const assignments = await getAssignments(documentId, documentType);
  const pendingApprovers = assignments
    .filter((a) => a.status === 'pending')
    .map((a) => a.approverUserId);

  if (pendingApprovers.length === 0) return;

  const docTitle = await getDocumentTitle(documentId, documentType);
  await Promise.allSettled(
    pendingApprovers.map((userId) =>
      createNotification(userId, {
        type: 'user-action',
        title: documentType === 'prd'
          ? 'A PRD is ready for your review'
          : 'A design doc is ready for your review',
        body: `"${docTitle}" is now pending review`,
        link: documentType === 'prd'
          ? `/backlog/prd/${documentId}`
          : `/backlog/design-doc/${documentId}`,
      }),
    ),
  );
}
