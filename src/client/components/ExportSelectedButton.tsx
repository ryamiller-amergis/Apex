import React, { useCallback, useState, useEffect, useRef } from 'react';
import { useExportSession } from '../hooks/useExportSession';
import styles from './ExportSelectedButton.module.css';

interface ExportSelectedButtonProps {
  sessionId: string;
  selectedCount: number;
  selectedPageIndices: number[];
  filename?: string;
  onBeforeExport?: () => Promise<void>;
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

export const ExportSelectedButton: React.FC<ExportSelectedButtonProps> = ({
  sessionId,
  selectedCount,
  selectedPageIndices,
  filename,
  onBeforeExport,
  onExportComplete,
}) => {
  const pdfMutation = useExportSession();
  const wordMutation = useExportSession();
  const [isPreparing, setIsPreparing] = useState(false);
  const [isPreparingWord, setIsPreparingWord] = useState(false);

  const isAnyExporting =
    pdfMutation.isPending || wordMutation.isPending || isPreparing || isPreparingWord;
  const isDisabled = selectedCount === 0 || isAnyExporting;
  const [error, setError] = useState<string | null>(null);
  const hasReportedSuccessRef = useRef(false);
  const activeFormatRef = useRef<'pdf' | 'docx' | null>(null);

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
    onExportComplete?.();
  }, [pdfMutation.isSuccess, wordMutation.isSuccess, onExportComplete]);

  useEffect(() => {
    if (pdfMutation.isError) {
      setError(pdfMutation.error?.message ?? 'Export failed. Please retry.');
    } else if (wordMutation.isError) {
      setError(wordMutation.error?.message ?? 'Word export failed. Please retry.');
    }
  }, [pdfMutation.isError, pdfMutation.error, wordMutation.isError, wordMutation.error]);

  const runExport = useCallback(
    async (format: 'pdf' | 'docx') => {
      if (selectedCount === 0) return;
      setError(null);
      activeFormatRef.current = format;
      if (format === 'docx') {
        setIsPreparingWord(true);
      } else {
        setIsPreparing(true);
      }
      try {
        await onBeforeExport?.();
        const sortedPages = [...selectedPageIndices].sort((a, b) => a - b);
        const mutation = format === 'docx' ? wordMutation : pdfMutation;
        mutation.mutate({
          sessionId,
          ...(format === 'docx' ? { format: 'docx' as const } : {}),
          ...(filename?.trim() ? { filename } : {}),
          ...(sortedPages.length ? { pages: sortedPages } : {}),
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
      selectedCount,
      onBeforeExport,
      pdfMutation,
      wordMutation,
      sessionId,
      selectedPageIndices,
      filename,
    ]
  );

  const handlePdfClick = useCallback(() => {
    if (isDisabled) return;
    void runExport('pdf');
  }, [isDisabled, runExport]);

  const handleWordClick = useCallback(() => {
    if (isDisabled) return;
    void runExport('docx');
  }, [isDisabled, runExport]);

  const isPdfExporting = pdfMutation.isPending || isPreparing;
  const isWordExporting = wordMutation.isPending || isPreparingWord;

  return (
    <>
      <button
        className={styles.button}
        onClick={handlePdfClick}
        disabled={isDisabled}
        aria-busy={isPdfExporting}
        aria-label={
          isPdfExporting
            ? 'Exporting selected pages as PDF'
            : selectedCount > 0
              ? `Export ${selectedCount} selected ${selectedCount === 1 ? 'page' : 'pages'} as PDF`
              : 'Select pages to export'
        }
        title={selectedCount === 0 ? 'Select pages to export' : undefined}
        data-testid="pdf-export-selected-btn"
      >
        {isPdfExporting ? (
          <>
            <span className={styles.spinner} />
            Exporting…
          </>
        ) : (
          <>
            <DownloadIcon />
            Export Selected
            {selectedCount > 0 && (
              <span className={styles.badge} data-testid="pdf-selection-count">
                {selectedCount}
              </span>
            )}
          </>
        )}
      </button>

      <button
        className={styles.wordButton}
        onClick={handleWordClick}
        disabled={isDisabled}
        aria-busy={isWordExporting}
        aria-label={
          isWordExporting
            ? 'Extracting selected pages to Word'
            : selectedCount > 0
              ? `Extract ${selectedCount} selected ${selectedCount === 1 ? 'page' : 'pages'} to Word`
              : 'Select pages to extract to Word'
        }
        title={
          selectedCount === 0
            ? 'Select pages to extract to Word'
            : 'Extracts text content only — layout and images are not preserved.'
        }
        data-testid="pdf-export-selected-word-btn"
      >
        {isWordExporting ? (
          <>
            <span className={styles.wordSpinner} />
            Extracting…
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
            {selectedCount > 0 && (
              <span className={styles.badge} data-testid="pdf-word-selection-count">
                {selectedCount}
              </span>
            )}
          </>
        )}
      </button>

      {error && (
        <div
          className={styles.errorToast}
          role="alert"
          data-testid="pdf-export-selected-error"
        >
          <span>{error}</span>
          <button
            className={styles.retryBtn}
            onClick={handlePdfClick}
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
        {isPdfExporting ? 'PDF export started' : ''}
        {isWordExporting ? 'Word export started' : ''}
        {pdfMutation.isSuccess ? 'PDF export complete' : ''}
        {wordMutation.isSuccess ? 'Word export complete' : ''}
        {error ? 'Export failed' : ''}
      </div>
    </>
  );
};
