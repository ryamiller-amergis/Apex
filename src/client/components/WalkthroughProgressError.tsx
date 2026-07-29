/**
 * FEAT-006 — Custom modal for failed completion/dismissal persistence (not window.alert).
 */
import React, { useEffect, useRef } from 'react';
import styles from './WalkthroughProgressError.module.css';

export interface WalkthroughProgressErrorProps {
  open: boolean;
  message?: string;
  submitting?: boolean;
  onRetry: () => void;
  onCloseWithoutAcknowledgement: () => void;
}

export const WalkthroughProgressError: React.FC<WalkthroughProgressErrorProps> = ({
  open,
  message = 'We could not save your progress. You can retry or close without acknowledging.',
  submitting = false,
  onRetry,
  onCloseWithoutAcknowledgement,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => {
      dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
    }, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseWithoutAcknowledgement();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open, onCloseWithoutAcknowledgement]);

  if (!open) return null;

  return (
    <div className={styles.backdrop} {...{ 'data-testid': 'walkthrough-progress-error' }}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="walkthrough-progress-error-title"
        {...{ 'data-testid': 'walkthrough-progress-error-dialog' }}
      >
        <h2 id="walkthrough-progress-error-title" className={styles.title}>
          Progress not saved
        </h2>
        <p className={styles.message} role="alert">
          {message}
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.retry}
            disabled={submitting}
            onClick={onRetry}
            {...{ 'data-testid': 'walkthrough-progress-retry' }}
          >
            {submitting ? 'Retrying…' : 'Retry'}
          </button>
          <button
            type="button"
            className={styles.close}
            disabled={submitting}
            onClick={onCloseWithoutAcknowledgement}
            {...{ 'data-testid': 'walkthrough-progress-close' }}
          >
            Close without acknowledging
          </button>
        </div>
      </div>
    </div>
  );
};
