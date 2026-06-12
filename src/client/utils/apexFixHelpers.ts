import type { DesignDoc, Prd } from '../../shared/types/interview';

export function prdHasProposedChanges(prd: Pick<Prd, 'proposedContent' | 'proposedBacklogJson'>): boolean {
  return prd.proposedContent != null || prd.proposedBacklogJson != null;
}

export function isPrdSingleCommentFixPending(
  prd: Pick<Prd, 'fixCommentId' | 'proposedContent' | 'proposedBacklogJson'>,
): boolean {
  return !!prd.fixCommentId && !prdHasProposedChanges(prd);
}

export function designDocHasProposedChanges(
  doc: Pick<DesignDoc, 'proposedDesignContent' | 'proposedTechSpecContent' | 'proposedAssumptionsContent'>,
): boolean {
  return (
    doc.proposedDesignContent != null
    || doc.proposedTechSpecContent != null
    || doc.proposedAssumptionsContent != null
  );
}

export function isDesignDocSingleCommentFixPending(
  doc: Pick<DesignDoc, 'fixCommentId' | 'proposedDesignContent' | 'proposedTechSpecContent' | 'proposedAssumptionsContent'>,
): boolean {
  return !!doc.fixCommentId && !designDocHasProposedChanges(doc);
}
