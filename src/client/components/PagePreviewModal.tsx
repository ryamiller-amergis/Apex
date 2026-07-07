import React, { useRef, useEffect, useCallback, useState } from 'react';
import ReactDOM from 'react-dom';
import { PdfWorkerProvider } from '../contexts/PdfWorkerContext';
import { usePdfDocument } from '../hooks/usePdfDocument';
import styles from './PagePreviewModal.module.css';

export interface PagePreviewModalProps {
  isOpen: boolean;
  pageId: string | null;
  fileUrl: string | null;
  sourcePageIndex: number;
  rotation: 0 | 90 | 180 | 270;
  sourceFileName: string;
  originalPageNumber: number;
  onClose: () => void;
}

const MAX_SCALE = 3;

const PagePreviewModalInner: React.FC<PagePreviewModalProps> = ({
  isOpen,
  fileUrl,
  sourcePageIndex,
  rotation,
  sourceFileName,
  originalPageNumber,
  onClose,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [isRendering, setIsRendering] = useState(false);

  const { document, isLoading: isDocLoading } = usePdfDocument(fileUrl);

  useEffect(() => {
    if (!isOpen || !document) return;

    let cancelled = false;
    setIsRendering(true);

    (async () => {
      try {
        const page = await document.getPage(sourcePageIndex + 1);
        const viewport = page.getViewport({ scale: 1, rotation });

        const modalWidth = window.innerWidth * 0.85;
        const modalHeight = window.innerHeight * 0.8;
        const scale = Math.min(
          modalWidth / viewport.width,
          modalHeight / viewport.height,
          MAX_SCALE,
        );

        const scaledViewport = page.getViewport({ scale, rotation });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;

        canvas.width = scaledViewport.width;
        canvas.height = scaledViewport.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          if (!cancelled) setIsRendering(false);
          return;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (page as any).render({ canvasContext: ctx, viewport: scaledViewport, canvas: null }).promise;

        if (!cancelled) {
          setIsRendering(false);
        }
      } catch {
        if (!cancelled) {
          setIsRendering(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, document, sourcePageIndex, rotation]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }

      if (e.key === 'Tab') {
        const modal = modalRef.current;
        if (!modal) return;

        const focusable = modal.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey) {
          if (window.document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (window.document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    window.document.addEventListener('keydown', handleKeyDown);
    closeButtonRef.current?.focus();

    return () => {
      window.document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose],
  );

  if (!isOpen) return null;

  const showSpinner = isDocLoading || isRendering;

  return ReactDOM.createPortal(
    <div
      className={styles.backdrop}
      onClick={handleBackdropClick}
      data-testid="pdf-preview-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Page preview"
      ref={modalRef}
    >
      <div className={styles.modal}>
        <button
          ref={closeButtonRef}
          className={styles.closeButton}
          onClick={onClose}
          aria-label="Close preview"
          data-testid="pdf-preview-modal-close"
          type="button"
        >
          ✕
        </button>

        <div className={styles.canvasWrapper}>
          {showSpinner && (
            <div className={styles.loadingWrapper} data-testid="pdf-preview-loading">
              <div className={styles.spinner} />
              <p className={styles.loadingText}>Loading preview…</p>
            </div>
          )}
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            data-testid="pdf-preview-canvas"
            style={{ display: showSpinner ? 'none' : 'block' }}
          />
        </div>

        <p className={styles.sourceInfo} data-testid="pdf-preview-source-info">
          {sourceFileName} — Page {originalPageNumber}
        </p>
      </div>
    </div>,
    window.document.body,
  );
};

export const PagePreviewModal: React.FC<PagePreviewModalProps> = (props) => {
  if (!props.isOpen) return null;

  return (
    <PdfWorkerProvider>
      <PagePreviewModalInner {...props} />
    </PdfWorkerProvider>
  );
};
