import React, { useRef, useState } from 'react';
import {
  ArrowLeft,
  FolderOpen,
  Undo2,
  Redo2,
  ChevronLeft,
  ChevronRight,
  ZoomOut,
  ZoomIn,
  Maximize2,
  Search,
  Download,
  FileText,
  FilePlus,
} from 'lucide-react';
import styles from './NutrientWorkbenchHeader.module.css';

export interface WorkbenchHeaderProps {
  fileName: string | null;
  isDirty: boolean;
  isLoaded: boolean;
  isConverting: boolean;
  currentPage: number;
  totalPages: number;
  status: string;
  error: string | null;
  /** File input accept attribute. Defaults to PDF-only. */
  accept?: string;
  /** Open button label. Defaults to "Open PDF". */
  openLabel?: string;
  /** Tooltip / extra hint for the Open button. */
  openHint?: string;
  /** Called with one or more files — multiple = merge before loading. */
  onLoadFiles: (files: File[]) => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onGoToPage: (page: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitPage: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onOpenSearch: () => void;
  onDownloadPdf: () => void;
  onExportWord: () => void;
  onMergePdf: (file: File) => void;
  onBack: () => void;
}

export const NutrientWorkbenchHeader: React.FC<WorkbenchHeaderProps> = ({
  fileName,
  isDirty,
  isLoaded,
  isConverting,
  currentPage,
  totalPages,
  status,
  error,
  accept = 'application/pdf,.pdf',
  openLabel = 'Open PDF',
  openHint = 'Select one file to open, or multiple PDFs to auto-merge',
  onLoadFiles,
  onPrevPage,
  onNextPage,
  onGoToPage,
  onZoomIn,
  onZoomOut,
  onFitPage,
  onUndo,
  onRedo,
  onOpenSearch,
  onDownloadPdf,
  onExportWord,
  onMergePdf,
  onBack,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mergeInputRef = useRef<HTMLInputElement>(null);
  const [pageInput, setPageInput] = useState('');

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (files.length > 0) onLoadFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleMergeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onMergePdf(file);
    if (mergeInputRef.current) mergeInputRef.current.value = '';
  };

  const handlePageKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const page = parseInt(pageInput, 10);
      if (!Number.isNaN(page)) {
        onGoToPage(page);
        setPageInput('');
        (e.target as HTMLInputElement).blur();
      }
    }
    if (e.key === 'Escape') {
      setPageInput('');
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <header className={styles.bar} data-testid="nutrient-workbench-header">
      {/* ── Left: back, open, filename ─────────────────────────────── */}
      <div className={styles.group}>
        <a
          className={styles.iconBtn}
          href="/pdf-tools/nutrient-poc"
          onClick={onBack}
          aria-label="Back to PDF tools"
          data-testid="nutrient-header-back"
        >
          <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />
        </a>

        <button
          type="button"
          className={styles.openBtn}
          onClick={() => fileInputRef.current?.click()}
          aria-label={openLabel}
          data-testid="header-open-pdf"
          title={openHint}
        >
          <FolderOpen size={15} strokeWidth={1.8} aria-hidden="true" />
          <span>{openLabel}</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={accept}
          multiple
          aria-label="Choose one or more files"
          style={{ display: 'none' }}
          onChange={handleFileChange}
          data-testid="header-file-input"
        />

        {fileName && (
          <span className={styles.filename}>
            {fileName}
            {isDirty && (
              <span className={styles.dirty} aria-label="Unsaved changes">
                ●
              </span>
            )}
          </span>
        )}
      </div>

      {/* ── Center: undo/redo, page nav, zoom, search ────────────────── */}
      <div className={styles.group}>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={onUndo}
          disabled={!isLoaded}
          aria-label="Undo"
          data-testid="header-undo"
        >
          <Undo2 size={16} strokeWidth={2} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={onRedo}
          disabled={!isLoaded}
          aria-label="Redo"
          data-testid="header-redo"
        >
          <Redo2 size={16} strokeWidth={2} aria-hidden="true" />
        </button>

        <div className={styles.divider} aria-hidden="true" />

        <button
          type="button"
          className={styles.iconBtn}
          onClick={onPrevPage}
          disabled={!isLoaded || currentPage <= 1}
          aria-label="Previous page"
          data-testid="header-prev-page"
        >
          <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
        </button>

        <input
          type="number"
          className={styles.pageInput}
          value={pageInput !== '' ? pageInput : currentPage}
          min={1}
          max={totalPages || 1}
          aria-label="Current page"
          onFocus={() => setPageInput(String(currentPage))}
          onChange={(e) => setPageInput(e.target.value)}
          onKeyDown={handlePageKeyDown}
          onBlur={() => setPageInput('')}
          disabled={!isLoaded}
          data-testid="header-page-input"
        />
        <span
          className={styles.pageTotal}
          aria-label={`of ${totalPages} pages`}
        >
          / {totalPages || 1}
        </span>

        <button
          type="button"
          className={styles.iconBtn}
          onClick={onNextPage}
          disabled={!isLoaded || currentPage >= totalPages}
          aria-label="Next page"
          data-testid="header-next-page"
        >
          <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
        </button>

        <div className={styles.divider} aria-hidden="true" />

        <button
          type="button"
          className={styles.iconBtn}
          onClick={onZoomOut}
          disabled={!isLoaded}
          aria-label="Zoom out"
          data-testid="header-zoom-out"
        >
          <ZoomOut size={16} strokeWidth={2} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={onFitPage}
          disabled={!isLoaded}
          aria-label="Fit page"
          data-testid="header-fit-page"
        >
          <Maximize2 size={16} strokeWidth={2} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={onZoomIn}
          disabled={!isLoaded}
          aria-label="Zoom in"
          data-testid="header-zoom-in"
        >
          <ZoomIn size={16} strokeWidth={2} aria-hidden="true" />
        </button>

        <div className={styles.divider} aria-hidden="true" />

        <button
          type="button"
          className={styles.iconBtn}
          onClick={onOpenSearch}
          disabled={!isLoaded}
          aria-label="Search"
          data-testid="header-search"
        >
          <Search size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {/* ── Right: status + exports ──────────────────────────────────── */}
      <div className={styles.group}>
        {error ? (
          <span
            className={styles.error}
            role="alert"
            data-testid="header-error"
          >
            {error}
          </span>
        ) : (
          <span
            className={styles.status}
            role="status"
            data-testid="header-status"
          >
            {status}
          </span>
        )}

        <button
          type="button"
          className={styles.exportBtn}
          onClick={onDownloadPdf}
          disabled={!isLoaded || isConverting}
          aria-label="Save PDF"
          data-testid="header-save-pdf"
        >
          <Download size={14} strokeWidth={2} aria-hidden="true" />
          <span>PDF</span>
        </button>

        <button
          type="button"
          className={`${styles.exportBtn} ${styles.exportBtnWord}`}
          onClick={onExportWord}
          disabled={!isLoaded || isConverting}
          aria-label="Export to Word"
          data-testid="header-export-word"
        >
          <FileText size={14} strokeWidth={2} aria-hidden="true" />
          <span>{isConverting ? 'Exporting…' : 'Word'}</span>
        </button>

        <button
          type="button"
          className={styles.exportBtn}
          onClick={() => mergeInputRef.current?.click()}
          disabled={!isLoaded || isConverting}
          aria-label="Merge another PDF into this document"
          data-testid="header-merge-pdf"
          title="Merge PDF — append pages from another file"
        >
          <FilePlus size={14} strokeWidth={2} aria-hidden="true" />
          <span>Merge</span>
        </button>
        <input
          ref={mergeInputRef}
          type="file"
          accept="application/pdf,.pdf"
          aria-label="Choose PDF to merge"
          style={{ display: 'none' }}
          onChange={handleMergeChange}
          data-testid="header-merge-input"
        />
      </div>
    </header>
  );
};
