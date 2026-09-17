import React from 'react';
import styles from './PhaseContextBadge.module.css';

interface PhaseContextBadgeProps {
  className?: string;
  'data-testid'?: string;
}

export const PhaseContextBadge: React.FC<PhaseContextBadgeProps> = ({
  className,
  'data-testid': testId = 'interview-phase-badge',
}) => (
  <span
    className={`${styles.badge} ${className ?? ''}`.trim()}
    role="status"
    {...{ 'data-testid': testId }}
  >
    Requirements Phase
  </span>
);
