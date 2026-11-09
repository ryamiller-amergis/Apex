import React from 'react';
import type { BuildClassification, BuildClassificationResult } from '../../shared/types/build';
import styles from './BuildClassificationSummary.module.css';

interface BuildClassificationSummaryProps {
  classification: BuildClassificationResult | null;
}

function classificationLabel(value: BuildClassification): string {
  switch (value) {
    case 'small':
      return 'Small build';
    case 'full':
      return 'Full build';
    default: {
      const unhandled: never = value;
      return unhandled;
    }
  }
}

export const BuildClassificationSummary: React.FC<BuildClassificationSummaryProps> = ({ classification }) => {
  return (
    <section className={styles.summary} {...{ 'data-testid': 'build-brief-classification' }}>
      <h3 className={styles.heading}>Classification</h3>
      {classification ? (
        <>
          <p className={styles.value}>{classificationLabel(classification.value)}</p>
          {classification.reasons.length > 0 && (
            <ul className={styles.reasons}>
              {classification.reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          )}
        </>
      ) : (
        <p className={styles.empty}>Classification not set yet.</p>
      )}
    </section>
  );
};
