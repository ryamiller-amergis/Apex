import type { DesignDoc, Prd, PrdValidationBaseline } from '../../shared/types/interview';

export function prdHasProposedChanges(prd: Pick<Prd, 'proposedContent' | 'proposedBacklogJson'>): boolean {
  return prd.proposedContent != null || prd.proposedBacklogJson != null;
}

/** True when live PRD content/backlog still match the Fix-with-Apex baseline (no-op session). */
export function isPrdUnchangedFromFixBaseline(
  prd: Pick<Prd, 'content' | 'backlogJson'>,
  baseline: Pick<PrdValidationBaseline, 'content' | 'backlogJson'>,
): boolean {
  const contentMatch = (prd.content || '') === (baseline.content || '');
  const backlogMatch =
    JSON.stringify(prd.backlogJson ?? null) === JSON.stringify(baseline.backlogJson ?? null);
  return contentMatch && backlogMatch;
}

/**
 * True while Fix-with-Apex (validation or coverage) owns accept/revert for the
 * live baseline→content review path. Proposed_* drafts from the normal assistant
 * or comment fixes always take priority in the UI when present.
 */
export function isPrdFixFlowOwningAccept(
  prd: Pick<Prd, 'fixBaseline' | 'proposedContent' | 'proposedBacklogJson'>,
  fixPhase: 'idle' | 'fixing' | 'reviewing',
): boolean {
  if (prdHasProposedChanges(prd)) return false;
  return !!prd.fixBaseline || fixPhase === 'fixing' || fixPhase === 'reviewing';
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
