import React from 'react';
import styles from './ManipulationToolbar.module.css';

interface ManipulationToolbarProps {
  selectedCount: number;
  onRotate: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  totalPages: number;
}

export const ManipulationToolbar: React.FC<ManipulationToolbarProps> = ({
  selectedCount,
  onRotate,
  onDelete,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
}) => {
  const hasSelection = selectedCount > 0;
  const isSingleSelection = selectedCount === 1;

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Page manipulation tools">
      <div className={styles.toolbarGroup}>
        <button
          className={styles.toolbarButton}
          onClick={onRotate}
          disabled={!hasSelection}
          aria-label="Rotate selected pages 90° clockwise"
          title={hasSelection ? 'Rotate 90° clockwise' : 'Select pages to rotate'}
          data-testid="toolbar-rotate"
        >
          <span className={styles.buttonIcon}>↻</span>
          <span className={styles.buttonLabel}>Rotate</span>
        </button>

        <button
          className={`${styles.toolbarButton} ${styles.deleteButton}`}
          onClick={onDelete}
          disabled={!hasSelection}
          aria-label="Delete selected pages"
          title={hasSelection ? `Delete ${selectedCount} page(s)` : 'Select pages to delete'}
          data-testid="toolbar-delete"
        >
          <span className={styles.buttonIcon}>🗑</span>
          <span className={styles.buttonLabel}>Delete</span>
        </button>
      </div>

      <div className={styles.toolbarGroup}>
        <button
          className={styles.toolbarButton}
          onClick={onMoveUp}
          disabled={!isSingleSelection || !canMoveUp}
          aria-label="Move selected page up"
          title="Move page up"
          data-testid="toolbar-move-up"
        >
          <span className={styles.buttonIcon}>↑</span>
          <span className={styles.buttonLabel}>Move Up</span>
        </button>

        <button
          className={styles.toolbarButton}
          onClick={onMoveDown}
          disabled={!isSingleSelection || !canMoveDown}
          aria-label="Move selected page down"
          title="Move page down"
          data-testid="toolbar-move-down"
        >
          <span className={styles.buttonIcon}>↓</span>
          <span className={styles.buttonLabel}>Move Down</span>
        </button>
      </div>

      {hasSelection && (
        <span className={styles.selectionInfo} aria-live="polite">
          {selectedCount} page{selectedCount !== 1 ? 's' : ''} selected
        </span>
      )}
    </div>
  );
};
