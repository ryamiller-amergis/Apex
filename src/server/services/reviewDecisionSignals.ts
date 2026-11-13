/**
 * Approver and owner decisions on reviewed documents, recorded as Skill signals. The approval tables keep only
 * each reviewer's latest answer; these signals keep every round, so Skill Health can count review rounds.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { adrs, designDocs, prds } from '../db/schema';
import type { SkillLearningSurface } from '../../shared/constants/skillLearningSurfaces';
import { emitSkillSignalLater, type SkillSignalInput } from './skillSignalService';

export type ReviewDecisionDocumentType = 'prd' | 'design_doc' | 'test_case' | 'design_prototype' | 'adr';
export type ReviewDecisionRole = 'approver' | 'owner';

interface ReviewedDocument {
  project: string;
  surface: SkillLearningSurface;
  threadId: string | null;
  skillSha256: string | null;
}

async function loadReviewedDocument(
  documentType: ReviewDecisionDocumentType,
  documentId: string,
): Promise<ReviewedDocument | null> {
  switch (documentType) {
    case 'prd':
    case 'test_case': {
      const row = await db.query.prds.findFirst({
        where: eq(prds.id, documentId),
        columns: { project: true, chatThreadId: true, skillSha256: true },
      });
      if (!row) return null;
      return documentType === 'prd'
        ? { project: row.project, surface: 'prd', threadId: row.chatThreadId, skillSha256: row.skillSha256 }
        : { project: row.project, surface: 'test_cases', threadId: null, skillSha256: null };
    }
    case 'design_doc': {
      const row = await db.query.designDocs.findFirst({
        where: eq(designDocs.id, documentId),
        columns: { project: true, chatThreadId: true, skillSha256: true },
      });
      return row ? { project: row.project, surface: 'design_doc', threadId: row.chatThreadId, skillSha256: row.skillSha256 } : null;
    }
    case 'adr': {
      const row = await db.query.adrs.findFirst({
        where: eq(adrs.id, documentId),
        columns: { project: true, generationThreadId: true },
      });
      return row ? { project: row.project, surface: 'adr', threadId: row.generationThreadId, skillSha256: null } : null;
    }
    case 'design_prototype':
      return null;
    default: {
      const unhandled: never = documentType;
      throw new Error(`Unsupported review document type: ${String(unhandled)}`);
    }
  }
}

export async function reviewDecisionSignal(input: {
  documentId: string;
  documentType: ReviewDecisionDocumentType;
  actorId: string;
  role: ReviewDecisionRole;
  status: 'approved' | 'revision_requested';
  respondedAt: string;
  comment?: string | null;
}): Promise<SkillSignalInput | null> {
  const doc = await loadReviewedDocument(input.documentType, input.documentId);
  if (!doc) return null;
  return {
    project: doc.project,
    surface: doc.surface,
    subjectType: input.documentType,
    subjectId: input.documentId,
    kind: input.status === 'approved' ? 'accepted' : 'rejected',
    threadId: doc.threadId,
    actorId: input.actorId,
    comment: input.comment ?? null,
    metadata: { source: 'review', role: input.role },
    provenance: doc.skillSha256 ? { skillSha256: doc.skillSha256 } : undefined,
    idempotencyKey: `review:${input.role}:${input.documentType}:${input.documentId}:${input.actorId}:${input.respondedAt}`,
  };
}

export function emitReviewDecisionSignal(input: Parameters<typeof reviewDecisionSignal>[0]): void {
  emitSkillSignalLater(`${input.role} review ${input.documentType} ${input.documentId}`, () => reviewDecisionSignal(input));
}
