import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import type { OverlayTextBox } from '../../shared/types/pdf';
import type { OverlayFormattingPatch } from '../hooks/useOverlayEditor';
import {
  PdfInlinePreview,
  type PdfInlinePreviewOverlayProps,
} from './PdfInlinePreview';
import { OverlayFormatToolbar } from './OverlayFormatToolbar';
import styles from './PdfPageEditorModal.module.css';

interface PdfPageEditorModalProps {
  isOpen: boolean;
  sessionId: string;
  fileId: string;
  sourcePageIndex: number;
  rotation: 0 | 90 | 180 | 270;
  sourceFileName: string;
  originalPageNumber: number;
  overlay: PdfInlinePreviewOverlayProps;
  selectedOverlay: OverlayTextBox | null;
  onToggleTextTool: () => void;
  onFormattingChange: (patch: OverlayFormattingPatch) => void;
  onValidationChange: (hasError: boolean) => void;
  onClose: () => void;
}

export const PdfPageEditorModal: React.FC<PdfPageEditorModalProps> = ({
  isOpen,
  sessionId,
  fileId,
  sourcePageIndex,
  rotation,
  sourceFileName,
  originalPageNumber,
  overlay,
  selectedOverlay,
  onToggleTextTool,
  onFormattingChange,
  onValidationChange,
  onClose,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [isToolsOpen, setIsToolsOpen] = useState(true);

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = window.document.body.style.overflow;
    window.document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (
          window.document.activeElement?.getAttribute('data-testid') ===
          'pdf-tools-overlay-editing'
        ) {
          return;
        }
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && window.document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && window.document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.document.body.style.overflow = previousOverflow;
      window.document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return ReactDOM.createPortal(
    <div className={styles.backdrop}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pdf-page-editor-title"
        data-testid="pdf-page-editor-modal"
      >
        <header className={styles.header}>
          <div className={styles.headerText}>
            <span className={styles.eyebrow}>Page editor</span>
            <h2 id="pdf-page-editor-title">Edit page {originalPageNumber}</h2>
            <span className={styles.fileName}>{sourceFileName}</span>
          </div>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.toolsButton}
              aria-expanded={isToolsOpen}
              aria-controls="pdf-page-editor-tools"
              onClick={() => setIsToolsOpen((open) => !open)}
              data-testid="page-editor-toggle-tools"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M4 4h16v16H4zM10 4v16" />
              </svg>
              {isToolsOpen ? 'Hide tools' : 'Show tools'}
            </button>
            <button
              ref={closeButtonRef}
              type="button"
              className={styles.doneButton}
              onClick={onClose}
              data-testid="page-editor-done"
            >
              Done
            </button>
          </div>
        </header>

        <div className={styles.editorBody}>
          <aside
            id="pdf-page-editor-tools"
            className={`${styles.toolRail} ${isToolsOpen ? styles.toolRailOpen : styles.toolRailClosed}`}
            aria-hidden={!isToolsOpen}
          >
            {isToolsOpen && (
              <>
                <div className={styles.toolRailHeader}>
                  <span>Editing tools</span>
                  <button
                    type="button"
                    className={styles.collapseButton}
                    onClick={() => setIsToolsOpen(false)}
                    aria-label="Collapse editing tools"
                  >
                    ‹
                  </button>
                </div>
                <button
                  type="button"
                  className={`${styles.addTextButton} ${overlay.textToolActive ? styles.addTextActive : ''}`}
                  aria-pressed={overlay.textToolActive}
                  disabled={overlay.readOnly}
                  onClick={onToggleTextTool}
                  data-testid="page-editor-add-text"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M4 7V4h16v3M9 20h6M12 4v16" />
                    <path d="M18 12h4M20 10v4" />
                  </svg>
                  {overlay.textToolActive
                    ? 'Click page to add text'
                    : 'Add text'}
                </button>

                {selectedOverlay && !overlay.readOnly ? (
                  <div className={styles.formatPanel}>
                    <OverlayFormatToolbar
                      key={selectedOverlay.id}
                      overlay={selectedOverlay}
                      orientation="vertical"
                      onChange={onFormattingChange}
                      onValidationChange={onValidationChange}
                    />
                  </div>
                ) : (
                  <div className={styles.guidance} role="status">
                    {overlay.readOnly
                      ? 'This session has expired. Text boxes are read-only.'
                      : overlay.textToolActive
                        ? 'Click anywhere on the page to place a text box.'
                        : 'Select a text box to format it, or choose Add text to create one.'}
                  </div>
                )}
              </>
            )}
          </aside>

          <main className={styles.workspace}>
            <PdfInlinePreview
              sessionId={sessionId}
              fileId={fileId}
              sourcePageIndex={sourcePageIndex}
              rotation={rotation}
              sourceFileName={sourceFileName}
              originalPageNumber={originalPageNumber}
              overlay={overlay}
            />
          </main>
        </div>
      </div>
    </div>,
    window.document.body
  );
};
