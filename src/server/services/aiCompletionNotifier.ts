import { eq, and } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  prds,
  designDocs,
  testCases,
  designPrototypes,
  documentApproverAssignments,
} from '../db/schema';
import { createNotification } from './notificationService';

export type AiCompletionEvent =
  | 'prd_generated'
  | 'test_cases_generated'
  | 'prd_validation_complete'
  | 'prd_fix_complete'
  | 'design_doc_generated'
  | 'design_doc_validation_complete'
  | 'design_doc_fix_complete'
  | 'design_prototype_generated';

// ── Interview resolution helpers ─────────────────────────────────────────────

interface InterviewOwners {
  prdOwnerId: string | null;
  designDocOwnerId: string | null;
  designPrototypeOwnerId: string | null;
}

async function resolveInterviewFromPrd(prdId: string): Promise<InterviewOwners | null> {
  const row = await db.query.prds.findFirst({
    where: eq(prds.id, prdId),
    columns: { interviewId: true },
    with: {
      interview: {
        columns: { prdOwnerId: true, designDocOwnerId: true, designPrototypeOwnerId: true },
      },
    },
  });
  return row?.interview ?? null;
}

async function resolveInterviewFromDesignDoc(designDocId: string): Promise<InterviewOwners | null> {
  const row = await db.query.designDocs.findFirst({
    where: eq(designDocs.id, designDocId),
    columns: { prdId: true },
    with: {
      prd: {
        columns: { interviewId: true },
        with: {
          interview: {
            columns: { prdOwnerId: true, designDocOwnerId: true, designPrototypeOwnerId: true },
          },
        },
      },
    },
  });
  return row?.prd?.interview ?? null;
}

async function resolveInterviewFromTestCase(testCaseId: string): Promise<{ interview: InterviewOwners | null; prdId: string | null }> {
  const row = await db.query.testCases.findFirst({
    where: eq(testCases.id, testCaseId),
    columns: { prdId: true },
    with: {
      prd: {
        columns: { interviewId: true },
        with: {
          interview: {
            columns: { prdOwnerId: true, designDocOwnerId: true, designPrototypeOwnerId: true },
          },
        },
      },
    },
  });
  return {
    interview: row?.prd?.interview ?? null,
    prdId: row?.prdId ?? null,
  };
}

async function resolveInterviewFromPrototype(prototypeId: string): Promise<{ interview: InterviewOwners | null; prdId: string | null }> {
  const row = await db.query.designPrototypes.findFirst({
    where: eq(designPrototypes.id, prototypeId),
    columns: { prdId: true },
    with: {
      prd: {
        columns: { interviewId: true },
        with: {
          interview: {
            columns: { prdOwnerId: true, designDocOwnerId: true, designPrototypeOwnerId: true },
          },
        },
      },
    },
  });
  return {
    interview: row?.prd?.interview ?? null,
    prdId: row?.prdId ?? null,
  };
}

// ── Reviewer resolution ──────────────────────────────────────────────────────

async function getAssignedReviewerIds(documentId: string, documentType: string): Promise<string[]> {
  const rows = await db
    .select({ approverUserId: documentApproverAssignments.approverUserId })
    .from(documentApproverAssignments)
    .where(
      and(
        eq(documentApproverAssignments.documentId, documentId),
        eq(documentApproverAssignments.documentType, documentType),
      ),
    );
  return rows.map((r) => r.approverUserId);
}

// ── Deduplication ────────────────────────────────────────────────────────────

function dedupeRecipients(...ids: (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => id != null && id !== ''))];
}

// ── Notification payload builders ────────────────────────────────────────────

function buildPayload(
  event: AiCompletionEvent,
  entityId: string,
  meta: { title?: string; score?: number; passed?: boolean },
  resolvedPrdId?: string | null,
): { title: string; body: string; link: string } {
  const t = meta.title ?? 'Untitled';

  switch (event) {
    case 'prd_generated':
      return {
        title: 'PRD generation complete',
        body: `Your PRD "${t}" has been generated`,
        link: `/backlog/prd/${entityId}`,
      };
    case 'test_cases_generated':
      return {
        title: 'Test cases generated',
        body: `Test cases for "${t}" are ready`,
        link: `/backlog/prd/${resolvedPrdId ?? entityId}`,
      };
    case 'prd_validation_complete':
      return {
        title: 'PRD validation complete',
        body: `Validation ${meta.passed ? 'passed' : 'needs attention'} for "${t}" (score: ${meta.score})`,
        link: `/backlog/prd/${entityId}`,
      };
    case 'prd_fix_complete':
      return {
        title: 'PRD fix applied',
        body: `Apex fix applied to "${t}" — re-validation started`,
        link: `/backlog/prd/${entityId}`,
      };
    case 'design_doc_generated':
      return {
        title: 'Design doc generated',
        body: `Design doc "${t}" has been generated`,
        link: `/backlog/design-doc/${entityId}`,
      };
    case 'design_doc_validation_complete':
      return {
        title: 'Design doc validation complete',
        body: `Validation ${meta.passed ? 'passed' : 'needs attention'} for "${t}" (score: ${meta.score})`,
        link: `/backlog/design-doc/${entityId}`,
      };
    case 'design_doc_fix_complete':
      return {
        title: 'Design doc fix applied',
        body: `Apex fix applied to "${t}" — re-validation started`,
        link: `/backlog/design-doc/${entityId}`,
      };
    case 'design_prototype_generated':
      return {
        title: 'Design prototype ready',
        body: `Prototype for "${t}" is ready for review`,
        link: `/backlog/design-prototype/${resolvedPrdId ?? entityId}`,
      };
  }
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function notifyAiCompletion(
  event: AiCompletionEvent,
  entityId: string,
  meta?: { title?: string; score?: number; passed?: boolean },
): Promise<void> {
  try {
    const safeMeta = meta ?? {};
    let interview: InterviewOwners | null = null;
    let resolvedPrdId: string | null = null;
    let ownerId: string | null = null;
    let reviewerIds: string[] = [];

    switch (event) {
      case 'prd_generated':
      case 'prd_validation_complete':
      case 'prd_fix_complete': {
        interview = await resolveInterviewFromPrd(entityId);
        ownerId = interview?.prdOwnerId ?? null;
        if (event === 'prd_validation_complete' || event === 'prd_fix_complete') {
          reviewerIds = await getAssignedReviewerIds(entityId, 'prd');
        }
        break;
      }
      case 'test_cases_generated': {
        const result = await resolveInterviewFromTestCase(entityId);
        interview = result.interview;
        resolvedPrdId = result.prdId;
        ownerId = interview?.prdOwnerId ?? null;
        break;
      }
      case 'design_doc_generated':
      case 'design_doc_validation_complete':
      case 'design_doc_fix_complete': {
        interview = await resolveInterviewFromDesignDoc(entityId);
        ownerId = interview?.designDocOwnerId ?? null;
        if (event === 'design_doc_validation_complete' || event === 'design_doc_fix_complete') {
          reviewerIds = await getAssignedReviewerIds(entityId, 'design_doc');
        }
        break;
      }
      case 'design_prototype_generated': {
        const result = await resolveInterviewFromPrototype(entityId);
        interview = result.interview;
        resolvedPrdId = result.prdId;
        ownerId = interview?.designPrototypeOwnerId ?? null;
        reviewerIds = await getAssignedReviewerIds(resolvedPrdId!, 'design_prototype');
        break;
      }
    }

    const recipients = dedupeRecipients(ownerId, ...reviewerIds);
    if (recipients.length === 0) return;

    const payload = buildPayload(event, entityId, safeMeta, resolvedPrdId);

    await Promise.allSettled(
      recipients.map((userId) =>
        createNotification(userId, {
          type: 'ai',
          title: payload.title,
          body: payload.body,
          link: payload.link,
        }),
      ),
    );
  } catch (err) {
    console.error('[aiCompletionNotifier] Failed to send notification:', err);
  }
}
