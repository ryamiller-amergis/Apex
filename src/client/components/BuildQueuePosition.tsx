import React from 'react';
import styles from './BuildPreviewTab.module.css';

export interface BuildQueuePositionProps {
  queuePosition: number | null;
}

export const BuildQueuePosition: React.FC<BuildQueuePositionProps> = ({ queuePosition }) => {
  if (queuePosition === null || queuePosition < 1) return null;

  return (
    <div
      className={styles.queuePosition}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      {...{ 'data-testid': 'build-queue-position' }}
    >
      {`Waiting for the preview environment. You are number ${queuePosition} in line.`}
    </div>
  );
};
