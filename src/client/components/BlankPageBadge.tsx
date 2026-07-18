import React, { useState, useCallback } from 'react';
import styles from './BlankPageBadge.module.css';

export interface BlankPageBadgeProps {
  isBlank: boolean;
  pageIndex: number;
}

export const BlankPageBadge: React.FC<BlankPageBadgeProps> = ({ isBlank, pageIndex }) => {
  const [showTooltip, setShowTooltip] = useState(false);

  const handleShowTooltip = useCallback(() => setShowTooltip(true), []);
  const handleHideTooltip = useCallback(() => setShowTooltip(false), []);

  if (!isBlank) return null;

  const tooltipId = `blank-page-tooltip-${pageIndex}`;

  return (
    <button
      type="button"
      className={styles.badge}
      data-testid={`blank-page-badge-${pageIndex}`}
      aria-label="Likely blank page"
      aria-describedby={showTooltip ? tooltipId : undefined}
      onMouseEnter={handleShowTooltip}
      onMouseLeave={handleHideTooltip}
      onFocus={handleShowTooltip}
      onBlur={handleHideTooltip}
    >
      Likely blank
      {showTooltip && (
        <span
          id={tooltipId}
          className={styles.tooltip}
          data-testid={tooltipId}
          role="tooltip"
        >
          This page appears to be blank. You may want to delete it before export.
        </span>
      )}
    </button>
  );
};
