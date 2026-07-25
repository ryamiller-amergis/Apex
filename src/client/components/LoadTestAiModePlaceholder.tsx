import React from 'react';
import styles from './LoadTestAiModePlaceholder.module.css';

export const LoadTestAiModePlaceholder: React.FC = () => {
  return (
    <div className={styles.panel} data-testid="load-test-ai-placeholder">
      <h3 className={styles.title}>AI generate (coming soon)</h3>
      <p className={styles.body}>
        Connect a repo and use AI generate when available. Until then, author with Guided form or Raw
        script modes.
      </p>
    </div>
  );
};

export default LoadTestAiModePlaceholder;
