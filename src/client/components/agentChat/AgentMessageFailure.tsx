import React from 'react';
import styles from './agentChat.module.css';

export interface AgentMessageFailureTestIds {
  root?: string;
  badge?: string;
  retry?: string;
}

export interface AgentMessageFailureProps {
  reason: string;
  status?: 'failed' | 'cancelled';
  failedAt?: string;
  canRetry: boolean;
  isRetrying?: boolean;
  onRetry: () => void;
  testIdPrefix?: string;
  testIds?: AgentMessageFailureTestIds;
  className?: string;
}

export const AgentMessageFailure: React.FC<AgentMessageFailureProps> = ({
  reason,
  status = 'failed',
  failedAt,
  canRetry,
  isRetrying = false,
  onRetry,
  testIdPrefix,
  testIds,
  className,
}) => {
  const rootTestId = testIds?.root
    ?? (testIdPrefix ? `${testIdPrefix}-message-failure` : 'agent-message-failure');
  const badgeTestId = testIds?.badge
    ?? (testIdPrefix ? `${testIdPrefix}-message-failed` : 'agent-message-failed');
  const retryTestId = testIds?.retry
    ?? (testIdPrefix ? `${testIdPrefix}-retry` : 'agent-retry');

  const parsedTime = failedAt ? Date.parse(failedAt) : Number.NaN;
  const retryAriaLabel = Number.isFinite(parsedTime)
    ? `Retry the response from ${new Date(parsedTime).toLocaleTimeString()}`
    : 'Retry failed message';

  return (
    <div
      className={`${styles.messageFailure} ${className ?? ''}`}
      role="alert"
      {...{ 'data-testid': rootTestId }}
    >
      <span
        className={styles.messageFailureBadge}
        {...{ 'data-testid': badgeTestId }}
      >
        {status === 'cancelled' ? 'Stopped' : 'Failed'}
      </span>
      <span className={styles.messageFailureReason}>{reason}</span>
      {canRetry && (
        <button
          type="button"
          className={styles.messageFailureRetry}
          onClick={onRetry}
          disabled={isRetrying}
          aria-disabled={isRetrying || undefined}
          aria-label={retryAriaLabel}
          {...{ 'data-testid': retryTestId }}
        >
          {isRetrying ? 'Retrying…' : 'Retry'}
        </button>
      )}
    </div>
  );
};
