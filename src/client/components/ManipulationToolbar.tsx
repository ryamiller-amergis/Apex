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
  onSave?: () => void;
  hasUnsavedChanges?: boolean;
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
}

export const ManipulationToolbar: React.FC<ManipulationToolbarProps> = ({
  selectedCount,
  onRotate,
  onDelete,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  onSave,
  hasUnsavedChanges = false,
  totalPages,
  onSelectAll,
  onDeselectAll,
}) => {
  const hasSelection = selectedCount > 0;
  const isSingleSelection = selectedCount === 1;
  const allSelected = totalPages > 0 && selectedCount === totalPages;

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Page manipulation tools">
      <div className={styles.actions}>
        <button
          className={styles.button}
          data-testid="toolbar-select-all"
          onClick={allSelected ? onDeselectAll : onSelectAll}
          title={allSelected ? 'Deselect All' : 'Select All'}
        >
          <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {allSelected ? (
              <>
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 12l2 2 4-4" />
              </>
            ) : (
              <rect x="3" y="3" width="18" height="18" rx="2" />
            )}
          </svg>
          <span className={styles.label}>{allSelected ? 'Deselect All' : 'Select All'}</span>
        </button>

        <button
          className={styles.button}
          data-testid="toolbar-rotate"
          disabled={!hasSelection}
          onClick={onRotate}
          title="Rotate 90°"
        >
          <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.5 2v6h-6" />
            <path d="M21.34 15.57a10 10 0 1 1-.57-8.38" />
          </svg>
          <span className={styles.label}>Rotate</span>
        </button>

        <button
          className={styles.button}
          data-testid="toolbar-delete"
          disabled={!hasSelection}
          onClick={onDelete}
          title="Delete selected"
        >
          <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          </svg>
          <span className={styles.label}>Delete</span>
        </button>

        <div className={styles.separator} />

        <button
          className={styles.button}
          data-testid="toolbar-move-up"
          disabled={!isSingleSelection || !canMoveUp}
          onClick={onMoveUp}
          title="Move up"
        >
          <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="18 15 12 9 6 15" />
          </svg>
          <span className={styles.label}>Up</span>
        </button>

        <button
          className={styles.button}
          data-testid="toolbar-move-down"
          disabled={!isSingleSelection || !canMoveDown}
          onClick={onMoveDown}
          title="Move down"
        >
          <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
          <span className={styles.label}>Down</span>
        </button>

        {onSave && (
          <>
            <div className={styles.separator} />
            <button
              className={`${styles.button} ${hasUnsavedChanges ? styles.saveActive : ''}`}
              data-testid="toolbar-save"
              disabled={!hasUnsavedChanges}
              onClick={onSave}
              title="Save changes"
            >
              <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
              <span className={styles.label}>Save</span>
            </button>
          </>
        )}
      </div>

      <div className={styles.spacer} />

      <div className={styles.infoSection}>
        {hasSelection && (
          <span className={styles.selectionInfo}>
            {selectedCount} {selectedCount === 1 ? 'page' : 'pages'} selected
          </span>
        )}
        <span className={styles.pageCount}>
          {totalPages} {totalPages === 1 ? 'page' : 'pages'} in assembly
        </span>
      </div>
    </div>
  );
};
