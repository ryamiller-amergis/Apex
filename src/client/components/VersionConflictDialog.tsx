import React, { useEffect, useRef } from 'react';
import styles from './DiagramDialog.module.css';

interface VersionConflictDialogProps {
  onReload: () => void;
  onDismiss: () => void;
  isReloading?: boolean;
  'data-testid'?: string;
}

export const VersionConflictDialog: React.FC<VersionConflictDialogProps> = ({
  onReload,
  onDismiss,
  isReloading = false,
  'data-testid': testId = 'diagram-conflict-dialog',
}) => {
  const reloadRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    reloadRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onDismiss]);

  return (
    <div
      className={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="diagram-conflict-title"
      {...{ 'data-testid': testId }}
    >
      <div className={styles.card}>
        <h2 className={styles.title} id="diagram-conflict-title">
          Newer version available
        </h2>
        <p className={styles.body}>
          Another editor saved a newer version of this Diagram. Reload to continue from the
          latest version. Your local unsaved scene was not overwritten.
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.btnSecondary}
            onClick={onDismiss}
            disabled={isReloading}
            {...{ 'data-testid': 'diagram-conflict-dismiss' }}
          >
            Keep local changes
          </button>
          <button
            ref={reloadRef}
            type="button"
            className={styles.btnPrimary}
            onClick={onReload}
            disabled={isReloading}
            {...{ 'data-testid': 'diagram-conflict-reload' }}
          >
            {isReloading ? 'Reloading…' : 'Reload'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default VersionConflictDialog;
