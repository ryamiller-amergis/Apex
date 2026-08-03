import React from 'react';
import styles from './WhatsNewIndicator.module.css';

export interface WhatsNewIndicatorProps {
  unread: boolean;
  /** Placement decides data-testid and optional announcement. */
  placement: 'avatar' | 'menu';
  /** When true, renders visually-hidden polite live region once. */
  announce?: boolean;
}

/**
 * Binary What's New marker for avatar badge and menu-row placements (FEAT-006).
 * Hidden until unread is true; decorative dots are aria-hidden.
 */
export const WhatsNewIndicator: React.FC<WhatsNewIndicatorProps> = ({
  unread,
  placement,
  announce = false,
}) => {
  if (!unread) return null;

  const testId =
    placement === 'avatar' ? 'whats-new-avatar-indicator' : 'whats-new-menu-indicator';

  return (
    <>
      {announce && (
        <span className={styles.srOnly} aria-live="polite">
          A new Apex release is available
        </span>
      )}
      <span
        className={placement === 'avatar' ? styles.avatarDot : styles.menuMarker}
        data-testid={testId}
        aria-hidden="true"
      />
    </>
  );
};
