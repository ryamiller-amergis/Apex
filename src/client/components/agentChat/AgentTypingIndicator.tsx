import React from 'react';
import styles from './agentChat.module.css';

export interface AgentTypingIndicatorProps {
  /** Optional label text next to the dots. */
  label?: string;
  /** Additional CSS class. */
  className?: string;
}

export const AgentTypingIndicator: React.FC<AgentTypingIndicatorProps> = ({
  label,
  className,
}) => (
  <div className={`${styles.typingIndicator} ${className ?? ''}`} role="status" aria-live="polite">
    <div className={styles.typingDots}>
      <span className={styles.typingDot} />
      <span className={styles.typingDot} />
      <span className={styles.typingDot} />
    </div>
    {label && <span className={styles.typingLabel}>{label}</span>}
  </div>
);
