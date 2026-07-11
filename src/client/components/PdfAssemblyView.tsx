import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useCreatePdfSession, usePdfSession, useUploadPdfFiles, useActivePdfSessions, useRemovePdfFile } from '../hooks/usePdfSession';
import { usePageManipulation } from '../hooks/usePageManipulation';
import { usePageSelection } from '../hooks/usePageSelection';
import { useDocumentColors } from '../hooks/useDocumentColors';
import { PdfWorkerProvider } from '../contexts/PdfWorkerContext';
import { SourceBrowser } from './SourceBrowser';
import { AssemblyLane } from './AssemblyLane';
import { PagePreviewModal } from './PagePreviewModal';
import { UndoSnackbar } from './UndoSnackbar';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { PdfDocumentSidebar } from './PdfDocumentSidebar';
import { PdfInlinePreview } from './PdfInlinePreview';
import { ExportPanel } from './ExportPanel';
import { ExportSelectedButton } from './ExportSelectedButton';
import { RangeInput } from './RangeInput';
import { DeduplicationToast } from './DeduplicationToast';
import { generateDefaultFilename } from '../hooks/useExportSession';
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
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [fileIdToDelete, setFileIdToDelete] = useState<string | null>(null);
  const [justMovedPageId, setJustMovedPageId] = useState<string | null>(null);
  const [convertingFiles, setConvertingFiles] = useState<string[]>([]);
  const justMovedTimerRef = useRef<number | null>(null);
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

  const handleDismissUploadError = useCallback((error: FileUploadResult) => {
    setUploadResults((current) => current.filter((result) => result !== error));
  }, []);

  const handleFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;

    let activeSessionId = sessionId;
    const wordFilenames = files
      .filter((file) => file.name.toLowerCase().endsWith('.docx'))
      .map((file) => file.name);

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

    if (wordFilenames.length > 0) {
      setConvertingFiles((current) => [...current, ...wordFilenames]);
    }

    try {
      const result = await uploadFiles.mutateAsync({ sessionId: activeSessionId, files });
      setUploadResults((prev) => [...prev, ...result.files]);
    } catch {
      // mutation error handled by TanStack Query
    } finally {
      if (wordFilenames.length > 0) {
        setConvertingFiles((current) => {
          const remaining = [...current];
          for (const filename of wordFilenames) {
            const index = remaining.indexOf(filename);
            if (index >= 0) remaining.splice(index, 1);
          }
          return remaining;
        });
      }
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
    reorderSyncError,
    dismissReorderSyncError,
    rotate,
    deletePages,
    undoDelete,
    undoState,
    undoReorder,
    undoReorderState,
    dismissReorderUndo,
    hasUnsavedChanges,
    saveNow,
    saveNowAsync,
    syncDelete,
    togglePageInAssembly,
    addToAssemblyAt,
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
    selectAll,
  } = usePageSelection();

  const [showDedupToast, setShowDedupToast] = useState(false);
  const [rangeExternalUpdate, setRangeExternalUpdate] = useState(0);
  const [exportFilename, setExportFilename] = useState(() => generateDefaultFilename());

  const ensureManifestSaved = useCallback(async () => {
    if (hasUnsavedChanges) {
      await saveNowAsync();
    }
  }, [hasUnsavedChanges, saveNowAsync]);

  const handleRangeSelectionChange = useCallback(
    (indices: number[], hasDuplicates: boolean) => {
      if (hasDuplicates) {
        setShowDedupToast(true);
      }
      const pageIds = indices
        .map((i) => manipulationVisiblePages[i]?.pageId)
        .filter(Boolean) as string[];
      if (pageIds.length > 0) {
        selectAll(pageIds);
      } else {
        clearSelection();
      }
    },
    [manipulationVisiblePages, clearSelection, selectAll],
  );

  const documentColors = useDocumentColors(fileMetadata);

  const isPageInAssembly = useCallback(
    (pageId: string) => {
      const page = localManifest.find((p) => p.pageId === pageId);
      return page ? !page.deleted : false;
    },
    [localManifest],
  );

  const handleTogglePageInAssembly = useCallback(
    (pageId: string) => {
      togglePageInAssembly(pageId);
    },
    [togglePageInAssembly],
  );

  const handleAddFromSource = useCallback(
    (pageId: string, insertIndex: number) => {
      addToAssemblyAt(pageId, insertIndex);
    },
    [addToAssemblyAt],
  );

  const allVisiblePageIds = useMemo(
    () => manipulationVisiblePages.map((p) => p.pageId),
    [manipulationVisiblePages],
  );

  const selectedIndicesForRange = useMemo(
    () =>
      [...selectedPageIds]
        .map((id) => manipulationVisiblePages.findIndex((p) => p.pageId === id))
        .filter((i) => i >= 0)
        .sort((a, b) => a - b),
    [selectedPageIds, manipulationVisiblePages],
  );

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

  const flashMoved = useCallback((pageId: string) => {
    if (justMovedTimerRef.current !== null) clearTimeout(justMovedTimerRef.current);
    setJustMovedPageId(pageId);
    justMovedTimerRef.current = window.setTimeout(() => {
      setJustMovedPageId(null);
      justMovedTimerRef.current = null;
    }, 700);
  }, []);

  const handleMoveUp = useCallback(() => {
    if (selectedPageIds.size !== 1) return;
    const pageId = [...selectedPageIds][0];
    const idx = manipulationVisiblePages.findIndex((p) => p.pageId === pageId);
    if (idx > 0) {
      reorder(idx, idx - 1);
      flashMoved(pageId);
    }
  }, [selectedPageIds, manipulationVisiblePages, reorder, flashMoved]);

  const handleMoveDown = useCallback(() => {
    if (selectedPageIds.size !== 1) return;
    const pageId = [...selectedPageIds][0];
    const idx = manipulationVisiblePages.findIndex((p) => p.pageId === pageId);
    if (idx < manipulationVisiblePages.length - 1) {
      reorder(idx, idx + 1);
      flashMoved(pageId);
    }
  }, [selectedPageIds, manipulationVisiblePages, reorder, flashMoved]);

  const singleSelectedGlobalIndex = useMemo(() => {
    if (selectedPageIds.size !== 1) return -1;
    const pageId = [...selectedPageIds][0];
    return manipulationVisiblePages.findIndex((p) => p.pageId === pageId);
  }, [selectedPageIds, manipulationVisiblePages]);

  const canMoveUp = singleSelectedGlobalIndex > 0;
  const canMoveDown = singleSelectedGlobalIndex >= 0 && singleSelectedGlobalIndex < manipulationVisiblePages.length - 1;

  const handleReorder = useCallback((fromIdx: number, toIdx: number) => {
    reorder(fromIdx, toIdx);
  }, [reorder]);

  const handlePageSelect = useCallback(
    (pageId: string, shiftKey: boolean, ctrlKey: boolean) => {
      if (shiftKey) {
        rangeSelect(pageId, allVisiblePageIds);
      } else if (ctrlKey) {
        multiToggle(pageId);
      } else {
        toggleSelection(pageId);
        setActivePageId(pageId);
      }
      setRangeExternalUpdate((c) => c + 1);
    },
    [toggleSelection, multiToggle, rangeSelect, allVisiblePageIds],
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
      setActivePageId(null);
      clearSelection();
    } catch {
      // error surfaced by TanStack Query
    } finally {
      setFileIdToDelete(null);
    }
  }, [fileIdToDelete, sessionId, removePdfFile, clearSelection]);

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
            selectedFileId={null}
            onSelectFile={() => {}}
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
            convertingFiles={convertingFiles}
            errors={errors}
            onDismissError={handleDismissUploadError}
            sessionLimitError={createSession.error?.code === 'SESSION_LIMIT_REACHED'}
          />
        </div>
      ) : (
        /* Three-panel body: SourceBrowser (left) | AssemblyLane (center) | Preview (right) */
        <PdfWorkerProvider>
        <div className={styles.body}>
          <SourceBrowser
            fileMetadata={fileMetadata}
            localManifest={localManifest}
            sessionId={sessionId!}
            documentColors={documentColors}
            isPageInAssembly={isPageInAssembly}
            onTogglePageInAssembly={handleTogglePageInAssembly}
            dragActive={dragActive}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDropzoneClick={handleDropzoneClick}
            inputRef={inputRef}
            onInputChange={handleInputChange}
            isUploading={isUploading}
            createSessionPending={createSession.isPending}
            convertingFiles={convertingFiles}
            errors={errors}
            onDismissError={handleDismissUploadError}
            sessionLimitError={createSession.error?.code === 'SESSION_LIMIT_REACHED'}
            onRemoveFile={handleRemoveFileClick}
          />

          <AssemblyLane
            sessionId={sessionId!}
            localManifest={localManifest}
            visiblePages={manipulationVisiblePages}
            fileMetadata={fileMetadata}
            documentColors={documentColors}
            isSelected={isSelected}
            selectedCount={selectedCount}
            onSelect={handlePageSelect}
            onReorder={handleReorder}
            onRotate={handleRotate}
            onDelete={handleDeleteClick}
            onMoveUp={handleMoveUp}
            onMoveDown={handleMoveDown}
            canMoveUp={canMoveUp}
            canMoveDown={canMoveDown}
            onSave={saveNow}
            hasUnsavedChanges={hasUnsavedChanges}
            activePageId={activePageId}
            onActivePage={setActivePageId}
            onPreview={handlePreview}
            justMovedPageId={justMovedPageId}
            onAddFromSource={handleAddFromSource}
          />

          <div className={styles.previewPanel} role="complementary" aria-label="Page preview">
            <PdfInlinePreview
              sessionId={sessionId!}
              fileId={activePreviewPage?.fileId ?? null}
              sourcePageIndex={activePreviewPage?.sourcePageIndex ?? 0}
              rotation={activePreviewPage?.rotation ?? 0}
              sourceFileName={activePreviewFileName}
              originalPageNumber={(activePreviewPage?.sourcePageIndex ?? 0) + 1}
            />
          </div>
        </div>
        <div className={styles.exportBar} data-testid="pdf-export-bar">
          <ExportPanel
            sessionId={sessionId!}
            nonDeletedPageCount={manipulationVisiblePages.length}
            filename={exportFilename}
            onFilenameChange={setExportFilename}
            onBeforeExport={ensureManifestSaved}
          />
          <div className={styles.exportBarGroup}>
            <RangeInput
              maxPage={manipulationVisiblePages.length}
              selectedIndices={selectedIndicesForRange}
              onSelectionChange={handleRangeSelectionChange}
              externalUpdate={rangeExternalUpdate}
            />
            <ExportSelectedButton
              sessionId={sessionId!}
              selectedCount={selectedCount}
              selectedPageIndices={selectedIndicesForRange}
              filename={exportFilename}
              onBeforeExport={ensureManifestSaved}
              onExportComplete={clearSelection}
            />
          </div>
        </div>
        </PdfWorkerProvider>
      )}

      {/* Overlays */}
      {undoState && (
        <UndoSnackbar
          message={`${undoState.deletedCount} ${undoState.deletedCount === 1 ? 'page' : 'pages'} deleted`}
          onUndo={undoDelete}
          onDismiss={handleDismissUndo}
        />
      )}

      {undoReorderState && !undoState && (
        <UndoSnackbar
          message="Page order changed"
          onUndo={undoReorder}
          onDismiss={dismissReorderUndo}
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

      <DeduplicationToast
        visible={showDedupToast}
        onDismiss={() => setShowDedupToast(false)}
      />
    </div>
  );
};

export default PdfAssemblyView;
