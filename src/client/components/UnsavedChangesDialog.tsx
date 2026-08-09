import React, { useEffect, useRef } from 'react';
import styles from './DiagramDialog.module.css';

interface UnsavedChangesDialogProps {
  onStay: () => void;
  onDiscard: () => void;
  'data-testid'?: string;
}

export const UnsavedChangesDialog: React.FC<UnsavedChangesDialogProps> = ({
  onStay,
  onDiscard,
  'data-testid': testId = 'diagram-unsaved-dialog',
}) => {
  const stayRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    stayRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onStay();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onStay]);

  return (
    <div
      className={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onStay();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="diagram-unsaved-title"
      {...{ 'data-testid': testId }}
    >
      <div className={styles.card}>
        <h2 className={styles.title} id="diagram-unsaved-title">
          Unsaved changes
        </h2>
        <p className={styles.body}>
          You have unsaved Diagram changes. Leave without saving, or stay and keep editing?
        </p>
        <div className={styles.actions}>
          <button
            ref={stayRef}
            type="button"
            className={styles.btnSecondary}
            onClick={onStay}
            {...{ 'data-testid': 'diagram-unsaved-stay' }}
          >
            Keep editing
          </button>
          <button
            type="button"
            className={styles.btnDanger}
            onClick={onDiscard}
            {...{ 'data-testid': 'diagram-unsaved-discard' }}
          >
            Discard changes
          </button>
        </div>
      </div>
    </div>
  );
};

export default UnsavedChangesDialog;
