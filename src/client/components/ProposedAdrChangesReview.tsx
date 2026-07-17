import React, { useState } from 'react';
import { useApplyProposedAdr, useRejectProposedAdr } from '../hooks/useAdrs';
import { DiffView } from './DiffView';
import styles from './ProposedDesignDocChangesReview.module.css';

export interface ProposedAdrChangesReviewProps {
  adrId: string;
  currentContent: string;
  proposedContent?: string | null;
}

export const ProposedAdrChangesReview: React.FC<ProposedAdrChangesReviewProps> = ({
  adrId,
  currentContent,
  proposedContent,
}) => {
  const [expanded, setExpanded] = useState(true);
  const applyMutation = useApplyProposedAdr(adrId);
  const rejectMutation = useRejectProposedAdr(adrId);

  if (proposedContent == null) return null;
  const pending = applyMutation.isPending || rejectMutation.isPending;

  return (
    <div className={styles.banner}>
      <div className={styles.bannerTop}>
        <div className={styles.bannerLeft}>
          <svg className={styles.bannerIcon} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <circle cx="10" cy="10" r="9" />
            <path d="M10 6v4M10 14h.01" />
          </svg>
          <span className={styles.bannerTitle}>The ADR Apex Assistant has proposed edits</span>
        </div>
        <div className={styles.bannerActions}>
          <button type="button" className={styles.reviewBtn} onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Hide diff' : 'Review diff'}
          </button>
          <button type="button" className={styles.acceptBtn} disabled={pending} onClick={() => applyMutation.mutate()}>
            {applyMutation.isPending ? 'Applying…' : 'Apply proposed edits'}
          </button>
          <button type="button" className={styles.rejectBtn} disabled={pending} onClick={() => rejectMutation.mutate()}>
            {rejectMutation.isPending ? 'Rejecting…' : 'Reject proposed edits'}
          </button>
        </div>
      </div>
      {expanded && (
        <div className={styles.diffSection}>
          <div className={styles.diffBlock}>
            <div className={styles.diffBlockLabel}>ADR markdown changes</div>
            <DiffView oldText={currentContent} newText={proposedContent} />
          </div>
        </div>
      )}
    </div>
  );
};

export default ProposedAdrChangesReview;
