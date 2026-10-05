import React, { useEffect, useRef } from 'react';
import styles from './ConfirmDeleteModal.module.css';

interface ConfirmDeleteModalProps {
  title: string;
  itemName: string;
  description?: string;
  isPending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  'data-testid'?: string;
}

export const ConfirmDeleteModal: React.FC<ConfirmDeleteModalProps> = ({
  title,
  itemName,
  description,
  isPending = false,
  onConfirm,
  onCancel,
  'data-testid': testId,
}) => {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  return (
    <div
      className={styles.overlay}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-delete-title"
      {...(testId ? { 'data-testid': testId } : {})}
    >
      <div className={styles.card}>
        <div className={styles.iconWrap} aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          </svg>
        </div>

        <h2 className={styles.title} id="confirm-delete-title">{title}</h2>

        <p className={styles.body}>
          {description ?? 'Are you sure you want to delete'}{' '}
          <span className={styles.itemName}>&ldquo;{itemName}&rdquo;</span>?
        </p>

        <p className={styles.warning}>This action cannot be undone.</p>

        <div className={styles.actions}>
          <button
            ref={cancelRef}
            className={styles.btnCancel}
            onClick={onCancel}
            disabled={isPending}
            type="button"
            {...{ 'data-testid': 'confirm-delete-cancel-btn' }}
          >
            Cancel
          </button>
          <button
            className={styles.btnDelete}
            onClick={onConfirm}
            disabled={isPending}
            type="button"
            {...{ 'data-testid': 'confirm-delete-confirm-btn' }}
          >
            {isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDeleteModal;
