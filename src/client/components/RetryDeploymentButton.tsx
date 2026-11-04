import React, { useState, useRef, useCallback } from 'react';
import styles from './BuildPreviewTab.module.css';

export interface RetryDeploymentButtonProps {
  onRetry: () => Promise<unknown>;
}

export const RetryDeploymentButton: React.FC<RetryDeploymentButtonProps> = ({ onRetry }) => {
  const [isPending, setIsPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const handleClick = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsPending(true);
    setErrorMessage(null);
    try {
      await onRetry();
    } catch (err) {
      const detail = err instanceof Error && err.message ? ` ${err.message}` : '';
      setErrorMessage(`We could not queue the retry. Try again.${detail}`);
    } finally {
      inFlightRef.current = false;
      setIsPending(false);
    }
  }, [onRetry]);

  return (
    <div className={styles.retryAction}>
      <button
        type="button"
        className={styles.retryButton}
        disabled={isPending}
        aria-disabled={isPending}
        onClick={() => {
          void handleClick();
        }}
        {...{ 'data-testid': 'build-retry-deployment-button' }}
      >
        {isPending ? 'Queuing…' : 'Retry deployment'}
      </button>
      {errorMessage && (
        <p role="alert" className={styles.errorText}>
          {errorMessage}
        </p>
      )}
    </div>
  );
};
