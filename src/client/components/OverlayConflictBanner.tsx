import React from 'react';
import styles from './OverlayConflictBanner.module.css';

interface OverlayConflictBannerProps {
  visible: boolean;
  isReloading: boolean;
  errorMessage: string | null;
  onAcknowledge: () => void;
  onRetry: () => void;
}

export const OverlayConflictBanner: React.FC<
  OverlayConflictBannerProps
> = ({
  visible,
  isReloading,
  errorMessage,
  onAcknowledge,
  onRetry,
}) => {
  if (!visible && !isReloading) return null;

  return (
    <div
      className={`${styles.banner} ${errorMessage ? styles.error : ''}`}
      role={errorMessage ? 'alert' : 'status'}
      aria-live={errorMessage ? 'assertive' : 'polite'}
      data-testid="pdf-tools-overlay-conflict-banner"
    >
      <div className={styles.message}>
        <span className={styles.icon} aria-hidden="true">
          {errorMessage ? '⚠' : '↻'}
        </span>
        <span>
          {isReloading
            ? 'Updating text overlays from another tab…'
            : errorMessage
              ? `Another tab updated text overlays, but the latest version could not be loaded. ${errorMessage}`
              : 'Another tab updated text overlays. This page now shows the current saved version.'}
        </span>
      </div>
      <div className={styles.actions}>
        {errorMessage ? (
          <button
            type="button"
            className={styles.button}
            onClick={onRetry}
            disabled={isReloading}
            data-testid="pdf-tools-overlay-conflict-retry"
          >
            Retry
          </button>
        ) : (
          <button
            type="button"
            className={styles.button}
            onClick={onAcknowledge}
            disabled={isReloading}
            data-testid="pdf-tools-overlay-conflict-acknowledge"
          >
            Acknowledge
          </button>
        )}
      </div>
    </div>
  );
};
