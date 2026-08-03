import React, { useEffect, useRef } from 'react';
import styles from './ReGroundConfirmDialog.module.css';

interface ReGroundConfirmDialogProps {
  'data-testid'?: string;
  triggerRef: React.RefObject<HTMLButtonElement>;
  isPending: boolean;
  error: Error | null;
  onConfirm: () => void;
  onClose: () => void;
}

export const ReGroundConfirmDialog: React.FC<ReGroundConfirmDialogProps> = ({
  triggerRef,
  isPending,
  error,
  onConfirm,
  onClose,
}) => {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const trigger = triggerRef.current;
    return () => trigger?.focus();
  }, [triggerRef]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && !isPending) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const first = cancelRef.current;
    const last = confirmRef.current;
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-labelledby="reground-dialog-title"
      {...{ 'data-testid': 'run-grounding-reground-dialog' }}
    >
      <section className={styles.dialog}>
        <h2 id="reground-dialog-title">Re-ground this run?</h2>
        <p>
          This creates a new dated pin at the current cached origin tip. It does
          not change completed upstream runs.
        </p>
        {error ? (
          <p className={styles.error} role="alert">
            {error.message}
          </p>
        ) : null}
        <div className={styles.actions}>
          <button
            ref={cancelRef}
            type="button"
            className={styles.secondary}
            disabled={isPending}
            onClick={onClose}
            onKeyDown={handleKeyDown}
            {...{ 'data-testid': 'run-grounding-reground-cancel' }}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={styles.primary}
            disabled={isPending}
            onClick={onConfirm}
            onKeyDown={handleKeyDown}
            {...{ 'data-testid': 'run-grounding-reground-confirm' }}
          >
            {isPending ? 'Re-grounding…' : 'Confirm re-ground'}
          </button>
        </div>
      </section>
    </div>
  );
};
