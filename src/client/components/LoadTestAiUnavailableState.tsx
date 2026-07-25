import React from 'react';
import styles from './LoadTestAiUnavailableState.module.css';

/**
 * FEAT-011 / PBI-014 AC-2 — shown when the project has no connected repo
 * (skillRepo unset on every ProjectRepoConfigSummary). Greys out AI generate
 * and points the author at the Guided form / Raw script modes instead.
 */
export const LoadTestAiUnavailableState: React.FC = () => {
  return (
    <div className={styles.panel} data-testid="load-test-ai-unavailable" role="status">
      <h3 className={styles.title}>AI generate unavailable</h3>
      <p className={styles.body}>
        This project has no connected repository for AI script generation. Connect a repo in Project
        Settings, then come back here — or continue authoring with the Guided form or Raw script
        modes in the meantime.
      </p>
    </div>
  );
};

export default LoadTestAiUnavailableState;
