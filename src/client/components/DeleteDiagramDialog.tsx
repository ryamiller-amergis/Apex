import React, { useEffect, useId, useRef } from 'react';
import styles from './DiagramDialog.module.css';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DeleteDiagramDialogProps {
  title: string;
  isPending?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  'data-testid'?: string;
}

export const DeleteDiagramDialog: React.FC<DeleteDiagramDialogProps> = ({
  title,
  isPending = false,
  error = null,
  onConfirm,
  onCancel,
  'data-testid': testId = 'diagram-delete-dialog',
}) => {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }

      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;

      const focusable = dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  return (
    <div
      className={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isPending) onCancel();
      }}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      {...{ 'data-testid': testId }}
    >
      <div className={styles.card} ref={dialogRef}>
        <h2 className={styles.title} id={titleId}>
          Delete &ldquo;{title}&rdquo;?
        </h2>
        <p className={styles.body}>
          This permanently deletes the Diagram and all share grants. This action cannot be undone.
        </p>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <button
            ref={cancelRef}
            type="button"
            className={styles.btnSecondary}
            onClick={onCancel}
            disabled={isPending}
            {...{ 'data-testid': 'diagram-delete-cancel' }}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.btnDanger}
            onClick={onConfirm}
            disabled={isPending}
            {...{ 'data-testid': 'diagram-delete-confirm' }}
          >
            {isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeleteDiagramDialog;
