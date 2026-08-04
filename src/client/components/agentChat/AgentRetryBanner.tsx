import React from 'react';
import styles from './agentChat.module.css';

export interface AgentRetryBannerProps {
  /** Whether the server is retrying. */
  isRetrying: boolean;
  /** Human-readable reason (e.g. "Rate limited, retrying…"). */
  retryReason: string | null;
  /** Additional CSS class. */
  className?: string;
}

export const AgentRetryBanner: React.FC<AgentRetryBannerProps> = ({
  isRetrying,
  retryReason,
  className,
}) => {
  if (!isRetrying) return null;
  return (
    <div className={`${styles.retryBanner} ${className ?? ''}`} role="status" aria-live="polite">
      <span className={styles.retrySpinner} />
      <span className={styles.retryText}>{retryReason ?? 'Retrying…'}</span>
    </div>
  );
};
