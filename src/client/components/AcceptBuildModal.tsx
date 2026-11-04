import React, { useEffect, useRef } from 'react';
import styles from './BuildAccept.module.css';

export interface AcceptBuildModalProps {
  open: boolean;
  revisionNumber: number;
  riskDecisionCount: number;
  isPending: boolean;
  errorMessage: string | null;
  isStaleRevision: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onReload?: () => void;
}

export const AcceptBuildModal: React.FC<AcceptBuildModalProps> = ({
  open,
  revisionNumber,
  riskDecisionCount,
  isPending,
  errorMessage,
  isStaleRevision,
  onConfirm,
  onCancel,
  onReload,
}) => {
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open) {
      cancelBtnRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="build-accept-modal-title"
      className={styles.backdrop}
      {...{ 'data-testid': 'build-accept-modal' }}
    >
      <div className={styles.modal}>
        <h2 id="build-accept-modal-title" className={styles.title}>
          {`Accept revision ${revisionNumber}?`}
        </h2>
        <p className={styles.description}>
          {`Apex will open a pull request for engineers to review with ${riskDecisionCount} risk decision${riskDecisionCount === 1 ? '' : 's'} listed. You will not be able to ask for more changes afterwards.`}
        </p>

        {errorMessage && (
          <div
            role="alert"
            className={styles.errorBox}
            {...{ 'data-testid': 'build-accept-error' }}
          >
            <span>{errorMessage}</span>
            {isStaleRevision && onReload && (
              <button
                type="button"
                className={styles.reloadButton}
                onClick={onReload}
                {...{ 'data-testid': 'build-accept-reload-btn' }}
              >
                Reload
              </button>
            )}
          </div>
        )}

        <div className={styles.actions}>
          <button
            ref={cancelBtnRef}
            type="button"
            className={styles.cancelButton}
            onClick={onCancel}
            {...{ 'data-testid': 'build-accept-cancel-btn' }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isPending}
            className={styles.confirmButton}
            onClick={onConfirm}
            {...{ 'data-testid': 'build-accept-confirm-btn' }}
          >
            {isPending ? 'Accepting…' : 'Confirm accept'}
          </button>
        </div>
      </div>
    </div>
  );
};
