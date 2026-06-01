import React, { useEffect } from 'react';
import { FallbackProps } from 'react-error-boundary';
import { trackException } from '../services/telemetry';
import styles from './ViewErrorFallback.module.css';

export const ViewErrorFallback: React.FC<FallbackProps> = ({ error, resetErrorBoundary }) => {
  useEffect(() => {
    trackException(error instanceof Error ? error : new Error(String(error)), {
      component: 'ViewErrorFallback',
    });
  }, [error]);

  return (
    <div className={styles['view-error-fallback']} role="alert">
      <div className={styles['view-error-content']}>
        <h2 className={styles['view-error-title']}>Something went wrong</h2>
        <p className={styles['view-error-message']}>{(error as Error)?.message || 'An unexpected error occurred in this view.'}</p>
        <button className={styles['view-error-retry-btn']} onClick={resetErrorBoundary}>
          Try again
        </button>
      </div>
    </div>
  );
};
