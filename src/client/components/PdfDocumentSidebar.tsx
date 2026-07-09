import React, { useMemo, useState, useCallback } from 'react';
import type { PdfFileMetadata, FileUploadResult } from '../../shared/types/pdf';
import styles from './PdfDocumentSidebar.module.css';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ERROR_LABELS: Record<string, string> = {
  FILE_ENCRYPTED: 'Password-protected',
  FILE_CORRUPT: 'Corrupt file',
  FILE_NOT_PDF: 'Not a valid PDF',
  FILE_TOO_LARGE: 'Exceeds 100 MB',
  SESSION_SIZE_EXCEEDED: 'Session size limit',
  SESSION_PAGES_EXCEEDED: 'Page limit exceeded',
  UNSUPPORTED_FORMAT: 'Unsupported format',
};

export interface PdfDocumentSidebarProps {
  fileMetadata: PdfFileMetadata[];
  selectedFileId: string | null;
  onSelectFile: (fileId: string) => void;
  onRemoveFile?: (fileId: string) => void;
  hero?: boolean;
  dragActive: boolean;
  onDrop: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDropzoneClick: () => void;
  inputRef: React.RefObject<HTMLInputElement>;
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  isUploading: boolean;
  createSessionPending: boolean;
  errors: FileUploadResult[];
  sessionLimitError: boolean;
  children?: React.ReactNode;
}

export const PdfDocumentSidebar: React.FC<PdfDocumentSidebarProps> = ({
  fileMetadata,
  selectedFileId,
  onSelectFile,
  onRemoveFile,
  hero = false,
  children,
  dragActive,
  onDrop,
  onDragOver,
  onDragLeave,
  onDropzoneClick,
  inputRef,
  onInputChange,
  isUploading,
  createSessionPending,
  errors,
  sessionLimitError,
}) => {
  const sortedFiles = useMemo(
    () => [...fileMetadata].sort((a, b) => a.originalName.localeCompare(b.originalName)),
    [fileMetadata],
  );

  const [collapsedFileIds, setCollapsedFileIds] = useState<Set<string>>(new Set());

  const toggleCollapse = useCallback((fileId: string) => {
    setCollapsedFileIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }
      return next;
    });
  }, []);

  if (hero) {
    return (
      <aside className={styles.sidebarHero}>
        <div className={styles.heroCard}>
          {/* Large upload area */}
          <div
            className={`${styles.dropzoneHero} ${dragActive ? styles.dropzoneHeroActive : ''}`}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onClick={onDropzoneClick}
            role="button"
            tabIndex={0}
            aria-label="Upload PDF files"
            data-testid="pdf-dropzone"
          >
            <svg className={styles.heroUploadIcon} viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="8" y="4" width="24" height="32" rx="3" />
              <path d="M32 4l8 8v28a3 3 0 0 1-3 3H11" strokeOpacity="0.4" />
              <path d="M32 4v8h8" strokeOpacity="0.4" />
              <path d="M24 30v-12M19 23l5-5 5 5" />
            </svg>
            <p className={styles.dropzoneHeroText}>
              <strong>Click to upload</strong> or drag &amp; drop
            </p>
            <p className={styles.dropzoneHeroHint}>
              PDF · up to 100 MB each · 500 pages max
            </p>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,application/pdf"
              multiple
              className={styles.dropzoneInput}
              onChange={onInputChange}
              data-testid="pdf-file-input"
            />
          </div>

          {/* Capabilities */}
          {!isUploading && (
            <ul className={styles.heroCapabilities}>
              <li>
                <span className={styles.heroCapIcon}>↕</span>
                Reorder pages by dragging or using move controls
              </li>
              <li>
                <span className={styles.heroCapIcon}>↻</span>
                Rotate and delete individual pages
              </li>
              <li>
                <span className={styles.heroCapIcon}>⬇</span>
                Export your assembled document as a single PDF
              </li>
            </ul>
          )}

          {/* Uploading state inside the card */}
          {isUploading && (
            <div className={styles.uploadingOverlay} data-testid="pdf-uploading">
              <div className={styles.spinner} />
              <p className={styles.uploadingText}>
                {createSessionPending ? 'Creating session…' : 'Uploading and validating…'}
              </p>
            </div>
          )}

          {/* Upload errors */}
          {errors.length > 0 && (
            <div data-testid="pdf-upload-errors">
              {errors.map((err, i) => (
                <div key={i} className={styles.errorCard}>
                  <span className={styles.errorIcon}>⚠️</span>
                  <p className={styles.errorText}>
                    <span className={styles.errorFileName}>{err.originalName}</span>
                    {' — '}
                    {ERROR_LABELS[err.error?.code ?? ''] ?? err.error?.message ?? 'Upload failed'}
                    {err.error?.message && err.error.code && (
                      <> &middot; {err.error.message}</>
                    )}
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* Session limit error */}
          {sessionLimitError && (
            <div className={styles.errorCard} data-testid="pdf-session-limit">
              <span className={styles.errorIcon}>⚠️</span>
              <p className={styles.errorText}>
                Maximum 3 concurrent sessions reached. Close an existing session first.
              </p>
            </div>
          )}
        </div>
      </aside>
    );
  }

  return (
    <aside className={styles.sidebar}>
      {/* Compact dropzone */}
      <div
        className={`${styles.dropzone} ${dragActive ? styles.dropzoneActive : ''}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={onDropzoneClick}
        role="button"
        tabIndex={0}
        aria-label="Upload PDF files"
        data-testid="pdf-dropzone"
      >
        <span className={styles.dropzoneIcon}>📄</span>
        <p className={styles.dropzoneText}>
          <strong>Click to upload</strong> or drag &amp; drop
        </p>
        <p className={styles.dropzoneHint}>
          PDF up to 100 MB &middot; 250 MB/session &middot; 500 pages
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,application/pdf"
          multiple
          className={styles.dropzoneInput}
          onChange={onInputChange}
          data-testid="pdf-file-input"
        />
      </div>

      {/* Uploading indicator */}
      {isUploading && (
        <div className={styles.uploadingOverlay} data-testid="pdf-uploading">
          <div className={styles.spinner} />
          <p className={styles.uploadingText}>
            {createSessionPending ? 'Creating session…' : 'Uploading…'}
          </p>
        </div>
      )}

      {/* Validation errors */}
      {errors.length > 0 && (
        <div data-testid="pdf-upload-errors">
          {errors.map((err, i) => (
            <div key={i} className={styles.errorCard}>
              <span className={styles.errorIcon}>⚠️</span>
              <p className={styles.errorText}>
                <span className={styles.errorFileName}>{err.originalName}</span>
                {' — '}
                {ERROR_LABELS[err.error?.code ?? ''] ?? err.error?.message ?? 'Upload failed'}
                {err.error?.message && err.error.code && (
                  <> &middot; {err.error.message}</>
                )}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Session limit error */}
      {sessionLimitError && (
        <div className={styles.errorCard} data-testid="pdf-session-limit">
          <span className={styles.errorIcon}>⚠️</span>
          <p className={styles.errorText}>
            Maximum 3 concurrent sessions reached. Close an existing session first.
          </p>
        </div>
      )}

      {/* File list or empty state */}
      {sortedFiles.length > 0 ? (
        <>
          <p className={styles.fileListLabel}>
            Documents ({sortedFiles.length})
          </p>
          <div className={styles.fileList} role="list" aria-label="Uploaded files">
            {sortedFiles.map((f) => {
              const isExpanded = f.fileId === selectedFileId && !collapsedFileIds.has(f.fileId);
              return (
                <React.Fragment key={f.fileId}>
                  <div
                    className={`${styles.fileCard} ${f.fileId === selectedFileId ? styles.fileCardSelected : ''}`}
                    onClick={() => onSelectFile(f.fileId)}
                    tabIndex={0}
                    role="listitem"
                    aria-label={`${f.originalName}, ${formatBytes(f.sizeBytes)}, ${f.pageCount} ${f.pageCount === 1 ? 'page' : 'pages'}`}
                    aria-selected={f.fileId === selectedFileId}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectFile(f.fileId);
                      }
                    }}
                  >
                    <button
                      type="button"
                      className={`${styles.chevronBtn} ${isExpanded ? styles.chevronExpanded : ''}`}
                      aria-label={isExpanded ? 'Collapse pages' : 'Expand pages'}
                      title={isExpanded ? 'Collapse pages' : 'Expand pages'}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (f.fileId !== selectedFileId) {
                          onSelectFile(f.fileId);
                        }
                        toggleCollapse(f.fileId);
                      }}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 6 15 12 9 18" />
                      </svg>
                    </button>
                    <div className={styles.fileInfo}>
                      <p className={styles.fileName}>{f.originalName}</p>
                      <p className={styles.fileMeta}>
                        <span>{formatBytes(f.sizeBytes)}</span>
                        <span>{f.pageCount} {f.pageCount === 1 ? 'page' : 'pages'}</span>
                      </p>
                    </div>
                    {onRemoveFile && (
                      <button
                        type="button"
                        className={styles.deleteBtn}
                        aria-label={`Remove ${f.originalName}`}
                        title="Remove document"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveFile(f.fileId);
                        }}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6" />
                          <path d="M14 11v6" />
                          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                        </svg>
                      </button>
                    )}
                  </div>
                  {isExpanded && children && (
                    <div className={styles.pageStrip}>
                      {children}
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </>
      ) : !isUploading && (
        <div className={styles.emptyState}>
          <span className={styles.emptyIcon}>📂</span>
          <p className={styles.emptyText}>
            No files uploaded yet
          </p>
        </div>
      )}
    </aside>
  );
};
