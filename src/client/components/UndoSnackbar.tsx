import React from 'react';
import styles from './UndoSnackbar.module.css';

interface UndoSnackbarProps {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
}

export const UndoSnackbar: React.FC<UndoSnackbarProps> = ({
  message,
  onUndo,
  onDismiss,
}) => {
  return (
    <div
      className={styles.snackbar}
      data-testid="undo-snackbar"
      role="alert"
      aria-live="assertive"
    >
      <span className={styles.message}>{message}</span>
      <button
        className={styles.undoButton}
        data-testid="undo-snackbar-action"
        onClick={onUndo}
      >
        Undo
      </button>
      <button
        className={styles.dismissButton}
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
};
