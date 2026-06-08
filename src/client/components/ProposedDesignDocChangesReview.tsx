import React, { useState } from 'react';
import { DiffView } from './DiffView';
import { useApplyProposedDesignDoc, useRejectProposedDesignDoc } from '../hooks/useInterviews';
import styles from './ProposedDesignDocChangesReview.module.css';

export interface ProposedDesignDocChangesReviewProps {
  designDocId: string;
  currentDesign: string;
  currentTechSpec: string;
  currentAssumptions: string;
  proposedDesignContent?: string | null;
  proposedTechSpecContent?: string | null;
  proposedAssumptionsContent?: string | null;
}

function buildSectionHint(hasDesign: boolean, hasTechSpec: boolean, hasAssumptions: boolean): string {
  const parts: string[] = [];
  if (hasDesign) parts.push('Design');
  if (hasTechSpec) parts.push('Tech Spec');
  if (hasAssumptions) parts.push('Assumptions');

  if (parts.length === 0) return '';
  if (parts.length === 1) return ` — to the ${parts[0]} section`;
  if (parts.length === 2) return ` — to the ${parts[0]} and ${parts[1]} sections`;
  return ` — to the ${parts[0]}, ${parts[1]}, and ${parts[2]} sections`;
}

export const ProposedDesignDocChangesReview: React.FC<ProposedDesignDocChangesReviewProps> = ({
  designDocId,
  currentDesign,
  currentTechSpec,
  currentAssumptions,
  proposedDesignContent,
  proposedTechSpecContent,
  proposedAssumptionsContent,
}) => {
  const [expanded, setExpanded] = useState(false);

  const applyMutation = useApplyProposedDesignDoc(designDocId);
  const rejectMutation = useRejectProposedDesignDoc(designDocId);

  const hasDesign = proposedDesignContent != null;
  const hasTechSpec = proposedTechSpecContent != null;
  const hasAssumptions = proposedAssumptionsContent != null;

  if (!hasDesign && !hasTechSpec && !hasAssumptions) {
    return null;
  }

  const sectionHint = buildSectionHint(hasDesign, hasTechSpec, hasAssumptions);
  const isPending = applyMutation.isPending || rejectMutation.isPending;

  return (
    <div className={styles.banner}>
      <div className={styles.bannerTop}>
        <div className={styles.bannerLeft}>
          <svg
            className={styles.bannerIcon}
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="10" cy="10" r="9" />
            <path d="M10 6v4M10 14h.01" />
          </svg>
          <div>
            <span className={styles.bannerTitle}>The Apex Assistant has proposed changes</span>
            <span className={styles.bannerHint}>{sectionHint}</span>
          </div>
        </div>

        <div className={styles.bannerActions}>
          <button
            type="button"
            className={styles.reviewBtn}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Hide Changes' : 'Review Changes'}
          </button>
          <button
            type="button"
            className={styles.acceptBtn}
            onClick={() => applyMutation.mutate()}
            disabled={isPending}
          >
            {applyMutation.isPending ? 'Applying…' : 'Accept Changes'}
          </button>
          <button
            type="button"
            className={styles.rejectBtn}
            onClick={() => rejectMutation.mutate()}
            disabled={isPending}
          >
            {rejectMutation.isPending ? 'Rejecting…' : 'Reject Changes'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className={styles.diffSection}>
          {hasDesign && (
            <div className={styles.diffBlock}>
              <div className={styles.diffBlockLabel}>Design Changes</div>
              <DiffView oldText={currentDesign} newText={proposedDesignContent!} />
            </div>
          )}
          {hasTechSpec && (
            <div className={styles.diffBlock}>
              <div className={styles.diffBlockLabel}>Tech Spec Changes</div>
              <DiffView oldText={currentTechSpec} newText={proposedTechSpecContent!} />
            </div>
          )}
          {hasAssumptions && (
            <div className={styles.diffBlock}>
              <div className={styles.diffBlockLabel}>Assumptions Changes</div>
              <DiffView oldText={currentAssumptions} newText={proposedAssumptionsContent!} />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ProposedDesignDocChangesReview;
