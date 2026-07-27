import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChangeReviewWizard } from './ChangeReviewWizard';
import { PrdFixActionStrip } from './PrdFixActionStrip';
import type { PrdFixActionStripProgress } from './PrdFixActionStrip';
import {
  useApplyProposedAdr,
  useApplyProposedAdrSelective,
  useRejectProposedAdr,
  useRegenerateProposedAdrSection,
} from '../hooks/useAdrs';
import {
  buildAdrChangeUnits,
  mergeAdrProposalFromUnits,
  reapplyDecisions,
  countDecisions,
} from '../utils/changeReview';
import type { ChangeUnit, ChangeDecision } from '../utils/changeReview';
import styles from './ProposedChangesReview.module.css';

export interface ProposedAdrChangesReviewProps {
  adrId: string;
  currentContent: string;
  proposedContent?: string | null;
  fixCommentId?: string | null;
}

export const ProposedAdrChangesReview: React.FC<ProposedAdrChangesReviewProps> = ({
  adrId,
  currentContent,
  proposedContent,
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

  const applyAll = useApplyProposedAdr(adrId);
  const selectiveApply = useApplyProposedAdrSelective(adrId);
  const rejectMutation = useRejectProposedAdr(adrId);
  const regenerateMutation = useRegenerateProposedAdrSection(adrId);

  const builtUnits = useMemo(
    () => buildAdrChangeUnits(currentContent, proposedContent),
    [currentContent, proposedContent],
  );

  useEffect(() => {
    if (proposedContent == null || builtUnits.length === 0) {
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
  }, [builtUnits, proposedContent]);

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
      if (!unit) return;
      lastRegeneratedUnitIdRef.current = unitId;
      await regenerateMutation.mutateAsync({
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
      const merged = mergeAdrProposalFromUnits(currentContent, proposedContent, finalUnits);
      if (merged.content == null) return;
      await selectiveApply.mutateAsync({ content: merged.content });
      setModalOpen(false);
      setReviewStarted(false);
    },
    [currentContent, proposedContent, selectiveApply],
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

  if (proposedContent == null) return null;

  const modalPortal =
    reviewStarted
    && typeof document !== 'undefined'
    && createPortal(
      <div
        className={modalOpen ? styles.modalOverlay : styles.modalOverlayHidden}
        role="dialog"
        aria-modal={modalOpen ? 'true' : undefined}
        aria-hidden={!modalOpen}
        aria-labelledby="adr-change-review-title"
        onClick={(e) => {
          if (e.target === e.currentTarget && !busy) setModalOpen(false);
        }}
      >
        <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
          <div className={styles.modalHeader}>
            <h2 id="adr-change-review-title" className={styles.modalTitle}>
              Review ADR proposed edits
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
        summaryLabel={fixCommentId ? 'Comment fix ready' : 'Proposed ADR edits'}
        progress={progress}
        busy={busy}
        onContinueReview={openWizard}
        onAcceptAll={() => applyAll.mutate()}
        onRevert={() => rejectMutation.mutate()}
        onPreview={openWizard}
        acceptLabel="Accept all"
        revertLabel="Reject all"
        ariaLabel="ADR proposed changes review"
      />
      {modalPortal}
    </>
  );
};

export default ProposedAdrChangesReview;
