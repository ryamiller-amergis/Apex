import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import type { PdfFileMetadata, PageManifestEntry, FileUploadResult } from '../../shared/types/pdf';
import type { DocumentColor } from '../hooks/useDocumentColors';
import { usePdfDocument } from '../hooks/usePdfDocument';
import { useThumbnailRenderer } from '../hooks/useThumbnailRenderer';
import { PdfWorkerProvider } from '../contexts/PdfWorkerContext';
import styles from './SourceBrowser.module.css';

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

const MINI_WIDTH = 72;
const MINI_HEIGHT = Math.round(MINI_WIDTH * (22 / 17));

/* ── Mini Page Thumbnail (internal) ──────────────────── */

interface MiniPageThumbnailProps {
  pageId: string;
  fileUrl: string;
  sourcePageIndex: number;
  rotation: 0 | 90 | 180 | 270;
  pageNumber: number;
  isInAssembly: boolean;
  onToggle: (pageId: string) => void;
}

const MiniPageThumbnail: React.FC<MiniPageThumbnailProps> = ({
  pageId,
  fileUrl,
  sourcePageIndex,
  rotation,
  pageNumber,
  isInAssembly,
  onToggle,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const { document, isLoading: isDocLoading } = usePdfDocument(fileUrl);
  const { status, imageBitmap } = useThumbnailRenderer(
    document ?? null,
    sourcePageIndex,
    rotation,
    1,
    fileUrl,
  );

  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageBitmap) return;
    canvas.width = MINI_WIDTH;
    canvas.height = MINI_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(imageBitmap, 0, 0, MINI_WIDTH, MINI_HEIGHT);
    }
  }, [imageBitmap]);

  const isLoading = isDocLoading || status === 'loading' || status === 'idle';

  const handleClick = useCallback(() => {
    onToggle(pageId);
  }, [onToggle, pageId]);

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('application/x-pdf-page', pageId);
      setIsDragging(true);
    },
    [pageId],
  );

  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
  }, []);

  const className = [
    styles['mini-thumbnail'],
    isInAssembly ? styles['mini-thumbnail-in-assembly'] : '',
    isDragging ? styles['mini-thumbnail-dragging'] : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      onClick={handleClick}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      data-testid={`mini-thumbnail-${pageId}`}
      title={`Page ${pageNumber}${isInAssembly ? '' : ' (excluded)'}`}
    >
      {isLoading && <div className={styles['mini-skeleton']} />}
      <canvas ref={canvasRef} className={styles['mini-canvas']} />
      <span className={styles['page-badge']}>{pageNumber}</span>
      <span
        className={`${styles['inclusion-indicator']} ${
          isInAssembly
            ? styles['inclusion-indicator-included']
            : styles['inclusion-indicator-excluded']
        }`}
        data-testid={`mini-thumb-indicator-${pageId}`}
        data-included={isInAssembly ? 'true' : 'false'}
      />
    </div>
  );
};

/* ── SourceBrowser ───────────────────────────────────── */

export interface SourceBrowserProps {
  fileMetadata: PdfFileMetadata[];
  localManifest: PageManifestEntry[];
  sessionId: string;
  documentColors: Map<string, DocumentColor>;
  isPageInAssembly: (pageId: string) => boolean;
  onTogglePageInAssembly: (pageId: string) => void;
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
  onRemoveFile?: (fileId: string) => void;
}

export const SourceBrowser: React.FC<SourceBrowserProps> = ({
  fileMetadata,
  localManifest,
  sessionId,
  documentColors,
  isPageInAssembly,
  onTogglePageInAssembly,
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
  onRemoveFile,
}) => {
  const [expandedFileIds, setExpandedFileIds] = useState<Set<string>>(new Set());

  const sortedFiles = useMemo(
    () => [...fileMetadata].sort((a, b) => a.originalName.localeCompare(b.originalName)),
    [fileMetadata],
  );

  const pagesByFile = useMemo(() => {
    const map = new Map<string, PageManifestEntry[]>();
    for (const entry of localManifest) {
      let arr = map.get(entry.fileId);
      if (!arr) {
        arr = [];
        map.set(entry.fileId, arr);
      }
      arr.push(entry);
    }
    return map;
  }, [localManifest]);

  const toggleExpand = useCallback((fileId: string) => {
    setExpandedFileIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }
      return next;
    });
  }, []);

  return (
    <aside className={styles['source-browser']} aria-label="Source documents">
      {/* Compact dropzone */}
      <div
        className={`${styles.dropzone} ${dragActive ? styles['dropzone-active'] : ''}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={onDropzoneClick}
        role="button"
        tabIndex={0}
        aria-label="Upload PDF files"
        data-testid="pdf-dropzone"
      >
        <span className={styles['dropzone-icon']}>📄</span>
        <p className={styles['dropzone-text']}>
          <strong>Click to upload</strong> or drag &amp; drop
        </p>
        <p className={styles['dropzone-hint']}>
          PDF up to 100 MB &middot; 500 pages
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,application/pdf"
          multiple
          className={styles['dropzone-input']}
          onChange={onInputChange}
          data-testid="pdf-file-input"
        />
      </div>

      {/* Uploading indicator */}
      {isUploading && (
        <div className={styles['uploading-overlay']} data-testid="pdf-uploading">
          <div className={styles.spinner} />
          <p className={styles['uploading-text']}>
            {createSessionPending ? 'Creating session…' : 'Uploading…'}
          </p>
        </div>
      )}

      {/* Validation errors */}
      {errors.length > 0 && (
        <div data-testid="pdf-upload-errors">
          {errors.map((err, i) => (
            <div key={i} className={styles['error-card']}>
              <span className={styles['error-icon']}>⚠️</span>
              <p className={styles['error-text']}>
                <span className={styles['error-file-name']}>{err.originalName}</span>
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
        <div className={styles['error-card']} data-testid="pdf-session-limit">
          <span className={styles['error-icon']}>⚠️</span>
          <p className={styles['error-text']}>
            Maximum 3 concurrent sessions reached. Close an existing session first.
          </p>
        </div>
      )}

      {/* Document list or empty state */}
      {sortedFiles.length > 0 ? (
        <>
          <p className={styles['file-list-label']}>
            Documents ({sortedFiles.length})
          </p>
          <div className={styles['file-list']} role="list" aria-label="Source documents">
            {sortedFiles.map((f) => {
              const isExpanded = expandedFileIds.has(f.fileId);
              const color = documentColors.get(f.fileId);
              const filePages = pagesByFile.get(f.fileId) ?? [];
              const fileUrl = `/api/pdf/sessions/${sessionId}/files/${f.fileId}`;

              return (
                <React.Fragment key={f.fileId}>
                  <div
                    className={`${styles['file-card']} ${isExpanded ? styles['file-card-expanded'] : ''}`}
                    role="listitem"
                    tabIndex={0}
                    aria-label={`${f.originalName}, ${formatBytes(f.sizeBytes)}, ${f.pageCount} ${f.pageCount === 1 ? 'page' : 'pages'}`}
                  >
                    <div
                      className={styles['color-indicator']}
                      style={{ backgroundColor: color?.border ?? 'transparent' }}
                    />
                    <button
                      type="button"
                      className={`${styles['chevron-btn']} ${isExpanded ? styles['chevron-expanded'] : ''}`}
                      aria-label={isExpanded ? 'Collapse pages' : 'Expand pages'}
                      title={isExpanded ? 'Collapse pages' : 'Expand pages'}
                      onClick={() => toggleExpand(f.fileId)}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 6 15 12 9 18" />
                      </svg>
                    </button>
                    <span className={styles['file-icon']}>📄</span>
                    <div className={styles['file-info']}>
                      <p className={styles['file-name']}>{f.originalName}</p>
                      <p className={styles['file-meta']}>
                        <span>{formatBytes(f.sizeBytes)}</span>
                        <span>{f.pageCount} {f.pageCount === 1 ? 'page' : 'pages'}</span>
                      </p>
                    </div>
                    {onRemoveFile && (
                      <button
                        type="button"
                        className={styles['delete-btn']}
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
                  {isExpanded && filePages.length > 0 && (
                    <div
                      className={styles['page-strip']}
                      style={{ borderLeftColor: color?.border ?? 'var(--accent-color)' }}
                    >
                      <PdfWorkerProvider>
                        {filePages.map((entry) => (
                          <MiniPageThumbnail
                            key={entry.pageId}
                            pageId={entry.pageId}
                            fileUrl={fileUrl}
                            sourcePageIndex={entry.sourcePageIndex}
                            rotation={entry.rotation}
                            pageNumber={entry.sourcePageIndex + 1}
                            isInAssembly={isPageInAssembly(entry.pageId)}
                            onToggle={onTogglePageInAssembly}
                          />
                        ))}
                      </PdfWorkerProvider>
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </>
      ) : !isUploading && (
        <div className={styles['empty-state']}>
          <span className={styles['empty-icon']}>📂</span>
          <p className={styles['empty-text']}>
            Upload PDF documents to begin assembly
          </p>
        </div>
      )}
    </aside>
  );
};
