import React from 'react';
import type { ConnectionState } from '../../chatHarness/types';
import styles from './agentChat.module.css';

export interface AgentConnectionBannerProps {
  connectionState: ConnectionState;
  onSignIn?: () => void;
  testIdPrefix?: string;
  testId?: string;
  className?: string;
}

export const AgentConnectionBanner: React.FC<AgentConnectionBannerProps> = ({
  connectionState,
  onSignIn,
  testIdPrefix,
  testId,
  className,
}) => {
  if (
    connectionState === 'open' ||
    connectionState === 'connecting' ||
    connectionState === 'closed'
  ) {
    return null;
  }

  const bannerTestId = testId
    ?? (testIdPrefix ? `${testIdPrefix}-connection-banner` : 'agent-connection-banner');

  const handleSignIn = () => {
    if (onSignIn) {
      onSignIn();
    } else {
      window.location.reload();
    }
  };

  if (connectionState === 'signed-out') {
    return (
      <div
        className={`${styles.connectionBanner} ${styles.connectionBannerSignedOut} ${className ?? ''}`}
        role="alert"
        {...{ 'data-testid': bannerTestId }}
      >
        <span>Your session expired. Sign in again to continue.</span>
        <button
          type="button"
          className={styles.connectionSignInBtn}
          onClick={handleSignIn}
          {...{ 'data-testid': `${bannerTestId}-signin` }}
        >
          Sign in
        </button>
      </div>
    );
  }

  if (connectionState === 'reconnecting') {
    return (
      <div
        className={`${styles.connectionBanner} ${styles.connectionBannerReconnecting} ${className ?? ''}`}
        role="status"
        aria-live="polite"
        {...{ 'data-testid': bannerTestId }}
      >
        <span className={styles.activitySpinner} aria-hidden="true" />
        <span>Reconnecting…</span>
      </div>
    );
  }

  if (connectionState === 'restored') {
    return (
      <div
        className={`${styles.connectionBanner} ${styles.connectionBannerRestored} ${className ?? ''}`}
        role="status"
        aria-live="polite"
        {...{ 'data-testid': bannerTestId }}
      >
        <span>Restored</span>
      </div>
    );
  }

  return (
    <div
      className={`${styles.connectionBanner} ${styles.connectionBannerUnavailable} ${className ?? ''}`}
      role="status"
      aria-live="polite"
      {...{ 'data-testid': bannerTestId }}
    >
      <span>Live updates are unavailable. You can still read this thread.</span>
    </div>
  );
};
