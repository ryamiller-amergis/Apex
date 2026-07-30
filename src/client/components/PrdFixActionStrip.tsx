import React, { useEffect, useRef, useState } from 'react';
import styles from './PrdFixActionStrip.module.css';

export interface PrdFixActionStripProgress {
  approved: number;
  rejected: number;
  pending: number;
  total: number;
}

export interface PrdFixActionStripProps {
  /** When set with threshold, shows the validation score chip. */
  validationScore?: number;
  validationThreshold?: number;
  readinessLabel?: string;
  readinessBlockingReason?: string | null;
  /** Context chip when not in validation-fix mode (e.g. comment / assistant proposals). */
  summaryLabel?: string;
  progress: PrdFixActionStripProgress;
  agentError?: string;
  busy?: boolean;
  onContinueReview: () => void;
  onAcceptAll: () => void;
  onRevert: () => void;
  /** Optional — omit to hide "Dismiss session" from the More menu. */
  onDismiss?: () => void;
  onPreview?: () => void;
  acceptLabel?: string;
  revertLabel?: string;
  ariaLabel?: string;
}

export const PrdFixActionStrip: React.FC<PrdFixActionStripProps> = ({
  validationScore,
  validationThreshold,
  readinessLabel,
  readinessBlockingReason,
  summaryLabel = 'Proposed changes',
  progress,
  agentError,
  busy = false,
  onContinueReview,
  onAcceptAll,
  onRevert,
  onDismiss,
  onPreview,
  acceptLabel = 'Accept all & re-validate',
  revertLabel = 'Revert all changes',
  ariaLabel = 'PRD fix review',
}) => {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  const reviewed = progress.approved + progress.rejected;
  const showValidationChips =
    validationScore !== undefined && validationThreshold !== undefined;
  const scoreTone =
    showValidationChips && validationScore! < 70 ? styles.chipDanger : styles.chipWarn;

  return (
    <div className={styles.strip} role="region" aria-label={ariaLabel}>
      <div className={styles.left}>
        {showValidationChips ? (
          <span className={`${styles.chip} ${scoreTone}`}>
            {validationScore}% / {validationThreshold}%
          </span>
        ) : (
          <span className={`${styles.chip} ${styles.chipWarn}`}>{summaryLabel}</span>
        )}
        {showValidationChips && readinessLabel && (
          <span
            className={`${styles.chip} ${styles.chipDanger}`}
            title={readinessBlockingReason ?? undefined}
          >
            {readinessLabel}
          </span>
        )}
        <span className={`${styles.chip} ${styles.chipNeutral}`}>
          {reviewed}/{progress.total} reviewed
          {progress.pending > 0 ? ` · ${progress.pending} left` : ''}
        </span>
        {agentError && (
          <span className={styles.errorHint} title={agentError}>
            {agentError}
          </span>
        )}
      </div>

      <div className={styles.right}>
        <button
          type="button"
          className={styles.primaryBtn}
          onClick={onContinueReview}
          disabled={busy || progress.total === 0}
        >
          Continue review
        </button>

        <div className={styles.moreWrap} ref={moreRef}>
          <button
            type="button"
            className={styles.moreBtn}
            onClick={() => setMoreOpen((v) => !v)}
            disabled={busy}
            aria-expanded={moreOpen}
            aria-haspopup="menu"
          >
            More
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
          {moreOpen && (
            <div className={styles.menu} role="menu">
              <button
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onClick={() => {
                  setMoreOpen(false);
                  onAcceptAll();
                }}
                disabled={busy}
              >
                {acceptLabel}
              </button>
              <button
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onClick={() => {
                  setMoreOpen(false);
                  onRevert();
                }}
                disabled={busy}
              >
                {revertLabel}
              </button>
              {onDismiss && (
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={() => {
                    setMoreOpen(false);
                    onDismiss();
                  }}
                  disabled={busy}
                >
                  Dismiss session
                </button>
              )}
              {onPreview && (
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={() => {
                    setMoreOpen(false);
                    onPreview();
                  }}
                  disabled={busy}
                >
                  Preview full diff
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PrdFixActionStrip;
