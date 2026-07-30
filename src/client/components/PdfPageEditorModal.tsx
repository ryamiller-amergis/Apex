import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import type { OverlayTextBox } from '../../shared/types/pdf';
import type {
  OverlayFormattingPatch,
  ReplacementDraft,
} from '../hooks/useOverlayEditor';
import {
  PdfInlinePreview,
  type PdfInlinePreviewOverlayProps,
  type PdfInlinePreviewFormProps,
  type PdfInlinePreviewSignatureProps,
} from './PdfInlinePreview';
import { OverlayFormatToolbar } from './OverlayFormatToolbar';
import { NoFormFieldsGuidance } from './PdfFormFieldLayer';
import { SignatureToolPanel } from './SignatureToolPanel';
import type { SignatureSource } from './SignatureToolPanel';
import styles from './PdfPageEditorModal.module.css';

export type PageEditorActiveTool = 'none' | 'add' | 'replace' | 'fill-form' | 'sign';

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
  replacementDraft?: ReplacementDraft | null;
  onToggleTextTool: () => void;
  onToggleReplacementTool: () => void;
  onFormattingChange: (patch: OverlayFormattingPatch) => void;
  onReplacementTextFocus?: () => void;
  onReplacementTextChange?: (text: string) => void;
  onReplacementTextBlur?: () => void;
  onValidationChange: (hasError: boolean) => void;
  onDiscardDraft?: () => void;
  onClose: () => void;
  /** Whether the source file has AcroForm text fields on this page. */
  hasFormFields?: boolean;
  /** Active non-overlay tool in the tool rail. */
  activeExtraTool?: PageEditorActiveTool;
  onToggleFillForm?: () => void;
  onToggleSign?: () => void;
  /** Form-fill props forwarded to the inline preview. */
  form?: PdfInlinePreviewFormProps | null;
  /** Signature props forwarded to the inline preview. */
  signatureOverlayProps?: PdfInlinePreviewSignatureProps | null;
  /** Called when the user has created a signature and it should be uploaded+placed. */
  onSignatureReady?: (blob: Blob, source: SignatureSource) => void;
  /** Whether the signature is currently uploading. */
  isSignatureUploading?: boolean;
  /** Error from signature upload, if any. */
  signatureUploadError?: string | null;
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
  onToggleReplacementTool,
  onFormattingChange,
  onReplacementTextFocus,
  onReplacementTextChange,
  onReplacementTextBlur,
  onValidationChange,
  onDiscardDraft,
  onClose,
  replacementDraft = null,
  hasFormFields = false,
  activeExtraTool = 'none',
  onToggleFillForm,
  onToggleSign,
  form = null,
  signatureOverlayProps = null,
  onSignatureReady,
  isSignatureUploading = false,
  signatureUploadError = null,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [isToolsOpen, setIsToolsOpen] = useState(true);

  useEffect(() => {
    if (!isOpen) return;
    if (!replacementDraft) {
      closeButtonRef.current?.focus();
    }
    // Initial focus only on open — textarea autoFocus handles draft case
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = window.document.body.style.overflow;
    window.document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (
          window.document.activeElement?.getAttribute('data-testid') ===
          'pdf-tools-overlay-editing'
        ) {
          return;
        }
        event.preventDefault();
        onDiscardDraft?.();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
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
  }, [isOpen, onClose, onDiscardDraft]);

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
              onClick={() => {
                onDiscardDraft?.();
                onClose();
              }}
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
                <button
                  type="button"
                  className={`${styles.addTextButton} ${overlay.editorMode === 'replace' ? styles.addTextActive : ''}`}
                  aria-pressed={overlay.editorMode === 'replace'}
                  disabled={overlay.readOnly}
                  onClick={onToggleReplacementTool}
                  data-testid="page-editor-replace-text"
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
                    <path d="M17 17h5M19.5 14.5v5" />
                  </svg>
                  {overlay.editorMode === 'replace'
                    ? 'Select existing text'
                    : 'Replace text'}
                </button>

                <button
                  type="button"
                  className={`${styles.addTextButton} ${activeExtraTool === 'fill-form' ? styles.addTextActive : ''}`}
                  aria-pressed={activeExtraTool === 'fill-form'}
                  disabled={overlay.readOnly}
                  onClick={onToggleFillForm}
                  data-testid="page-editor-fill-form"
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
                    <rect x="3" y="5" width="18" height="14" rx="2" />
                    <path d="M7 10h4M7 14h8" />
                  </svg>
                  Fill form
                </button>

                <button
                  type="button"
                  className={`${styles.addTextButton} ${activeExtraTool === 'sign' ? styles.addTextActive : ''}`}
                  aria-pressed={activeExtraTool === 'sign'}
                  disabled={overlay.readOnly}
                  onClick={onToggleSign}
                  data-testid="page-editor-sign"
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
                    <path d="M3 17c2-2 4-3 6-1s4 3 6 0 4-3 6-1" />
                    <path d="M21 17V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v13" />
                  </svg>
                  Sign
                  <span className={styles.signDisclosure}>
                    (Electronic signature image only — not a certificate-backed digital signature.)
                  </span>
                </button>

                {selectedOverlay && !overlay.readOnly ? (
                  <div className={styles.formatPanel}>
                    {/* No key={overlay.id}: preserves textarea focus across
                        draft→active transitions. Toolbar syncs via prop. */}
                    <OverlayFormatToolbar
                      overlay={selectedOverlay}
                      orientation="vertical"
                      onChange={onFormattingChange}
                      onReplacementTextFocus={onReplacementTextFocus}
                      onReplacementTextChange={onReplacementTextChange}
                      onReplacementTextBlur={onReplacementTextBlur}
                      autoFocusReplacementText={Boolean(replacementDraft)}
                      onValidationChange={onValidationChange}
                    />
                  </div>
                ) : activeExtraTool === 'fill-form' ? (
                  <div className={styles.guidance} role="status">
                    {hasFormFields
                      ? 'Click a field on the page to fill it in.'
                      : null}
                    {!hasFormFields && <NoFormFieldsGuidance />}
                  </div>
                ) : activeExtraTool === 'sign' ? (
                  <div className={styles.signaturePanel}>
                    {onSignatureReady ? (
                      <SignatureToolPanel
                        onSignatureReady={onSignatureReady}
                        onCancel={() => onToggleSign?.()}
                        isUploading={isSignatureUploading}
                      />
                    ) : (
                      <div className={styles.guidance} role="status">
                        Choose a signature type, then drag it onto the page.
                      </div>
                    )}
                    {signatureUploadError && (
                      <p className={styles.signatureError} role="alert">
                        {signatureUploadError}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className={styles.guidance} role="status">
                    {overlay.readOnly
                      ? 'This session has expired. Text boxes are read-only.'
                      : overlay.editorMode === 'replace'
                        ? 'Hover over an individual text item, then click it to edit or remove it.'
                        : overlay.textToolActive
                          ? 'Click anywhere on the page to place a text box.'
                          : 'Select a text box to format it, or choose Add text / Replace text.'}
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
              form={form}
              signature={signatureOverlayProps}
            />
          </main>
        </div>
      </div>
    </div>,
    window.document.body
  );
};
