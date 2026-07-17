import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import {
  useCreatePdfSession,
  usePdfSession,
  useUploadPdfFiles,
  useActivePdfSessions,
  useRemovePdfFile,
  type PdfApiError,
  type PdfUploadProgress,
} from '../hooks/usePdfSession';
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
import { pdfFileUrl } from '../utils/pdfUrls';
import type {
  FileUploadResult,
  PageManifestEntry,
  PdfConversionJob,
  UploadFilesResponse,
} from '../../shared/types/pdf';
import styles from './PdfAssemblyView.module.css';

const MIN_ASSEMBLY_PANE_PERCENT = 30;
const MAX_ASSEMBLY_PANE_PERCENT = 75;
const DEFAULT_ASSEMBLY_PANE_PERCENT = 50;
const PDF_SESSION_STORAGE_KEY = 'pdf-active-session';

interface PdfAssemblyViewProps {
  userId?: string;
}

function getPdfSessionStorageKey(userId: string): string {
  return userId ? `${PDF_SESSION_STORAGE_KEY}:${userId}` : PDF_SESSION_STORAGE_KEY;
}

function isUnavailableSessionError(error: unknown): error is PdfApiError {
  const status = (error as PdfApiError | null)?.status;
  // 403 = session belongs to another user (common after switching mock/dev accounts)
  return status === 403 || status === 404 || status === 410;
}

export const PdfAssemblyView: React.FC<PdfAssemblyViewProps> = ({ userId = '' }) => {
  const storageKey = getPdfSessionStorageKey(userId);
  const [sessionId, setSessionId] = useState<string | null>(
    () => sessionStorage.getItem(storageKey),
  );
  const [isSourceBrowserCollapsed, setIsSourceBrowserCollapsed] = useState(false);
  const [assemblyPanePercent, setAssemblyPanePercent] = useState(
    DEFAULT_ASSEMBLY_PANE_PERCENT,
  );
  const [isResizingWorkspace, setIsResizingWorkspace] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [uploadResults, setUploadResults] = useState<FileUploadResult[]>([]);
  const [previewPageId, setPreviewPageId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteBlockedMessage, setDeleteBlockedMessage] = useState<string | null>(null);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [fileIdToDelete, setFileIdToDelete] = useState<string | null>(null);
  const [justMovedPageId, setJustMovedPageId] = useState<string | null>(null);
  const [dismissedConversionIds, setDismissedConversionIds] = useState<Set<string>>(new Set());
  const [uploadProgress, setUploadProgress] = useState<PdfUploadProgress | null>(null);
  const justMovedTimerRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const workspacePanelsRef = useRef<HTMLDivElement>(null);

  const createSession = useCreatePdfSession(userId);
  const { data: session, error: sessionError } = usePdfSession(sessionId, userId);
  const uploadFiles = useUploadPdfFiles(userId);
  const { data: activeSessions } = useActivePdfSessions(userId);
  const removePdfFile = useRemovePdfFile(userId);

  useEffect(() => {
    // Remove the legacy cross-user key. User-scoped keys are the only source
    // of persisted PDF session identity from this point forward.
    if (userId) sessionStorage.removeItem(PDF_SESSION_STORAGE_KEY);
  }, [userId]);

  useEffect(() => {
    if (sessionId) return;
    if (activeSessions && activeSessions.length > 0) {
      const mostRecent = activeSessions[0];
      setSessionId(mostRecent.id);
      sessionStorage.setItem(storageKey, mostRecent.id);
    }
  }, [sessionId, activeSessions, storageKey]);

  useEffect(() => {
    if (!sessionId || !isUnavailableSessionError(sessionError)) return;
    sessionStorage.removeItem(storageKey);
    setSessionId(null);
  }, [sessionError, sessionId, storageKey]);

  const conversionJobs = useMemo<PdfConversionJob[]>(() => {
    const serverJobs = session?.conversionJobs ?? [];
    const serverJobIds = new Set(serverJobs.map((job) => job.id));
    const optimisticJobs: PdfConversionJob[] = uploadResults
      .filter((result) =>
        result.status === 'queued' &&
        !!result.conversionId &&
        !serverJobIds.has(result.conversionId))
      .map((result) => ({
        id: result.conversionId!,
        sessionId: sessionId ?? '',
        originalName: result.originalName,
        status: 'queued',
        createdAt: new Date().toISOString(),
      }));
    return [...serverJobs, ...optimisticJobs];
  }, [session?.conversionJobs, sessionId, uploadResults]);

  const errors = useMemo(() => {
    const uploadErrors = uploadResults.filter((result) => result.status === 'error');
    const conversionErrors: FileUploadResult[] = conversionJobs
      .filter((job) => job.status === 'failed' && !dismissedConversionIds.has(job.id))
      .map((job) => ({
        conversionId: job.id,
        originalName: job.originalName,
        status: 'error',
        error: job.error ?? {
          code: 'CONVERSION_FAILED',
          message: 'This Word document could not be converted.',
        },
      }));
    return [...uploadErrors, ...conversionErrors];
  }, [conversionJobs, dismissedConversionIds, uploadResults]);

  const handleDismissUploadError = useCallback((error: FileUploadResult) => {
    setUploadResults((current) => current.filter((result) => result !== error));
    if (error.conversionId) {
      setDismissedConversionIds((current) => new Set(current).add(error.conversionId!));
    }
  }, []);

  const handleFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;

    let activeSessionId = sessionId;
    const startFreshSession = async () => {
      const result = await createSession.mutateAsync({});
      activeSessionId = result.sessionId;
      setSessionId(activeSessionId);
      sessionStorage.setItem(storageKey, activeSessionId);
    };

    try {
      if (!activeSessionId) await startFreshSession();

      let result: UploadFilesResponse;
      try {
        result = await uploadFiles.mutateAsync({
          sessionId: activeSessionId!,
          files,
          onProgress: setUploadProgress,
        });
      } catch (error) {
        if (!isUnavailableSessionError(error)) throw error;
        sessionStorage.removeItem(storageKey);
        await startFreshSession();
        result = await uploadFiles.mutateAsync({
          sessionId: activeSessionId!,
          files,
          onProgress: setUploadProgress,
        });
      }
      setUploadResults((prev) => [...prev, ...result.files]);
    } catch {
      // mutation error handled by TanStack Query
    } finally {
      setUploadProgress(null);
    }
  }, [sessionId, createSession, uploadFiles, storageKey]);

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
    userId,
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

  const handleStartNewSession = useCallback(async () => {
    try {
      await ensureManifestSaved();
      const result = await createSession.mutateAsync({
        ...(sessionId ? { replaceSessionId: sessionId } : {}),
      });

      setSessionId(result.sessionId);
      sessionStorage.setItem(storageKey, result.sessionId);
      setUploadResults([]);
      setDismissedConversionIds(new Set());
      setUploadProgress(null);
      setPreviewPageId(null);
      setActivePageId(null);
      setFileIdToDelete(null);
      setShowDeleteConfirm(false);
      setDeleteBlockedMessage(null);
      setJustMovedPageId(null);
      setShowDedupToast(false);
      setRangeExternalUpdate((count) => count + 1);
      setExportFilename(generateDefaultFilename());
      setIsSourceBrowserCollapsed(false);
      clearSelection();
    } catch {
      // Mutation errors are surfaced by the existing session error UI.
    }
  }, [clearSelection, createSession, ensureManifestSaved, sessionId, storageKey]);

  const handleExportComplete = useCallback(() => {
    void handleStartNewSession();
  }, [handleStartNewSession]);

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

  const handleSelectAllPages = useCallback(() => {
    selectAll(allVisiblePageIds);
    setRangeExternalUpdate((count) => count + 1);
  }, [allVisiblePageIds, selectAll]);

  const handleDeselectAllPages = useCallback(() => {
    clearSelection();
    setRangeExternalUpdate((count) => count + 1);
  }, [clearSelection]);

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

  const updateAssemblyPanePercent = useCallback((clientX: number) => {
    const workspace = workspacePanelsRef.current;
    if (!workspace) return;

    const rect = workspace.getBoundingClientRect();
    if (rect.width <= 0) return;

    const nextPercent = ((clientX - rect.left) / rect.width) * 100;
    setAssemblyPanePercent(
      Math.min(
        MAX_ASSEMBLY_PANE_PERCENT,
        Math.max(MIN_ASSEMBLY_PANE_PERCENT, Math.round(nextPercent)),
      ),
    );
  }, []);

  const handleWorkspaceResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setIsResizingWorkspace(true);
      updateAssemblyPanePercent(event.clientX);
    },
    [updateAssemblyPanePercent],
  );

  const handleWorkspaceResizePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isResizingWorkspace) return;
      updateAssemblyPanePercent(event.clientX);
    },
    [isResizingWorkspace, updateAssemblyPanePercent],
  );

  const handleWorkspaceResizePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isResizingWorkspace) return;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      setIsResizingWorkspace(false);
    },
    [isResizingWorkspace],
  );

  const handleWorkspaceResizeKeyDown = useCallback((event: React.KeyboardEvent) => {
    let nextPercent: number | null = null;
    if (event.key === 'ArrowLeft') nextPercent = assemblyPanePercent - 5;
    if (event.key === 'ArrowRight') nextPercent = assemblyPanePercent + 5;
    if (event.key === 'Home') nextPercent = MIN_ASSEMBLY_PANE_PERCENT;
    if (event.key === 'End') nextPercent = MAX_ASSEMBLY_PANE_PERCENT;
    if (nextPercent === null) return;

    event.preventDefault();
    setAssemblyPanePercent(
      Math.min(
        MAX_ASSEMBLY_PANE_PERCENT,
        Math.max(MIN_ASSEMBLY_PANE_PERCENT, nextPercent),
      ),
    );
  }, [assemblyPanePercent]);

  return (
    <div className={styles.container} data-testid="pdf-assembly-view">
      {/* Header — full when empty, compact when files present to maximize preview */}
      <div className={isEmpty ? styles.header : styles.headerCompact}>
        {isEmpty ? (
          <>
            <div className={styles.headerLeft}>
              <h1 className={styles.heading}>PDF Assembly Tool</h1>
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
            <h1 className={styles.headingCompact}>PDF Assembly Tool</h1>
            <div className={styles.headerActions}>
              <button
                type="button"
                className={styles.headerButton}
                onClick={() => setIsSourceBrowserCollapsed((collapsed) => !collapsed)}
                aria-expanded={!isSourceBrowserCollapsed}
                aria-controls="pdf-source-browser"
                aria-label={isSourceBrowserCollapsed ? 'Show source documents' : 'Hide source documents'}
                title={isSourceBrowserCollapsed ? 'Show source documents' : 'Hide source documents'}
                data-testid="pdf-toggle-source-browser"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <path d="M9 4v16" />
                  <path d={isSourceBrowserCollapsed ? 'm13 9 3 3-3 3' : 'm16 9-3 3 3 3'} />
                </svg>
                {isSourceBrowserCollapsed ? 'Show sources' : 'Hide sources'}
              </button>
              <button
                type="button"
                className={styles.headerButton}
                onClick={handleStartNewSession}
                disabled={createSession.isPending}
                data-testid="pdf-new-session"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                {createSession.isPending ? 'Starting…' : 'New session'}
              </button>
              <span className={styles.sessionBadge}>
                <span className={styles.sessionDot} />
                Session active
              </span>
            </div>
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
            uploadProgress={uploadProgress}
            conversionJobs={conversionJobs}
            errors={errors}
            onDismissError={handleDismissUploadError}
            sessionLimitError={createSession.error?.code === 'SESSION_LIMIT_REACHED'}
          />
        </div>
      ) : (
        /* Three-panel body: SourceBrowser (left) | AssemblyLane (center) | Preview (right) */
        <PdfWorkerProvider>
        <div className={styles.body}>
          {!isSourceBrowserCollapsed && (
            <div id="pdf-source-browser" className={styles.sourceBrowserPanel}>
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
                uploadProgress={uploadProgress}
                conversionJobs={conversionJobs}
                errors={errors}
                onDismissError={handleDismissUploadError}
                sessionLimitError={createSession.error?.code === 'SESSION_LIMIT_REACHED'}
                onRemoveFile={handleRemoveFileClick}
              />
            </div>
          )}

          <div
            ref={workspacePanelsRef}
            className={`${styles.workspacePanels} ${isResizingWorkspace ? styles.workspaceResizing : ''}`}
          >
            <div
              className={styles.assemblyPanel}
              style={{ flexBasis: `${assemblyPanePercent}%` }}
            >
              <AssemblyLane
                sessionId={sessionId!}
                localManifest={localManifest}
                visiblePages={manipulationVisiblePages}
                fileMetadata={fileMetadata}
                documentColors={documentColors}
                isSelected={isSelected}
                selectedCount={selectedCount}
                onSelectAll={handleSelectAllPages}
                onDeselectAll={handleDeselectAllPages}
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
            </div>

            <div
              className={styles.workspaceDivider}
              role="separator"
              aria-label="Resize assembly and preview panels"
              aria-orientation="vertical"
              aria-valuemin={MIN_ASSEMBLY_PANE_PERCENT}
              aria-valuemax={MAX_ASSEMBLY_PANE_PERCENT}
              aria-valuenow={assemblyPanePercent}
              aria-valuetext={`Assembly lane ${assemblyPanePercent}%`}
              tabIndex={0}
              onPointerDown={handleWorkspaceResizePointerDown}
              onPointerMove={handleWorkspaceResizePointerMove}
              onPointerUp={handleWorkspaceResizePointerUp}
              onPointerCancel={handleWorkspaceResizePointerUp}
              onKeyDown={handleWorkspaceResizeKeyDown}
              onDoubleClick={() => setAssemblyPanePercent(DEFAULT_ASSEMBLY_PANE_PERCENT)}
              data-testid="pdf-workspace-divider"
            >
              <span className={styles.workspaceDividerHandle} aria-hidden="true" />
            </div>

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
        </div>
        <div className={styles.exportBar} data-testid="pdf-export-bar">
          <ExportPanel
            sessionId={sessionId!}
            nonDeletedPageCount={manipulationVisiblePages.length}
            filename={exportFilename}
            onFilenameChange={setExportFilename}
            onBeforeExport={ensureManifestSaved}
            onExportComplete={handleExportComplete}
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
          fileUrl={pdfFileUrl(sessionId, previewPage.fileId)}
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
