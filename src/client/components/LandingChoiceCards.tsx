import React from 'react';
import styles from './RfpIntakeLanding.module.css';

interface LandingChoiceCardsProps {
  onRequestProduct: () => void;
  onGoToProject: () => void;
  onOpenTriage?: () => void;
}

export const LandingChoiceCards: React.FC<LandingChoiceCardsProps> = ({
  onRequestProduct,
  onGoToProject,
  onOpenTriage,
}) => {
  return (
    <div className={styles.choiceGrid}>
      <button
        type="button"
        className={styles.choiceCard}
        onClick={onRequestProduct}
        aria-label="Request a Product"
        {...{ 'data-testid': 'rfp-request-product-card' }}
      >
        <span className={styles.choiceTitle}>Request a Product</span>
        <p className={styles.choiceBody}>
          Submit a structured request so Apex can evaluate a new-product need.
        </p>
      </button>
      <button
        type="button"
        className={styles.choiceCard}
        onClick={onGoToProject}
        aria-label="Go to a project"
        {...{ 'data-testid': 'rfp-go-to-project-card' }}
      >
        <span className={styles.choiceTitle}>Go to a project</span>
        <p className={styles.choiceBody}>
          Browse your assigned projects and continue planning.
        </p>
      </button>
      {onOpenTriage && (
        <button
          type="button"
          className={styles.choiceCard}
          onClick={onOpenTriage}
          aria-label="Open RFP Intake triage queue"
          {...{ 'data-testid': 'rfp-triage-entry-card' }}
        >
          <span className={styles.choiceTitle}>Review RFP Intake</span>
          <p className={styles.choiceBody}>
            Open the Apex shared queue to search, decide, and collaborate on requests.
          </p>
        </button>
      )}
    </div>
  );
};
