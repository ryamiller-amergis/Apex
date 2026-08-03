import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChangeReviewWizard } from './ChangeReviewWizard';
import { PrdFixActionStrip } from './PrdFixActionStrip';
import type { PrdFixActionStripProgress } from './PrdFixActionStrip';
import {
  useApplyProposedDesignDoc,
  useApplyProposedDesignDocSelective,
  useRejectProposedDesignDoc,
  useRegenerateProposedDesignDocSection,
} from '../hooks/useInterviews';
import {
  buildDesignDocChangeUnits,
  mergeDesignDocProposalFromUnits,
  reapplyDecisions,
  countDecisions,
} from '../utils/changeReview';
import type { ChangeUnit, ChangeDecision, MarkdownHunkMeta, DesignDocSectionKey } from '../utils/changeReview';
import styles from './ProposedChangesReview.module.css';

export interface ProposedDesignDocChangesReviewProps {
  designDocId: string;
  currentDesign: string;
  currentTechSpec: string;
  currentAssumptions: string;
  proposedDesignContent?: string | null;
  proposedTechSpecContent?: string | null;
  proposedAssumptionsContent?: string | null;
  /** When set (e.g. single-comment fix), strip label becomes "Comment fix ready". */
  fixCommentId?: string | null;
}

export const ProposedDesignDocChangesReview: React.FC<ProposedDesignDocChangesReviewProps> = ({
  designDocId,
  currentDesign,
  currentTechSpec,
  currentAssumptions,
  proposedDesignContent,
  proposedTechSpecContent,
  proposedAssumptionsContent,
  fixCommentId,
}) => {
  const [modalOpen, setModalOpen] = useState(false);
  const [reviewStarted, setReviewStarted] = useState(false);
  const [units, setUnits] = useState<ChangeUnit[]>([]);
  const [progress, setProgress] = useState<PrdFixActionStripProgress>({
    approved: 0,
    rejected: 0,
    pending: 0,
    total: 0,
  });
  const lastRegeneratedUnitIdRef = useRef<string | undefined>(undefined);
  const didAutoOpenRef = useRef(false);

  const applyAll = useApplyProposedDesignDoc(designDocId);
  const selectiveApply = useApplyProposedDesignDocSelective(designDocId);
  const rejectMutation = useRejectProposedDesignDoc(designDocId);
  const regenerateMutation = useRegenerateProposedDesignDocSection(designDocId);

  const builtUnits = useMemo(
    () =>
      buildDesignDocChangeUnits(
        {
          design: currentDesign,
          techSpec: currentTechSpec,
          assumptions: currentAssumptions,
        },
        {
          design: proposedDesignContent,
          techSpec: proposedTechSpecContent,
          assumptions: proposedAssumptionsContent,
        },
      ),
    [
      currentDesign,
      currentTechSpec,
      currentAssumptions,
      proposedDesignContent,
      proposedTechSpecContent,
      proposedAssumptionsContent,
    ],
  );

  useEffect(() => {
    if (builtUnits.length === 0) {
      didAutoOpenRef.current = false;
      setModalOpen((open) => (open ? false : open));
      setReviewStarted(false);
      setUnits([]);
      return;
    }
    if (didAutoOpenRef.current) return;
    didAutoOpenRef.current = true;
    setUnits(builtUnits);
    setReviewStarted(true);
    setModalOpen(true);
  }, [builtUnits]);

  useEffect(() => {
    if (!reviewStarted) return;
    const regeneratedId = lastRegeneratedUnitIdRef.current;
    setUnits((prior) => {
      if (prior.length === 0) return builtUnits;
      return reapplyDecisions(builtUnits, prior, regeneratedId);
    });
    lastRegeneratedUnitIdRef.current = undefined;
  }, [builtUnits, reviewStarted]);

  const activeUnits = units.length > 0 ? units : builtUnits;
  const decisionCounts = countDecisions(activeUnits);

  useEffect(() => {
    setProgress((prev) => {
      const next = {
        ...decisionCounts,
        total: activeUnits.length,
      };
      if (
        prev.approved === next.approved
        && prev.rejected === next.rejected
        && prev.pending === next.pending
        && prev.total === next.total
      ) {
        return prev;
      }
      return next;
    });
  }, [
    decisionCounts.approved,
    decisionCounts.rejected,
    decisionCounts.pending,
    activeUnits.length,
  ]);

  const handleDecision = useCallback((unitId: string, decision: Exclude<ChangeDecision, 'pending'>) => {
    setUnits((prev) => prev.map((u) => (u.id === unitId ? { ...u, decision } : u)));
  }, []);

  const handleRegenerate = useCallback(
    async (unitId: string, feedback: string) => {
      const unit = units.find((u) => u.id === unitId) ?? activeUnits.find((u) => u.id === unitId);
      if (!unit || unit.kind !== 'markdown-hunk') return;
      const section = (unit.meta as MarkdownHunkMeta).docSection as DesignDocSectionKey | undefined;
      if (section !== 'design' && section !== 'tech_spec' && section !== 'assumptions') return;

      lastRegeneratedUnitIdRef.current = unitId;
      await regenerateMutation.mutateAsync({
        section,
        oldText: unit.oldText,
        newText: unit.newText,
        feedback,
      });
      setUnits((prev) =>
        prev.map((u) => (u.id === unitId ? { ...u, decision: 'pending', feedback } : u)),
      );
    },
    [units, activeUnits, regenerateMutation],
  );

  const handleFinish = useCallback(
    async (finalUnits: ChangeUnit[]) => {
      const merged = mergeDesignDocProposalFromUnits(
        {
          design: currentDesign,
          techSpec: currentTechSpec,
          assumptions: currentAssumptions,
        },
        {
          design: proposedDesignContent,
          techSpec: proposedTechSpecContent,
          assumptions: proposedAssumptionsContent,
        },
        finalUnits,
      );
      await selectiveApply.mutateAsync(merged);
      setModalOpen(false);
      setReviewStarted(false);
    },
    [
      currentDesign,
      currentTechSpec,
      currentAssumptions,
      proposedDesignContent,
      proposedTechSpecContent,
      proposedAssumptionsContent,
      selectiveApply,
    ],
  );

  const openWizard = () => {
    if (!reviewStarted || units.length === 0) setUnits(builtUnits);
    setReviewStarted(true);
    setModalOpen(true);
  };

  const busy =
    applyAll.isPending
    || selectiveApply.isPending
    || rejectMutation.isPending
    || regenerateMutation.isPending;

  if (
    proposedDesignContent == null
    && proposedTechSpecContent == null
    && proposedAssumptionsContent == null
  ) {
    return null;
  }

  const modalPortal =
    reviewStarted
    && typeof document !== 'undefined'
    && createPortal(
      <div
        className={modalOpen ? styles.modalOverlay : styles.modalOverlayHidden}
        role="dialog"
        aria-modal={modalOpen ? 'true' : undefined}
        aria-hidden={!modalOpen}
        aria-labelledby="design-doc-change-review-title"
        onClick={(e) => {
          if (e.target === e.currentTarget && !busy) setModalOpen(false);
        }}
      >
        <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
          <div className={styles.modalHeader}>
            <h2 id="design-doc-change-review-title" className={styles.modalTitle}>
              Review design doc changes
            </h2>
            <div className={styles.modalHeaderActions}>
              <button
                type="button"
                className={styles.minimizeBtn}
                onClick={() => setModalOpen(false)}
                disabled={busy}
              >
                Minimize
              </button>
            </div>
          </div>
          <div className={styles.modalBody}>
            <ChangeReviewWizard
              units={activeUnits}
              onDecision={handleDecision}
              onRequestRegenerate={handleRegenerate}
              onFinish={handleFinish}
              onCancel={() => setModalOpen(false)}
              cancelLabel="Minimize"
              isRegenerating={regenerateMutation.isPending}
              isApplying={selectiveApply.isPending}
            />
          </div>
        </div>
      </div>,
      document.body,
    );

  return (
    <>
      <PrdFixActionStrip
        summaryLabel={fixCommentId ? 'Comment fix ready' : 'Proposed changes'}
        progress={progress}
        busy={busy}
        onContinueReview={openWizard}
        onAcceptAll={() => applyAll.mutate()}
        onRevert={() => rejectMutation.mutate()}
        onPreview={openWizard}
        acceptLabel="Accept all"
        revertLabel="Reject all"
        ariaLabel="Design doc proposed changes review"
      />
      {modalPortal}
    </>
  );
};

export default ProposedDesignDocChangesReview;
