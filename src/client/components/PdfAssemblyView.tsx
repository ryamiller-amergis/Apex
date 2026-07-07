import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useCreatePdfSession, usePdfSession, useUploadPdfFiles, useActivePdfSessions } from '../hooks/usePdfSession';
import { PageThumbnailGrid } from './PageThumbnailGrid';
import { PagePreviewModal } from './PagePreviewModal';
import type { FileUploadResult, PageManifestEntry } from '../../shared/types/pdf';
import styles from './PdfAssemblyView.module.css';

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

export const PdfAssemblyView: React.FC = () => {
  const [sessionId, setSessionId] = useState<string | null>(
    () => sessionStorage.getItem('pdf-active-session'),
  );
  const [dragActive, setDragActive] = useState(false);
  const [uploadResults, setUploadResults] = useState<FileUploadResult[]>([]);
  const [previewPageId, setPreviewPageId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const createSession = useCreatePdfSession();
  const { data: session } = usePdfSession(sessionId);
  const uploadFiles = useUploadPdfFiles();
  const { data: activeSessions } = useActivePdfSessions();

  useEffect(() => {
    if (sessionId) return;
    if (activeSessions && activeSessions.length > 0) {
      const mostRecent = activeSessions[0];
      setSessionId(mostRecent.id);
      sessionStorage.setItem('pdf-active-session', mostRecent.id);
    }
  }, [sessionId, activeSessions]);

  const errors = useMemo(
    () => uploadResults.filter((r) => r.status === 'error'),
    [uploadResults],
  );

  const handleFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;

    let activeSessionId = sessionId;

    if (!activeSessionId) {
      try {
        const result = await createSession.mutateAsync({});
        activeSessionId = result.sessionId;
        setSessionId(activeSessionId);
        sessionStorage.setItem('pdf-active-session', activeSessionId);
      } catch {
        return;
      }
    }

    try {
      const result = await uploadFiles.mutateAsync({ sessionId: activeSessionId, files });
      setUploadResults((prev) => [...prev, ...result.files]);
    } catch {
      // mutation error handled by TanStack Query
    }
  }, [sessionId, createSession, uploadFiles]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files);
    handleFiles(files);
  }, [handleFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    handleFiles(files);
    if (inputRef.current) inputRef.current.value = '';
  }, [handleFiles]);

  const handleDropzoneClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const triggerRef = useRef<HTMLElement | null>(null);

  const handlePreview = useCallback((pageId: string) => {
    const el = window.document.querySelector<HTMLElement>(`[data-page-id="${pageId}"]`);
    triggerRef.current = el;
    setPreviewPageId(pageId);
  }, []);

  const handleClosePreview = useCallback(() => {
    const el = triggerRef.current;
    setPreviewPageId(null);
    requestAnimationFrame(() => {
      el?.focus();
    });
  }, []);

  const isUploading = uploadFiles.isPending || createSession.isPending;
  const fileMetadata = session?.fileMetadata ?? [];

  const previewPage = useMemo(() => {
    if (!previewPageId || !session?.pageManifest) return null;
    return session.pageManifest.find((p: PageManifestEntry) => p.pageId === previewPageId) ?? null;
  }, [previewPageId, session?.pageManifest]);

  const previewFileName = useMemo(() => {
    if (!previewPage) return '';
    const file = fileMetadata.find((f) => f.fileId === previewPage.fileId);
    return file?.originalName ?? 'Unknown';
  }, [previewPage, fileMetadata]);

  return (
    <div className={styles.container} data-testid="pdf-assembly-view">
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.heading}>PDF Tools</h1>
          <p className={styles.subheading}>Upload, validate, and assemble PDF documents</p>
        </div>
        {sessionId && (
          <span className={styles.sessionBadge}>
            <span className={styles.sessionDot} />
            Session active
          </span>
        )}
      </div>

      {/* Dropzone */}
      <div
        className={`${styles.dropzone} ${dragActive ? styles.dropzoneActive : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={handleDropzoneClick}
        role="button"
        tabIndex={0}
        aria-label="Upload PDF files"
        data-testid="pdf-dropzone"
      >
        <span className={styles.dropzoneIcon}>📄</span>
        <p className={styles.dropzoneText}>
          <strong>Click to upload</strong> or drag and drop PDF files here
        </p>
        <p className={styles.dropzoneHint}>
          PDF files up to 100 MB each &middot; 250 MB per session &middot; 500 pages max
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,application/pdf"
          multiple
          className={styles.dropzoneInput}
          onChange={handleInputChange}
          data-testid="pdf-file-input"
        />
      </div>

      {/* Uploading indicator */}
      {isUploading && (
        <div className={styles.uploadingOverlay} data-testid="pdf-uploading">
          <div className={styles.spinner} />
          <p className={styles.uploadingText}>
            {createSession.isPending ? 'Creating session…' : 'Uploading and validating…'}
          </p>
        </div>
      )}

      {/* Validation errors from latest upload */}
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
      {createSession.error?.code === 'SESSION_LIMIT_REACHED' && (
        <div className={styles.errorCard} data-testid="pdf-session-limit">
          <span className={styles.errorIcon}>⚠️</span>
          <p className={styles.errorText}>
            Maximum 3 concurrent sessions reached. Please close an existing session first.
          </p>
        </div>
      )}

      {/* Uploaded files list */}
      {fileMetadata.length > 0 ? (
        <section className={styles.fileList} data-testid="pdf-file-list" aria-label="Uploaded files">
          <p className={styles.fileListLabel}>
            Uploaded files ({fileMetadata.length})
          </p>
          {fileMetadata.map((f) => (
            <div
              key={f.fileId}
              className={styles.fileCard}
              tabIndex={0}
              role="listitem"
              aria-label={`${f.originalName}, ${formatBytes(f.sizeBytes)}, ${f.pageCount} ${f.pageCount === 1 ? 'page' : 'pages'}, valid`}
            >
              <span className={styles.fileIcon}>📑</span>
              <div className={styles.fileInfo}>
                <p className={styles.fileName}>{f.originalName}</p>
                <p className={styles.fileMeta}>
                  <span>{formatBytes(f.sizeBytes)}</span>
                  <span>{f.pageCount} {f.pageCount === 1 ? 'page' : 'pages'}</span>
                </p>
              </div>
              <span className={`${styles.fileStatus} ${styles.statusSuccess}`}>
                ✓ Valid
              </span>
            </div>
          ))}
        </section>
      ) : !isUploading && (
        <div className={styles.emptyState}>
          <span className={styles.emptyIcon}>📂</span>
          <p className={styles.emptyText}>
            No files uploaded yet. Drop PDFs above to get started.
          </p>
        </div>
      )}

      {sessionId && session?.pageManifest && session.pageManifest.length > 0 && (
        <section aria-label="Page thumbnails" data-testid="pdf-thumbnails-section">
          <h2 className={styles.sectionHeading} tabIndex={-1}>
            Pages ({session.pageManifest.filter((p: PageManifestEntry) => !p.deleted).length})
          </h2>
          <PageThumbnailGrid
            sessionId={sessionId}
            pageManifest={session.pageManifest}
            fileMetadata={fileMetadata}
            onPreview={handlePreview}
          />
        </section>
      )}

      {previewPage && sessionId && (
        <PagePreviewModal
          isOpen={!!previewPageId}
          pageId={previewPageId}
          fileUrl={`/api/pdf/sessions/${sessionId}/files/${previewPage.fileId}`}
          sourcePageIndex={previewPage.sourcePageIndex}
          rotation={previewPage.rotation}
          sourceFileName={previewFileName}
          originalPageNumber={previewPage.sourcePageIndex + 1}
          onClose={handleClosePreview}
        />
      )}
    </div>
  );
};

export default PdfAssemblyView;
