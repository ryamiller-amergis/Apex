import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useExportSession } from '../hooks/useExportSession';
import styles from './ExportPanel.module.css';

interface ExportPanelProps {
  sessionId: string;
  nonDeletedPageCount: number;
  filenameOverride: string;
  automaticFilename: string;
  /** True when the field is still in automatic/recomputed mode. */
  isFilenameAutomatic?: boolean;
  onFilenameOverrideChange: (filename: string) => void;
  /** Called before export so callers can persist unsaved assembly changes. */
  onBeforeExport?: () => Promise<void>;
  /** Called after the export download has started successfully. */
  onExportComplete?: () => void;
}

export const ExportPanel: React.FC<ExportPanelProps> = ({
  sessionId,
  nonDeletedPageCount,
  filenameOverride,
  automaticFilename,
  isFilenameAutomatic = true,
  onFilenameOverrideChange,
  onBeforeExport,
  onExportComplete,
}) => {
  const [error, setError] = useState<string | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const hasReportedSuccessRef = useRef(false);

  const exportMutation = useExportSession();
  const isExporting = exportMutation.isPending || isPreparing;
  const isEmpty = nonDeletedPageCount === 0;

  useEffect(() => {
    if (!exportMutation.isSuccess) {
      hasReportedSuccessRef.current = false;
      return;
    }

    if (hasReportedSuccessRef.current) return;
    hasReportedSuccessRef.current = true;
    setError(null);
    onExportComplete?.();
  }, [exportMutation.isSuccess, onExportComplete]);

  useEffect(() => {
    if (exportMutation.isError) {
      setError(exportMutation.error?.message ?? 'Export failed. Please retry.');
    }
  }, [exportMutation.isError, exportMutation.error]);

  const runExport = useCallback(async () => {
    setError(null);
    setIsPreparing(true);
    try {
      await onBeforeExport?.();
      exportMutation.mutate({
        sessionId,
        ...(!isFilenameAutomatic && filenameOverride.trim()
          ? { filename: filenameOverride }
          : {}),
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to save assembly before export.'
      );
    } finally {
      setIsPreparing(false);
    }
  }, [
    onBeforeExport,
    exportMutation,
    filenameOverride,
    isFilenameAutomatic,
    sessionId,
  ]);

  const handleExport = useCallback(() => {
    void runExport();
  }, [runExport]);

  const handleRetry = useCallback(() => {
    void runExport();
  }, [runExport]);

  const handleDismissError = useCallback(() => {
    setError(null);
  }, []);

  return (
    <>
      <div className={styles.filenameGroup} data-testid="pdf-export-panel">
        <label htmlFor="pdf-export-filename" className={styles.filenameLabel}>
          Filename
        </label>
        <input
          id="pdf-export-filename"
          type="text"
          className={styles.filenameInput}
          value={isFilenameAutomatic ? automaticFilename : filenameOverride}
          placeholder={
            isFilenameAutomatic && !automaticFilename
              ? 'Server will choose a source-based PDF name'
              : undefined
          }
          onChange={(e) => onFilenameOverrideChange(e.target.value)}
          disabled={isExporting}
          data-testid="pdf-export-filename-input"
          data-filename-mode={isFilenameAutomatic ? 'automatic' : 'override'}
          aria-describedby={error ? 'pdf-export-error' : undefined}
        />
        <button
          className={styles.exportButton}
          onClick={handleExport}
          disabled={isEmpty || isExporting}
          aria-busy={isExporting}
          aria-label={isExporting ? 'Exporting document' : 'Export PDF'}
          title={isEmpty ? 'Add pages to export' : undefined}
          data-testid="pdf-export-button"
        >
          {isExporting ? (
            <>
              <span
                className={styles.spinner}
                data-testid="pdf-export-loading"
              />
              {isPreparing
                ? 'Preparing…'
                : `Exporting ${nonDeletedPageCount} ${nonDeletedPageCount === 1 ? 'page' : 'pages'}…`}
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
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Export
            </>
          )}
        </button>
      </div>

      <div aria-live="polite" className="sr-only">
        {isExporting ? 'Export started' : ''}
        {exportMutation.isSuccess ? 'Export complete' : ''}
        {error ? 'Export failed' : ''}
      </div>

      {error && (
        <div
          className={styles.errorToast}
          role="alert"
          id="pdf-export-error"
          data-testid="pdf-export-error-toast"
        >
          <span className={styles.errorMessage}>{error}</span>
          <button
            className={styles.retryButton}
            onClick={handleRetry}
            data-testid="pdf-export-retry-button"
          >
            Retry
          </button>
          <button
            className={styles.dismissButton}
            onClick={handleDismissError}
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
};
