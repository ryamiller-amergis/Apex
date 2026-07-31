import React, { useCallback, useRef } from 'react';
import type { OverlayTextBox as OverlayTextBoxModel } from '../../shared/types/pdf';
import {
  clientPointToPagePercent,
  type OverlayBoxGeometry,
} from '../hooks/overlayGeometry';
import type { OverlaySaveStatus } from '../hooks/useOverlayAutosave';
import { useOverlayKeyboard } from '../hooks/useOverlayKeyboard';
import {
  calculateReplacementBounds,
  type NativePdfTextItem,
} from '../utils/pdfNativeTextItems';
import { fitReplacementGeometry } from '../utils/fitReplacementGeometry';
import { NativeTextItemLayer } from './NativeTextItemLayer';
import { OverlayTextBox } from './OverlayTextBox';
import styles from './OverlayTextLayer.module.css';

interface OverlayTextLayerProps {
  pageId: string | null;
  overlays: OverlayTextBoxModel[];
  selectedOverlayId: string | null;
  textToolActive: boolean;
  replacementMode?: boolean;
  nativeTextItems?: NativePdfTextItem[];
  /** PDF.js render scale (fitScale × zoom). Passed to OverlayTextBox and fit. */
  displayScale?: number;
  createLimitMessage: string | null;
  announcement: string;
  canUndo: boolean;
  canRedo?: boolean;
  saveStatus?: OverlaySaveStatus;
  saveErrorMessage?: string | null;
  replacementDraftGeometry?: {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
  } | null;
  onCreateAt: (xPct: number, yPct: number) => OverlayTextBoxModel | null;
  onSetReplacementDraft?: (item: NativePdfTextItem) => void;
  onExitReplacementMode?: () => void;
  onSelect: (overlayId: string | null) => void;
  onDeleteSelected: () => void;
  onRemoveSelectedNativeText?: () => void;
  onUndo: () => void;
  onRedo?: () => void;
  onFlush?: () => Promise<void>;
  onRetrySave?: () => Promise<void>;
  onBeginTextEdit?: (overlayId: string) => boolean;
  onUpdateText?: (text: string, geometry?: OverlayBoxGeometry) => void;
  onCommitTextEdit?: () => boolean;
  onBeginGeometryEdit?: (overlayId: string) => boolean;
  onUpdateGeometry?: (geometry: OverlayBoxGeometry) => void;
  onCommitGeometryEdit?: (
    kind: 'move' | 'resize',
    finalGeometry: OverlayBoxGeometry
  ) => void;
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
  replacementMode = false,
  nativeTextItems = [],
  displayScale = 1,
  replacementDraftGeometry = null,
  createLimitMessage,
  announcement,
  canUndo,
  canRedo = false,
  saveStatus = 'idle',
  saveErrorMessage = null,
  onCreateAt,
  onSetReplacementDraft,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onExitReplacementMode: _exitMode,
  onSelect,
  onDeleteSelected,
  onRemoveSelectedNativeText = () => {},
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
  const flushAfterStateUpdate = useCallback(() => {
    window.requestAnimationFrame(() => {
      void onFlush().catch(() => {});
    });
  }, [onFlush]);
  const deleteSelectedAndSave = useCallback(() => {
    onDeleteSelected();
    flushAfterStateUpdate();
  }, [flushAfterStateUpdate, onDeleteSelected]);
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
    onDeleteSelected: deleteSelectedAndSave,
    onNudgeSelected,
  });
  const finishEditingAndSave = useCallback(() => {
    finishEditing();
    flushAfterStateUpdate();
  }, [finishEditing, flushAfterStateUpdate]);

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

  const handleNativeTextSelect = useCallback(
    (item: NativePdfTextItem) => {
      onSetReplacementDraft?.({
        ...item,
        replacementBounds: calculateReplacementBounds(item, nativeTextItems),
      });
    },
    [nativeTextItems, onSetReplacementDraft]
  );

  const handleOverlayTextChange = useCallback(
    (overlay: OverlayTextBoxModel, text: string) => {
      const normalizedText = text.replace(/\r\n?/g, '\n');
      if (overlay.kind !== 'replace') {
        onUpdateText(normalizedText);
        return;
      }

      const pageEl = layerRef.current;
      if (!pageEl || pageEl.clientWidth <= 0 || pageEl.clientHeight <= 0) {
        onUpdateText(normalizedText);
        return;
      }

      const fitted = fitReplacementGeometry(
        overlay,
        normalizedText,
        pageEl.clientWidth,
        pageEl.clientHeight,
        displayScale
      );
      const grew =
        fitted.width > overlay.width + 0.01 ||
        fitted.height > overlay.height + 0.01;
      onUpdateText(normalizedText, grew ? fitted : undefined);
    },
    [onUpdateText, displayScale]
  );

  const handleOverlayBoxKeyDown = useCallback(
    (overlay: OverlayTextBoxModel, event: React.KeyboardEvent<HTMLElement>) => {
      if (overlay.kind === 'replace' && event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      handleBoxKeyDown(overlay.id, event);
    },
    [handleBoxKeyDown]
  );

  const selectedOverlay =
    orderedOverlays.find((overlay) => overlay.id === selectedOverlayId) ?? null;

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
        <React.Fragment key={overlay.id}>
          {overlay.kind === 'replace' &&
            overlay.replacementCover &&
            overlay.backgroundColor &&
            overlay.coverActive !== false && (
              <div
                className={styles.replacementCover}
                data-testid="pdf-tools-replacement-cover"
                aria-hidden="true"
                style={{
                  left: `${overlay.replacementCover.x}%`,
                  top: `${overlay.replacementCover.y}%`,
                  width: `${overlay.replacementCover.width}%`,
                  height: `${overlay.replacementCover.height}%`,
                  zIndex: overlay.zIndex,
                  backgroundColor: overlay.backgroundColor,
                  transform: overlay.rotation
                    ? `rotate(${overlay.rotation}deg)`
                    : undefined,
                }}
              />
            )}
          <OverlayTextBox
            overlay={overlay}
            selected={overlay.id === selectedOverlayId}
            editing={
              overlay.kind !== 'replace' && overlay.id === editingOverlayId
            }
            displayScale={displayScale}
            onSelect={onSelect}
            onEdit={overlay.kind === 'replace' ? undefined : beginEditing}
            onFocus={handleBoxFocus}
            onKeyDown={(_overlayId, event) =>
              handleOverlayBoxKeyDown(overlay, event)
            }
            onTextChange={(text) => handleOverlayTextChange(overlay, text)}
            onExitEdit={finishEditingAndSave}
            onDelete={
              overlay.id === selectedOverlayId
                ? deleteSelectedAndSave
                : undefined
            }
            onBeginGeometryEdit={onBeginGeometryEdit}
            onUpdateGeometry={onUpdateGeometry}
            onCommitGeometryEdit={onCommitGeometryEdit}
            displayOnly={readOnly}
            renderInlineCover={!overlay.replacementCover}
          />
        </React.Fragment>
      ))}

      {replacementDraftGeometry && (
        <div
          className={styles.draftOutline}
          data-testid="pdf-tools-replacement-draft-outline"
          role="status"
          aria-label="Selected text for replacement"
          style={{
            left: `${replacementDraftGeometry.x}%`,
            top: `${replacementDraftGeometry.y}%`,
            width: `${replacementDraftGeometry.width}%`,
            height: `${replacementDraftGeometry.height}%`,
            transform: replacementDraftGeometry.rotation
              ? `rotate(${replacementDraftGeometry.rotation}deg)`
              : undefined,
          }}
        />
      )}

      {!readOnly && replacementMode && (
        <NativeTextItemLayer
          items={nativeTextItems}
          onSelect={handleNativeTextSelect}
        />
      )}

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
              {selectedOverlay?.kind !== 'replace' && (
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
              )}
              {selectedOverlay?.kind === 'replace' && (
                <button
                  type="button"
                  className={styles.chromeButton}
                  data-testid="pdf-tools-overlay-remove-native-text"
                  onClick={(event) => {
                    event.stopPropagation();
                    finishEditing();
                    onRemoveSelectedNativeText();
                    flushAfterStateUpdate();
                  }}
                >
                  Remove original text
                </button>
              )}
              <button
                type="button"
                className={styles.chromeButton}
                data-testid="pdf-tools-overlay-delete"
                onClick={(event) => {
                  event.stopPropagation();
                  finishEditing();
                  deleteSelectedAndSave();
                }}
              >
                {selectedOverlay?.kind === 'replace'
                  ? 'Revert replacement'
                  : 'Delete'}
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
