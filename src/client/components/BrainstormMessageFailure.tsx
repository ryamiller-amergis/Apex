import React from 'react';
import { BRAINSTORM_FAILURE_SUMMARIES, type BrainstormMessageDto } from '../../shared/types/brainstorm';
import styles from './BrainstormMessageFailure.module.css';

interface BrainstormMessageFailureProps {
  message: BrainstormMessageDto;
  /** True only for the creator on the latest failed collaborator message. */
  canRetry: boolean;
  isRetrying: boolean;
  onRetry: () => void;
}

export const BrainstormMessageFailure: React.FC<BrainstormMessageFailureProps> = ({
  message,
  canRetry,
  isRetrying,
  onRetry,
}) => {
  const summary = message.failureSummary
    ?? BRAINSTORM_FAILURE_SUMMARIES[message.failureCode ?? 'unknown'];
  return (
    <div className={styles.failure} role="alert">
      <span className={styles.badge} {...{ 'data-testid': 'brainstorm-message-failed' }}>
        {message.status === 'cancelled' ? 'Stopped' : 'Failed'}
      </span>
      <span className={styles.summary}>{summary}</span>
      {canRetry && (
        <button
          type="button"
          className={styles.retry}
          onClick={onRetry}
          disabled={isRetrying}
          aria-disabled={isRetrying || undefined}
          aria-label={`Retry the response from ${new Date(message.createdAt).toLocaleTimeString()}`}
          {...{ 'data-testid': 'brainstorm-retry' }}
        >
          {isRetrying ? 'Retrying…' : 'Retry'}
        </button>
      )}
    </div>
  );
};
