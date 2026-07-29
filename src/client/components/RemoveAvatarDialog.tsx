/**
 * FEAT-002 / PBI-004 — Confirms irreversible avatar removal. Patterned after
 * ConfirmDeleteModal: focus moves to Cancel on open, Escape cancels and
 * restores focus, and the dialog stays open with an honest inline error on
 * failure rather than reporting a false success.
 */
import React, { useEffect, useRef } from 'react';
import styles from './AvatarEditor.module.css';

interface RemoveAvatarDialogProps {
  isPending?: boolean;
  errorMessage?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export const RemoveAvatarDialog: React.FC<RemoveAvatarDialogProps> = ({
  isPending = false,
  errorMessage = null,
  onConfirm,
  onCancel,
}) => {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      previouslyFocused.current?.focus();
    };
  }, [onCancel]);

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="avatar-remove-dialog-title"
      data-testid="avatar-remove-dialog"
    >
      <div className={styles.dialog}>
        <h2 id="avatar-remove-dialog-title" className={styles.dialogTitle}>
          Remove avatar
        </h2>
        <p className={styles.dialogBody}>
          Your uploaded avatar will be removed. Your Azure AD photo or initials will display
          instead. This action cannot be undone.
        </p>

        {errorMessage && (
          <p className={styles.dialogError} role="alert">
            {errorMessage}
          </p>
        )}

        <div className={styles.dialogActions}>
          <button
            ref={cancelRef}
            type="button"
            className={styles.btnCancel}
            onClick={onCancel}
            disabled={isPending}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="avatar-remove-confirm"
            className={styles.btnDelete}
            onClick={onConfirm}
            disabled={isPending}
          >
            {isPending ? 'Removing…' : 'Remove avatar'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RemoveAvatarDialog;
