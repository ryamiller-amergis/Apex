import React, { useCallback, useRef } from 'react';
import type { OverlayTextBox as OverlayTextBoxModel } from '../../shared/types/pdf';
import {
  clientPointToPagePercent,
  type OverlayBoxGeometry,
} from '../hooks/overlayGeometry';
import type { OverlaySaveStatus } from '../hooks/useOverlayAutosave';
import { useOverlayKeyboard } from '../hooks/useOverlayKeyboard';
import { OverlayTextBox } from './OverlayTextBox';
import styles from './OverlayTextLayer.module.css';

interface OverlayTextLayerProps {
  pageId: string | null;
  overlays: OverlayTextBoxModel[];
  selectedOverlayId: string | null;
  textToolActive: boolean;
  createLimitMessage: string | null;
  announcement: string;
  canUndo: boolean;
  canRedo?: boolean;
  saveStatus?: OverlaySaveStatus;
  saveErrorMessage?: string | null;
  onCreateAt: (
    xPct: number,
    yPct: number
  ) => OverlayTextBoxModel | null;
  onSelect: (overlayId: string | null) => void;
  onDeleteSelected: () => void;
  onUndo: () => void;
  onRedo?: () => void;
  onFlush?: () => Promise<void>;
  onRetrySave?: () => Promise<void>;
  onBeginTextEdit?: (overlayId: string) => boolean;
  onUpdateText?: (text: string) => void;
  onCommitTextEdit?: () => boolean;
  onBeginGeometryEdit?: (overlayId: string) => boolean;
  onUpdateGeometry?: (geometry: OverlayBoxGeometry) => void;
  onCommitGeometryEdit?: (kind: 'move' | 'resize') => void;
  onNudgeSelected?: (deltaXPct: number, deltaYPct: number) => void;
  onBringForward?: () => void;
  onSendBackward?: () => void;
  readOnly?: boolean;
}

export const OverlayTextLayer: React.FC<OverlayTextLayerProps> = ({
  pageId,
  overlays,
  selectedOverlayId,
  textToolActive,
  createLimitMessage,
  announcement,
  canUndo,
  canRedo = false,
  saveStatus = 'idle',
  saveErrorMessage = null,
  onCreateAt,
  onSelect,
  onDeleteSelected,
  onUndo,
  onRedo = () => {},
  onFlush = async () => {},
  onRetrySave = async () => {},
  onBeginTextEdit = () => false,
  onUpdateText = () => {},
  onCommitTextEdit = () => false,
  onBeginGeometryEdit = () => false,
  onUpdateGeometry = () => {},
  onCommitGeometryEdit = () => {},
  onNudgeSelected = () => {},
  onBringForward = () => {},
  onSendBackward = () => {},
  readOnly = false,
}) => {
  const layerRef = useRef<HTMLDivElement>(null);
  const {
    orderedOverlays,
    editingOverlayId,
    beginEditing,
    finishEditing,
    handleBoxFocus,
    handleBoxKeyDown,
  } = useOverlayKeyboard({
    overlays,
    selectedOverlayId,
    disabled: readOnly,
    onSelect,
    onBeginTextEdit,
    onCommitTextEdit,
    onDeleteSelected,
    onNudgeSelected,
  });

  const handleLayerClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!pageId || !textToolActive) return;
      if (event.target !== event.currentTarget) return;

      const rect = layerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const { xPct, yPct } = clientPointToPagePercent(
        event.clientX,
        event.clientY,
        rect
      );
      const created = onCreateAt(xPct, yPct);
      if (created) beginEditing(created.id);
    },
    [beginEditing, onCreateAt, pageId, textToolActive]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const isMod = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement;
      const usesNativeTextUndo =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable;
      if (
        !usesNativeTextUndo &&
        isMod &&
        event.key.toLowerCase() === 'z' &&
        !event.shiftKey
      ) {
        event.preventDefault();
        onUndo();
        return;
      }
      if (
        !usesNativeTextUndo &&
        isMod &&
        ((event.key.toLowerCase() === 'z' && event.shiftKey) ||
          event.key.toLowerCase() === 'y')
      ) {
        event.preventDefault();
        onRedo();
        return;
      }
    },
    [onRedo, onUndo]
  );

  if (!pageId) return null;

  return (
    // The page overlay group intentionally handles placement clicks and
    // delegated keyboard shortcuts for its focusable child boxes.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={layerRef}
      className={`${styles.layer} ${textToolActive ? styles.placing : ''} ${readOnly ? styles.readOnly : ''}`}
      data-testid="pdf-tools-overlay-layer"
      role="group"
      aria-label="Page text overlays"
      onClick={handleLayerClick}
      onKeyDown={handleKeyDown}
      onBlurCapture={() => {
        void onFlush().catch(() => {});
      }}
    >
      {orderedOverlays.map((overlay) => (
        <OverlayTextBox
          key={overlay.id}
          overlay={overlay}
          selected={overlay.id === selectedOverlayId}
          editing={overlay.id === editingOverlayId}
          onSelect={onSelect}
          onEdit={beginEditing}
          onFocus={handleBoxFocus}
          onKeyDown={handleBoxKeyDown}
          onTextChange={onUpdateText}
          onExitEdit={finishEditing}
          onDelete={
            overlay.id === selectedOverlayId ? onDeleteSelected : undefined
          }
          onBeginGeometryEdit={onBeginGeometryEdit}
          onUpdateGeometry={onUpdateGeometry}
          onCommitGeometryEdit={onCommitGeometryEdit}
          displayOnly={readOnly}
        />
      ))}

      {createLimitMessage && (
        <div
          className={styles.limitMessage}
          data-testid="overlay-create-limit-message"
          role="alert"
        >
          {createLimitMessage}
        </div>
      )}

      {!readOnly && (
        <div className={styles.chrome}>
          {selectedOverlayId && (
            <>
              <button
                type="button"
                className={styles.chromeButton}
                data-testid="pdf-tools-overlay-edit-text"
                onClick={(event) => {
                  event.stopPropagation();
                  beginEditing(selectedOverlayId);
                }}
              >
                Edit text
              </button>
              <button
                type="button"
                className={styles.chromeButton}
                data-testid="pdf-tools-overlay-bring-forward"
                onClick={(event) => {
                  event.stopPropagation();
                  onBringForward();
                }}
              >
                Bring forward
              </button>
              <button
                type="button"
                className={styles.chromeButton}
                data-testid="pdf-tools-overlay-send-backward"
                onClick={(event) => {
                  event.stopPropagation();
                  onSendBackward();
                }}
              >
                Send backward
              </button>
            </>
          )}
          <button
            type="button"
            className={styles.chromeButton}
            data-testid="overlay-undo"
            disabled={!canUndo}
            aria-label="Undo overlay edit"
            title="Undo"
            onClick={(event) => {
              event.stopPropagation();
              onUndo();
            }}
          >
            Undo
          </button>
          <button
            type="button"
            className={styles.chromeButton}
            data-testid="overlay-redo"
            disabled={!canRedo}
            aria-label="Redo overlay edit"
            title="Redo"
            onClick={(event) => {
              event.stopPropagation();
              onRedo();
            }}
          >
            Redo
          </button>
          <div
            className={`${styles.saveStatus} ${saveStatus === 'error' ? styles.saveStatusError : ''}`}
            data-testid="overlay-save-status"
            role={saveStatus === 'error' ? 'alert' : 'status'}
            aria-live={saveStatus === 'error' ? 'assertive' : 'polite'}
            aria-atomic="true"
          >
            {saveStatus === 'saving'
              ? 'Saving…'
              : saveStatus === 'saved'
                ? 'Saved'
                : saveStatus === 'error'
                  ? `Save failed${saveErrorMessage ? ` — ${saveErrorMessage}` : ''}`
                  : saveStatus === 'dirty'
                    ? 'Unsaved changes'
                    : ''}
            {saveStatus === 'error' && (
              <button
                type="button"
                className={styles.retryButton}
                data-testid="overlay-save-retry"
                onClick={(event) => {
                  event.stopPropagation();
                  void onRetrySave().catch(() => {});
                }}
              >
                Retry
              </button>
            )}
          </div>
        </div>
      )}

      <div
        className={styles.liveRegion}
        aria-live="polite"
        aria-atomic="true"
        data-testid="pdf-tools-overlay-live-region"
      >
        {announcement}
      </div>
    </div>
  );
};
