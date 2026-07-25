import React, { useEffect, useRef } from 'react';
import styles from './ConfirmRegenerateScriptModal.module.css';

interface ConfirmRegenerateScriptModalProps {
  isPending?: boolean;
  /** Overridable copy so this modal can be reused for other overwrite-confirmation flows (e.g. AI generate — BR-010). */
  title?: string;
  body?: string;
  warning?: string;
  confirmLabel?: string;
  pendingLabel?: string;
  testId?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmRegenerateScriptModal: React.FC<ConfirmRegenerateScriptModalProps> = ({
  isPending = false,
  title = 'Regenerate script from guided form?',
  body = 'You edited the raw k6 script. Re-applying the guided form will overwrite those changes.',
  warning = 'This cannot be undone.',
  confirmLabel = 'Overwrite script',
  pendingLabel = 'Regenerating…',
  testId = 'confirm-regenerate-script-modal',
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
      data-testid={testId}
    >
      <div className={styles.card}>
        <h2 className={styles.title} id="confirm-regenerate-title">
          {title}
        </h2>
        <p className={styles.body}>{body}</p>
        <p className={styles.warning}>{warning}</p>
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
            {isPending ? pendingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmRegenerateScriptModal;
