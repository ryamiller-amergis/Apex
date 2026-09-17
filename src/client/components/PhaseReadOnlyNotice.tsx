import React from 'react';
import styles from './PhaseReadOnlyNotice.module.css';

interface PhaseReadOnlyNoticeProps {
  className?: string;
}

export const PhaseReadOnlyNotice: React.FC<PhaseReadOnlyNoticeProps> = ({ className }) => (
  <div
    className={`${styles.notice} ${className ?? ''}`.trim()}
    role="status"
    {...{ 'data-testid': 'interview-phase-readonly-notice' }}
  >
    <svg
      className={styles.icon}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="7" width="10" height="8" rx="1.5" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" />
    </svg>
    <span>You are not the owner of this phase and cannot send messages here.</span>
  </div>
);
