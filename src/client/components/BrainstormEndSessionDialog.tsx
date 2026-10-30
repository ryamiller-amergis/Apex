import React, { useEffect, useRef } from 'react';
import styles from './BrainstormSourcesPanel.module.css';

interface BrainstormEndSessionDialogProps {
  open: boolean;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export const BrainstormEndSessionDialog: React.FC<BrainstormEndSessionDialogProps> = ({
  open,
  pending,
  error,
  onCancel,
  onConfirm,
}) => {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);
  if (!open) return null;
  return (
    <div className={styles.backdrop}>
      <button type="button" className={styles.backdropButton} aria-label="Close end session" onClick={onCancel} {...{ 'data-testid': 'brainstorm-end-session-backdrop' }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="brainstorm-end-title"
        className={styles.dialog}
        {...{ 'data-testid': 'brainstorm-end-session-dialog' }}
      >
        <h2 id="brainstorm-end-title">End this session?</h2>
        <p>Clones are deleted now. The chat, artifact and citations stay readable.</p>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}>
          <button type="button" className={styles.button} onClick={onCancel} {...{ 'data-testid': 'brainstorm-end-session-cancel' }}>Cancel</button>
          <button
            ref={confirmRef}
            type="button"
            className={`${styles.confirm} ${styles.primary}`}
            disabled={pending}
            onClick={onConfirm}
            {...{ 'data-testid': 'brainstorm-end-session-confirm' }}
          >
            End session
          </button>
        </div>
      </div>
    </div>
  );
};
