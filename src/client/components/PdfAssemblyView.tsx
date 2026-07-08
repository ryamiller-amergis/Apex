import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useCreatePdfSession, usePdfSession, useUploadPdfFiles, useActivePdfSessions, useRemovePdfFile } from '../hooks/usePdfSession';
import { usePageManipulation } from '../hooks/usePageManipulation';
import { usePageSelection } from '../hooks/usePageSelection';
import { PageThumbnailGrid } from './PageThumbnailGrid';
import { PagePreviewModal } from './PagePreviewModal';
import { ManipulationToolbar } from './ManipulationToolbar';
import { UndoSnackbar } from './UndoSnackbar';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { PdfDocumentSidebar } from './PdfDocumentSidebar';
import { PdfInlinePreview } from './PdfInlinePreview';
import type { FileUploadResult, PageManifestEntry } from '../../shared/types/pdf';
import styles from './PdfAssemblyView.module.css';

export const PdfAssemblyView: React.FC = () => {
  const [sessionId, setSessionId] = useState<string | null>(
    () => sessionStorage.getItem('pdf-active-session'),
  );
  const [dragActive, setDragActive] = useState(false);
  const [uploadResults, setUploadResults] = useState<FileUploadResult[]>([]);
  const [previewPageId, setPreviewPageId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteBlockedMessage, setDeleteBlockedMessage] = useState<string | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [fileIdToDelete, setFileIdToDelete] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const createSession = useCreatePdfSession();
  const { data: session } = usePdfSession(sessionId);
  const uploadFiles = useUploadPdfFiles();
  const { data: activeSessions } = useActivePdfSessions();
  const removePdfFile = useRemovePdfFile();

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

  const serverManifest = useMemo(
    () => session?.pageManifest ?? [],
    [session?.pageManifest],
  );

  const {
    localManifest,
    visiblePages: manipulationVisiblePages,
    reorder,
    reorderAndSync,
    reorderSyncError,
    dismissReorderSyncError,
    rotate,
    deletePages,
    undoDelete,
    undoState,
    hasUnsavedChanges,
    saveNow,
    syncDelete,
  } = usePageManipulation({
    sessionId: sessionId ?? '',
    serverManifest,
  });

  const {
    selectedPageIds,
    toggleSelection,
    multiToggle,
    rangeSelect,
    clearSelection,
    isSelected,
    selectedCount,
  } = usePageSelection();

  // Auto-select first file (A-Z sorted) when file list changes
  const sortedFiles = useMemo(
    () => [...fileMetadata].sort((a, b) => a.originalName.localeCompare(b.originalName)),
    [fileMetadata],
  );

  useEffect(() => {
    if (sortedFiles.length > 0 && (!selectedFileId || !sortedFiles.find((f) => f.fileId === selectedFileId))) {
      setSelectedFileId(sortedFiles[0].fileId);
    }
  }, [sortedFiles, selectedFileId]);

  // Pages filtered to the selected document
  const docVisiblePages = useMemo(
    () => localManifest.filter((p) => !p.deleted && p.fileId === selectedFileId),
    [localManifest, selectedFileId],
  );

  const docFilteredManifest = useMemo(
    () => localManifest.filter((p) => p.fileId === selectedFileId),
    [localManifest, selectedFileId],
  );

  const selectedFileMetadata = useMemo(
    () => fileMetadata.filter((f) => f.fileId === selectedFileId),
    [fileMetadata, selectedFileId],
  );

  const allDocPageIds = useMemo(
    () => docVisiblePages.map((p) => p.pageId),
    [docVisiblePages],
  );

  // Active page for inline preview
  const activePreviewPage = useMemo(() => {
    if (!activePageId) return null;
    return localManifest.find((p: PageManifestEntry) => p.pageId === activePageId && !p.deleted) ?? null;
  }, [activePageId, localManifest]);

  const activePreviewFileName = useMemo(() => {
    if (!activePreviewPage) return '';
    const file = fileMetadata.find((f) => f.fileId === activePreviewPage.fileId);
    return file?.originalName ?? 'Unknown';
  }, [activePreviewPage, fileMetadata]);

  const undoTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (undoState) {
      if (undoTimerRef.current !== null) clearTimeout(undoTimerRef.current);
      undoTimerRef.current = window.setTimeout(() => {
        undoTimerRef.current = null;
        syncDelete(localManifest);
      }, 8000);
    }
    return () => {
      if (undoTimerRef.current !== null) clearTimeout(undoTimerRef.current);
    };
  }, [undoState, syncDelete, localManifest]);

  const handleRotate = useCallback(() => {
    rotate(selectedPageIds);
  }, [rotate, selectedPageIds]);

  const handleDeleteClick = useCallback(() => {
    setShowDeleteConfirm(true);
  }, []);

  const handleDeleteConfirm = useCallback(() => {
    const result = deletePages(selectedPageIds);
    if (result.blocked) {
      setShowDeleteConfirm(false);
      setDeleteBlockedMessage(result.message ?? 'Cannot delete all pages.');
      return;
    }
    clearSelection();
    setShowDeleteConfirm(false);
    setDeleteBlockedMessage(null);
  }, [deletePages, selectedPageIds, clearSelection]);

  // Move up/down within the document-filtered view, translated to global indices
  const handleMoveUp = useCallback(() => {
    if (selectedPageIds.size !== 1) return;
    const pageId = [...selectedPageIds][0];
    const idx = docVisiblePages.findIndex((p) => p.pageId === pageId);
    if (idx > 0) {
      const globalFrom = manipulationVisiblePages.findIndex((p) => p.pageId === docVisiblePages[idx].pageId);
      const globalTo = manipulationVisiblePages.findIndex((p) => p.pageId === docVisiblePages[idx - 1].pageId);
      if (globalFrom >= 0 && globalTo >= 0) reorder(globalFrom, globalTo);
    }
  }, [selectedPageIds, docVisiblePages, manipulationVisiblePages, reorder]);

  const handleMoveDown = useCallback(() => {
    if (selectedPageIds.size !== 1) return;
    const pageId = [...selectedPageIds][0];
    const idx = docVisiblePages.findIndex((p) => p.pageId === pageId);
    if (idx < docVisiblePages.length - 1) {
      const globalFrom = manipulationVisiblePages.findIndex((p) => p.pageId === docVisiblePages[idx].pageId);
      const globalTo = manipulationVisiblePages.findIndex((p) => p.pageId === docVisiblePages[idx + 1].pageId);
      if (globalFrom >= 0 && globalTo >= 0) reorder(globalFrom, globalTo);
    }
  }, [selectedPageIds, docVisiblePages, manipulationVisiblePages, reorder]);

  // Can move up/down within the doc-scoped view
  const singleSelectedDocIndex = useMemo(() => {
    if (selectedPageIds.size !== 1) return -1;
    const pageId = [...selectedPageIds][0];
    return docVisiblePages.findIndex((p) => p.pageId === pageId);
  }, [selectedPageIds, docVisiblePages]);

  const canMoveUp = singleSelectedDocIndex > 0;
  const canMoveDown = singleSelectedDocIndex >= 0 && singleSelectedDocIndex < docVisiblePages.length - 1;

  // Reorder within doc view, translated to global indices
  const handleDocReorder = useCallback((fromIdx: number, toIdx: number) => {
    const fromPage = docVisiblePages[fromIdx];
    const toPage = docVisiblePages[toIdx];
    const globalFrom = manipulationVisiblePages.findIndex((p) => p.pageId === fromPage.pageId);
    const globalTo = manipulationVisiblePages.findIndex((p) => p.pageId === toPage.pageId);
    if (globalFrom >= 0 && globalTo >= 0) reorderAndSync(globalFrom, globalTo);
  }, [docVisiblePages, manipulationVisiblePages, reorderAndSync]);

  const handlePageSelect = useCallback(
    (pageId: string, shiftKey: boolean, ctrlKey: boolean) => {
      if (shiftKey) {
        rangeSelect(pageId, allDocPageIds);
      } else if (ctrlKey) {
        multiToggle(pageId);
      } else {
        toggleSelection(pageId);
        setActivePageId(pageId);
      }
    },
    [toggleSelection, multiToggle, rangeSelect, allDocPageIds],
  );

  const handleDismissUndo = useCallback(() => {
    undoDelete();
  }, [undoDelete]);

  const handleRemoveFileClick = useCallback((fileId: string) => {
    setFileIdToDelete(fileId);
  }, []);

  const handleRemoveFileConfirm = useCallback(async () => {
    if (!fileIdToDelete || !sessionId) return;
    try {
      await removePdfFile.mutateAsync({ sessionId, fileId: fileIdToDelete });
      if (selectedFileId === fileIdToDelete) {
        setSelectedFileId(null);
      }
      setActivePageId(null);
      clearSelection();
    } catch {
      // error surfaced by TanStack Query
    } finally {
      setFileIdToDelete(null);
    }
  }, [fileIdToDelete, sessionId, removePdfFile, selectedFileId, clearSelection]);

  const fileToDelete = useMemo(
    () => fileMetadata.find((f) => f.fileId === fileIdToDelete) ?? null,
    [fileMetadata, fileIdToDelete],
  );

  const previewPage = useMemo(() => {
    if (!previewPageId) return null;
    return localManifest.find((p: PageManifestEntry) => p.pageId === previewPageId) ?? null;
  }, [previewPageId, localManifest]);

  const previewFileName = useMemo(() => {
    if (!previewPage) return '';
    const file = fileMetadata.find((f) => f.fileId === previewPage.fileId);
    return file?.originalName ?? 'Unknown';
  }, [previewPage, fileMetadata]);

  const isEmpty = fileMetadata.length === 0;

  return (
    <div className={styles.container} data-testid="pdf-assembly-view">
      {/* Header — full when empty, compact when files present to maximize preview */}
      <div className={isEmpty ? styles.header : styles.headerCompact}>
        {isEmpty ? (
          <>
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
          </>
        ) : (
          <>
            <h1 className={styles.headingCompact}>PDF Tools</h1>
            <span className={styles.sessionBadge}>
              <span className={styles.sessionDot} />
              Session active
            </span>
          </>
        )}
      </div>

      {/* Hero (empty) — centred single column */}
      {isEmpty ? (
        <div className={styles.heroWrapper}>
          <PdfDocumentSidebar
            fileMetadata={fileMetadata}
            selectedFileId={selectedFileId}
            onSelectFile={setSelectedFileId}
            onRemoveFile={handleRemoveFileClick}
            hero
            dragActive={dragActive}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDropzoneClick={handleDropzoneClick}
            inputRef={inputRef}
            onInputChange={handleInputChange}
            isUploading={isUploading}
            createSessionPending={createSession.isPending}
            errors={errors}
            sessionLimitError={createSession.error?.code === 'SESSION_LIMIT_REACHED'}
          />
        </div>
      ) : (
        /* Two-column body: sidebar (docs + page thumbnails) | main (toolbar + preview) */
        <div className={styles.body}>
          <PdfDocumentSidebar
            fileMetadata={fileMetadata}
            selectedFileId={selectedFileId}
            onSelectFile={setSelectedFileId}
            onRemoveFile={handleRemoveFileClick}
            dragActive={dragActive}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDropzoneClick={handleDropzoneClick}
            inputRef={inputRef}
            onInputChange={handleInputChange}
            isUploading={isUploading}
            createSessionPending={createSession.isPending}
            errors={errors}
            sessionLimitError={createSession.error?.code === 'SESSION_LIMIT_REACHED'}
          >
            {sessionId && docVisiblePages.length > 0 && (
              <PageThumbnailGrid
                sessionId={sessionId}
                pageManifest={docFilteredManifest}
                fileMetadata={selectedFileMetadata}
                onPreview={handlePreview}
                isSelected={isSelected}
                onSelect={handlePageSelect}
                onReorder={handleDocReorder}
              />
            )}
          </PdfDocumentSidebar>

          <div className={styles.mainColumn} data-testid="pdf-thumbnails-section">
            {sessionId && docVisiblePages.length > 0 && (
              <section className={styles.previewSection} aria-label="Page preview">
                <ManipulationToolbar
                  selectedCount={selectedCount}
                  onRotate={handleRotate}
                  onDelete={handleDeleteClick}
                  onMoveUp={handleMoveUp}
                  onMoveDown={handleMoveDown}
                  canMoveUp={canMoveUp}
                  canMoveDown={canMoveDown}
                  totalPages={docVisiblePages.length}
                  onSave={saveNow}
                  hasUnsavedChanges={hasUnsavedChanges}
                />
                <PdfInlinePreview
                  sessionId={sessionId}
                  fileId={activePreviewPage?.fileId ?? null}
                  sourcePageIndex={activePreviewPage?.sourcePageIndex ?? 0}
                  rotation={activePreviewPage?.rotation ?? 0}
                  sourceFileName={activePreviewFileName}
                  originalPageNumber={(activePreviewPage?.sourcePageIndex ?? 0) + 1}
                />
              </section>
            )}
          </div>
        </div>
      )}

      {/* Overlays */}
      {undoState && (
        <UndoSnackbar
          message={`${undoState.deletedCount} ${undoState.deletedCount === 1 ? 'page' : 'pages'} deleted`}
          onUndo={undoDelete}
          onDismiss={handleDismissUndo}
        />
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

      {showDeleteConfirm && (
        <ConfirmDeleteModal
          title="Delete Pages"
          itemName={`${selectedCount} selected ${selectedCount === 1 ? 'page' : 'pages'}`}
          description={`Delete ${selectedCount} selected ${selectedCount === 1 ? 'page' : 'pages'}? This action can be undone.`}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {fileIdToDelete && fileToDelete && (
        <ConfirmDeleteModal
          title="Remove Document"
          itemName={fileToDelete.originalName}
          description={`Remove "${fileToDelete.originalName}" and all its pages from this session? This cannot be undone.`}
          onConfirm={handleRemoveFileConfirm}
          onCancel={() => setFileIdToDelete(null)}
        />
      )}

      {deleteBlockedMessage && (
        <div className={styles.errorToast} role="alert" data-testid="delete-blocked-error">
          <span className={styles.errorToastIcon}>⚠️</span>
          <span className={styles.errorToastText}>{deleteBlockedMessage}</span>
          <button
            className={styles.errorToastDismiss}
            onClick={() => setDeleteBlockedMessage(null)}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {reorderSyncError && (
        <div className={styles.errorToast} role="alert" data-testid="reorder-sync-error">
          <span className={styles.errorToastIcon}>⚠️</span>
          <span className={styles.errorToastText}>{reorderSyncError}</span>
          <button
            className={styles.errorToastDismiss}
            onClick={dismissReorderSyncError}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
};

export default PdfAssemblyView;
