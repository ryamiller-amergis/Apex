import React, { useEffect, useRef } from 'react';
import styles from './ConfirmRegenerateScriptModal.module.css';

interface ConfirmRegenerateScriptModalProps {
  isPending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmRegenerateScriptModal: React.FC<ConfirmRegenerateScriptModalProps> = ({
  isPending = false,
  onConfirm,
  onCancel,
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
    // Backdrop click-to-dismiss mirrors ConfirmDeleteModal; Escape is handled in useEffect.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events -- dialog overlay dismiss pattern
    <div
      className={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-regenerate-title"
      data-testid="confirm-regenerate-script-modal"
    >
      <div className={styles.card}>
        <h2 className={styles.title} id="confirm-regenerate-title">
          Regenerate script from guided form?
        </h2>
        <p className={styles.body}>
          You edited the raw k6 script. Re-applying the guided form will overwrite those changes.
        </p>
        <p className={styles.warning}>This cannot be undone.</p>
        <div className={styles.actions}>
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
            className={styles.btnConfirm}
            onClick={onConfirm}
            disabled={isPending}
          >
            {isPending ? 'Regenerating…' : 'Overwrite script'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmRegenerateScriptModal;
