import React, { useCallback, useState, useEffect } from 'react';
import { useExportSession } from '../hooks/useExportSession';
import styles from './ExportSelectedButton.module.css';

interface ExportSelectedButtonProps {
  sessionId: string;
  selectedCount: number;
  selectedPageIndices: number[];
  onExportComplete?: () => void;
}

export const ExportSelectedButton: React.FC<ExportSelectedButtonProps> = ({
  sessionId,
  selectedCount,
  selectedPageIndices,
  onExportComplete,
}) => {
  const exportMutation = useExportSession();
  const isExporting = exportMutation.isPending;
  const isDisabled = selectedCount === 0 || isExporting;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (exportMutation.isSuccess) {
      setError(null);
      onExportComplete?.();
    }
  }, [exportMutation.isSuccess, onExportComplete]);

  useEffect(() => {
    if (exportMutation.isError) {
      setError(exportMutation.error?.message ?? 'Export failed. Please retry.');
    }
  }, [exportMutation.isError, exportMutation.error]);

  const handleClick = useCallback(() => {
    if (isDisabled) return;
    setError(null);
    const sortedPages = [...selectedPageIndices].sort((a, b) => a - b);
    exportMutation.mutate({ sessionId, pages: sortedPages });
  }, [isDisabled, exportMutation, sessionId, selectedPageIndices]);

  return (
    <>
      <button
        className={styles.button}
        onClick={handleClick}
        disabled={isDisabled}
        aria-busy={isExporting}
        aria-label={
          isExporting
            ? 'Exporting selected pages'
            : selectedCount > 0
              ? `Export ${selectedCount} selected ${selectedCount === 1 ? 'page' : 'pages'}`
              : 'Select pages to export'
        }
        title={selectedCount === 0 ? 'Select pages to export' : undefined}
        data-testid="pdf-export-selected-btn"
      >
        {isExporting ? (
          <>
            <span className={styles.spinner} />
            Exporting…
          </>
        ) : (
          <>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Export Selected
            {selectedCount > 0 && (
              <span className={styles.badge} data-testid="pdf-selection-count">
                {selectedCount}
              </span>
            )}
          </>
        )}
      </button>

      {error && (
        <div className={styles.errorToast} role="alert" data-testid="pdf-export-selected-error">
          <span>{error}</span>
          <button
            className={styles.retryBtn}
            onClick={handleClick}
            aria-label="Retry export"
          >
            Retry
          </button>
          <button
            className={styles.dismissBtn}
            onClick={() => setError(null)}
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}

      <div aria-live="polite" className="sr-only">
        {isExporting ? 'Export started' : ''}
        {exportMutation.isSuccess ? 'Export complete' : ''}
        {error ? 'Export failed' : ''}
      </div>
    </>
  );
};
