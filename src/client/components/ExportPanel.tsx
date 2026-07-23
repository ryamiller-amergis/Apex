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
  /** Called after a PDF export download has started successfully. Word exports do not trigger this. */
  onExportComplete?: () => void;
}

const DownloadIcon = () => (
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
);

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
  const [isPreparingWord, setIsPreparingWord] = useState(false);
  // Single ref so onExportComplete fires at most once per export cycle
  const hasReportedSuccessRef = useRef(false);
  // Tracks which format is currently running so only one mutation fires per click
  const activeFormatRef = useRef<'pdf' | 'docx' | null>(null);

  const pdfMutation = useExportSession();
  const wordMutation = useExportSession();

  const isAnyExporting =
    pdfMutation.isPending || wordMutation.isPending || isPreparing || isPreparingWord;
  const isEmpty = nonDeletedPageCount === 0;

  useEffect(() => {
    const isSuccess = activeFormatRef.current === 'pdf'
      ? pdfMutation.isSuccess
      : activeFormatRef.current === 'docx'
        ? wordMutation.isSuccess
        : pdfMutation.isSuccess || wordMutation.isSuccess;
    if (!isSuccess) {
      hasReportedSuccessRef.current = false;
      return;
    }
    if (hasReportedSuccessRef.current) return;
    hasReportedSuccessRef.current = true;
    setError(null);
    // Only reset the session after a PDF export; Word is a secondary format —
    // the user may still want to download as PDF or keep editing.
    if (activeFormatRef.current !== 'docx') {
      onExportComplete?.();
    }
  }, [pdfMutation.isSuccess, wordMutation.isSuccess, onExportComplete]);

  useEffect(() => {
    if (pdfMutation.isError) {
      setError(pdfMutation.error?.message ?? 'Export failed. Please retry.');
    }
  }, [pdfMutation.isError, pdfMutation.error]);

  useEffect(() => {
    if (wordMutation.isError) {
      setError(wordMutation.error?.message ?? 'Word export failed. Please retry.');
    }
  }, [wordMutation.isError, wordMutation.error]);

  const runExport = useCallback(
    async (format: 'pdf' | 'docx') => {
      setError(null);
      activeFormatRef.current = format;
      if (format === 'docx') {
        setIsPreparingWord(true);
      } else {
        setIsPreparing(true);
      }
      try {
        await onBeforeExport?.();
        const mutation = format === 'docx' ? wordMutation : pdfMutation;
        mutation.mutate({
          sessionId,
          ...(format === 'docx' ? { format: 'docx' as const } : {}),
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
        if (format === 'docx') {
          setIsPreparingWord(false);
        } else {
          setIsPreparing(false);
        }
      }
    },
    [
      onBeforeExport,
      pdfMutation,
      wordMutation,
      filenameOverride,
      isFilenameAutomatic,
      sessionId,
    ]
  );

  const handleExport = useCallback(() => void runExport('pdf'), [runExport]);
  const handleWordExport = useCallback(() => void runExport('docx'), [runExport]);
  const handleRetry = useCallback(() => void runExport('pdf'), [runExport]);
  const handleDismissError = useCallback(() => setError(null), []);

  const isPdfExporting = pdfMutation.isPending || isPreparing;
  const isWordExporting = wordMutation.isPending || isPreparingWord;

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
              ? 'Server will choose a source-based name'
              : undefined
          }
          onChange={(e) => onFilenameOverrideChange(e.target.value)}
          disabled={isAnyExporting}
          data-testid="pdf-export-filename-input"
          data-filename-mode={isFilenameAutomatic ? 'automatic' : 'override'}
          aria-describedby={error ? 'pdf-export-error' : undefined}
        />
        <button
          className={styles.exportButton}
          onClick={handleExport}
          disabled={isEmpty || isAnyExporting}
          aria-busy={isPdfExporting}
          aria-label={isPdfExporting ? 'Exporting PDF' : 'Export PDF'}
          title={isEmpty ? 'Add pages to export' : undefined}
          data-testid="pdf-export-button"
        >
          {isPdfExporting ? (
            <>
              <span className={styles.spinner} data-testid="pdf-export-loading" />
              {isPreparing
                ? 'Preparing…'
                : `Exporting ${nonDeletedPageCount} ${nonDeletedPageCount === 1 ? 'page' : 'pages'}…`}
            </>
          ) : (
            <>
              <DownloadIcon />
              Export PDF
            </>
          )}
        </button>
        <button
          className={styles.wordButton}
          onClick={handleWordExport}
          disabled={isEmpty || isAnyExporting}
          aria-busy={isWordExporting}
          aria-label={isWordExporting ? 'Extracting text to Word' : 'Extract text to Word (.docx)'}
          title={
            isEmpty
              ? 'Add pages to export'
              : 'Extracts text content only — layout, images, and formatting are not preserved.'
          }
          data-testid="pdf-export-word-button"
        >
          {isWordExporting ? (
            <>
              <span className={styles.spinner} data-testid="pdf-word-loading" />
              {isPreparingWord ? 'Preparing…' : 'Extracting…'}
            </>
          ) : (
            <>
              <DownloadIcon />
              Extract to Word
              <span
                className={styles.wordInfoIcon}
                aria-hidden="true"
                title="Extracts text content only — layout, images, and formatting are not preserved."
              >
                ⓘ
              </span>
            </>
          )}
        </button>
      </div>

      <div aria-live="polite" className="sr-only">
        {isPdfExporting ? 'PDF export started' : ''}
        {isWordExporting ? 'Word export started' : ''}
        {pdfMutation.isSuccess ? 'PDF export complete' : ''}
        {wordMutation.isSuccess ? 'Word export complete' : ''}
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
