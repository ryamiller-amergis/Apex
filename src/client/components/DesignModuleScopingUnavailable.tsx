import React from 'react';
import styles from './DesignModuleScopingUnavailable.module.css';

export const DesignModuleScopingUnavailable: React.FC = () => {
  return (
    <div
      className={styles.panel}
      {...{ 'data-testid': 'design-module-scoping-unavailable' }}
      role="status"
    >
      <h3 className={styles.title}>AI scoping unavailable</h3>
      <p className={styles.body}>
        This project has no connected repository for AI source scoping. Connect a
        repo in Project Settings, then come back here — or add source globs
        manually in the meantime.
      </p>
    </div>
  );
};

export default DesignModuleScopingUnavailable;
