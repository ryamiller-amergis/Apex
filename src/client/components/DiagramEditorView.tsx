import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppShell } from '../hooks/useAppShell';
import { useDiagramEditor } from '../hooks/useDiagramEditor';
import type { ExcalidrawAdapterHandle } from './ExcalidrawAdapter';
import { ExcalidrawAdapter } from './ExcalidrawAdapter';
import { DiagramExportMenu } from './DiagramExportMenu';
import { DiagramTitleEditor } from './DiagramTitleEditor';
import { ShareDiagramDialog } from './ShareDiagramDialog';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';
import { VersionConflictDialog } from './VersionConflictDialog';
import styles from './DiagramEditorView.module.css';

interface DiagramEditorViewProps {
  projectId: string;
  diagramId: string | null;
  mode: 'new' | 'existing';
}

export const DiagramEditorView: React.FC<DiagramEditorViewProps> = ({
  projectId,
  diagramId,
  mode,
}) => {
  const navigate = useNavigate();
  const { can } = useAppShell();
  const canCreate = can('diagram:create');
  const canEdit = can('diagram:edit');
  const canShare = can('diagram:share');
  const adapterRef = useRef<ExcalidrawAdapterHandle | null>(null);
  const [isReloading, setIsReloading] = useState(false);
  const [showConflict, setShowConflict] = useState(false);
  const [showShare, setShowShare] = useState(false);
  /** Pending in-app leave path while dirty — Apex uses BrowserRouter, so useBlocker is unavailable. */
  const [pendingLeavePath, setPendingLeavePath] = useState<string | null>(null);

  const editor = useDiagramEditor({
    projectId,
    diagramId,
    mode,
    canCreate,
    canEdit,
    getThumbnailSource: () => adapterRef.current?.getThumbnailSource?.() ?? null,
    getLiveScene: () => adapterRef.current?.getLiveScene?.() ?? null,
  });

  const viewOnly = mode === 'existing' && editor.effectiveAccess === 'view';
  const editable = mode === 'new'
    ? canCreate
    : canEdit && editor.effectiveAccess !== 'view' && editor.effectiveAccess != null;
  const showSaveControl = mode === 'new' ? canCreate : true;
  /** Discard/leave warnings only when the actor can persist edits (not view-only pan/zoom). */
  const hasUnsavedEdits = editable && editor.isDirty;

  const showShareControl = mode === 'existing'
    && Boolean(diagramId)
    && canShare
    && editor.effectiveAccess === 'owner';

  const requestNavigate = useCallback((path: string) => {
    if (hasUnsavedEdits) {
      setPendingLeavePath(path);
      return;
    }
    navigate(path);
  }, [hasUnsavedEdits, navigate]);

  useEffect(() => {
    if (!hasUnsavedEdits) return undefined;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedEdits]);

  useEffect(() => {
    if (editor.saveErrorKind === 'conflict') {
      setShowConflict(true);
    }
  }, [editor.saveErrorKind]);

  const handleSave = useCallback(async () => {
    const detail = await editor.save();
    if (detail && mode === 'new' && detail.id) {
      navigate(`/diagrams/${detail.id}`, { replace: true });
    }
  }, [editor, mode, navigate]);

  const handleReload = useCallback(async () => {
    setIsReloading(true);
    try {
      await editor.reload();
      setShowConflict(false);
    } finally {
      setIsReloading(false);
    }
  }, [editor]);

  if (editor.isLoading) {
    return (
      <div className={styles.page} {...{ 'data-testid': 'diagram-editor-loading' }}>
        Loading Diagram…
      </div>
    );
  }

  if (editor.isAccessDenied || editor.saveErrorKind === 'forbidden') {
    return (
      <div
        className={styles.page}
        role="alert"
        aria-live="assertive"
        {...{ 'data-testid': 'diagram-access-denied' }}
      >
        <p>{editor.loadError || editor.saveError || 'You no longer have access to this Diagram.'}</p>
        <button
          type="button"
          className={styles.secondaryBtn}
          onClick={() => navigate('/diagrams')}
          {...{ 'data-testid': 'diagram-editor-back' }}
        >
          Back to Diagrams
        </button>
      </div>
    );
  }

  if (editor.loadError) {
    return (
      <div className={styles.page} role="alert" {...{ 'data-testid': 'diagram-editor-load-error' }}>
        <p>{editor.loadError}</p>
        <button
          type="button"
          className={styles.secondaryBtn}
          onClick={() => navigate('/diagrams')}
          {...{ 'data-testid': 'diagram-editor-back' }}
        >
          Back to Diagrams
        </button>
      </div>
    );
  }

  return (
    <div
      className={styles.page}
      {...{
        'data-testid': viewOnly ? 'diagram-editor-readonly' : 'diagram-editor',
      }}
    >
      <header className={styles.toolbar}>
        <button
          type="button"
          className={styles.secondaryBtn}
          onClick={() => requestNavigate('/diagrams')}
          {...{ 'data-testid': 'diagram-editor-back' }}
        >
          Back
        </button>

        <DiagramTitleEditor
          title={editor.title}
          onTitleChange={editor.setTitle}
          editable={editable}
        />

        <div className={styles.toolbarActions}>
          {viewOnly && (
            <span
              className={styles.unsaved}
              aria-live="polite"
              {...{ 'data-testid': 'diagram-view-only-label' }}
            >
              View only
            </span>
          )}

          <DiagramExportMenu
            title={editor.title}
            exportPng={async () => {
              if (!adapterRef.current) throw new Error('Canvas is not ready');
              return adapterRef.current.exportPng();
            }}
            exportSvg={async () => {
              if (!adapterRef.current) throw new Error('Canvas is not ready');
              return adapterRef.current.exportSvg();
            }}
            exportNativeJson={async () => {
              if (!adapterRef.current) throw new Error('Canvas is not ready');
              return adapterRef.current.exportNativeJson();
            }}
            {...{ 'data-testid': 'diagram-export-menu' }}
          />

          {showShareControl && (
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => setShowShare(true)}
              aria-label="Share Diagram"
              {...{ 'data-testid': 'diagram-share-button' }}
            >
              Share
            </button>
          )}

          {hasUnsavedEdits && (
            <span
              className={styles.unsaved}
              aria-live="polite"
              {...{ 'data-testid': 'diagram-unsaved-indicator' }}
            >
              Unsaved changes
            </span>
          )}

          {showSaveControl && (
            <button
              type="button"
              className={styles.saveBtn}
              onClick={() => { void handleSave(); }}
              disabled={!editable || !editor.isDirty || editor.isSaving}
              aria-disabled={!editable || !editor.isDirty || editor.isSaving}
              aria-label={editable ? 'Save Diagram' : 'Save unavailable — view only'}
              {...{ 'data-testid': 'diagram-save-button' }}
            >
              {editor.isSaving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </header>

      {editor.saveError && editor.saveErrorKind !== 'conflict' && (
        <div
          className={styles.errorBanner}
          role="alert"
          {...{ 'data-testid': 'diagram-save-error' }}
        >
          {editor.saveError}
        </div>
      )}

      <div className={styles.canvasWrap}>
        <ExcalidrawAdapter
          key={mode === 'existing' ? `diagram-${editor.diagramId ?? 'pending'}` : 'diagram-new'}
          ref={adapterRef}
          scene={editor.scene}
          editable={editable}
          onSceneChange={editor.onSceneChange}
          onCanvasHydrated={editor.onCanvasHydrated}
        />
      </div>

      {pendingLeavePath && (
        <UnsavedChangesDialog
          onStay={() => setPendingLeavePath(null)}
          onDiscard={() => {
            const path = pendingLeavePath;
            setPendingLeavePath(null);
            navigate(path);
          }}
          {...{ 'data-testid': 'diagram-unsaved-dialog' }}
        />
      )}

      {showConflict && (
        <VersionConflictDialog
          isReloading={isReloading}
          onDismiss={() => {
            setShowConflict(false);
            editor.clearSaveError();
          }}
          onReload={() => { void handleReload(); }}
          {...{ 'data-testid': 'diagram-conflict-dialog' }}
        />
      )}

      {showShare && diagramId && (
        <ShareDiagramDialog
          projectId={projectId}
          diagramId={diagramId}
          diagramTitle={editor.title}
          onClose={() => setShowShare(false)}
          {...{ 'data-testid': 'share-diagram-dialog' }}
        />
      )}
    </div>
  );
};

export default DiagramEditorView;
