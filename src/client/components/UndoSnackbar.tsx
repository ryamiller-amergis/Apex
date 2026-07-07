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
      role="alert"
      aria-live="assertive"
      data-testid="undo-snackbar"
    >
      <span className={styles.message}>{message}</span>
      <button
        className={styles.undoButton}
        onClick={onUndo}
        data-testid="undo-snackbar-action"
      >
        Undo
      </button>
      <button
        className={styles.dismissButton}
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
};
