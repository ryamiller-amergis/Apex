import React from 'react';
import type { BuildRiskCategory, BuildRiskDecision, BuildRiskRating } from '../../shared/types/build';
import styles from './BuildRiskDecisions.module.css';

interface BuildRiskDecisionsProps {
  decisions: BuildRiskDecision[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

function categoryLabel(category: BuildRiskCategory): string {
  switch (category) {
    case 'data':
      return 'Data';
    case 'access':
      return 'Access';
    case 'integration':
      return 'Integration';
    case 'destructive':
      return 'Data removal';
    default: {
      const unhandled: never = category;
      return unhandled;
    }
  }
}

function ratingLabel(rating: BuildRiskRating): string {
  switch (rating) {
    case 'low':
      return 'Rating: Low';
    case 'medium':
      return 'Rating: Medium';
    case 'high':
      return 'Rating: High';
    default: {
      const unhandled: never = rating;
      return unhandled;
    }
  }
}

export const BuildRiskDecisions: React.FC<BuildRiskDecisionsProps> = ({ decisions, isLoading, isError, onRetry }) => {
  return (
    <section className={styles.section} {...{ 'data-testid': 'build-risk-decisions' }}>
      <h3 className={styles.heading}>Risk decisions</h3>
      {isLoading && <p className={styles.state}>Loading risk decisions…</p>}
      {!isLoading && isError && (
        <div className={styles.error} role="alert" {...{ 'data-testid': 'build-risk-decisions-error' }}>
          <span>The risk decisions could not be loaded.</span>
          <button
            type="button"
            className={styles.retry}
            onClick={onRetry}
            {...{ 'data-testid': 'build-risk-decisions-retry' }}
          >
            Retry
          </button>
        </div>
      )}
      {!isLoading && !isError && decisions && decisions.length === 0 && (
        <p className={styles.state} {...{ 'data-testid': 'build-risk-decisions-empty' }}>
          No material decisions were made for this build.
        </p>
      )}
      {!isLoading && !isError && decisions && decisions.length > 0 && (
        <ul className={styles.list} aria-label="Risk decisions">
          {decisions.map((decision) => (
            <li key={decision.id} className={styles.item} {...{ 'data-testid': `build-risk-decision-${decision.id}` }}>
              <div className={styles.meta}>
                <span className={styles.id}>{decision.id}</span>
                <span>{categoryLabel(decision.category)}</span>
                <span
                  className={`${styles.rating} ${styles[decision.rating]}`}
                  {...{ 'data-testid': `build-risk-decision-rating-${decision.id}` }}
                >
                  {ratingLabel(decision.rating)}
                </span>
              </div>
              <p className={styles.decision}>{decision.decision}</p>
              <p className={styles.rationale}>{decision.rationale}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
