import React, { useEffect, useRef } from 'react';
import type { BuildEvidenceSlot } from '../../shared/types/buildView';
import { BuildApiError, useBuildEvidence } from '../hooks/useBuilds';
import styles from './BuildEvidenceDialog.module.css';

export interface BuildEvidenceDialogTarget {
  rowId: string;
  requirementId: string;
  slot: BuildEvidenceSlot;
  commit: string;
  command: string;
  exitCode: number;
  recordedAt: string;
}

interface BuildEvidenceDialogProps {
  project: string;
  buildId: string;
  target: BuildEvidenceDialogTarget;
  onClose: () => void;
}

const DIALOG_TITLE_ID = 'build-evidence-dialog-title';

export const BuildEvidenceDialog: React.FC<BuildEvidenceDialogProps> = ({
  project,
  buildId,
  target,
  onClose,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const { data, error, isLoading, isError, refetch } = useBuildEvidence(project, buildId, {
    rowId: target.rowId,
    slot: target.slot,
    recordedAt: target.recordedAt,
  });

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const slotLabel = target.slot === 'red' ? 'Red' : 'Green';
  const status = error instanceof BuildApiError ? error.status : null;

  let body: React.ReactNode;
  if (isLoading) {
    body = (
      <div
        className={styles.message}
        aria-busy="true"
        {...{ 'data-testid': 'build-evidence-loading' }}
      >
        Loading evidence…
      </div>
    );
  } else if (isError) {
    if (status === 404) {
      body = (
        <div
          className={styles.message}
          role="status"
          {...{ 'data-testid': 'build-evidence-unavailable' }}
        >
          This evidence is no longer available. Evidence is kept for 90 days after a build ends.
        </div>
      );
    } else if (status === 403) {
      body = (
        <div
          className={styles.message}
          role="alert"
          {...{ 'data-testid': 'build-evidence-forbidden' }}
        >
          You do not have access to this evidence.
        </div>
      );
    } else {
      body = (
        <div
          className={styles.message}
          role="alert"
          {...{ 'data-testid': 'build-evidence-error' }}
        >
          <span>We could not load this evidence. Try again.</span>
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              void refetch();
            }}
            {...{ 'data-testid': 'build-evidence-retry' }}
          >
            Retry
          </button>
        </div>
      );
    }
  } else {
    /* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Keyboard-scrollable evidence pre required by design spec */
    body = (
      <pre
        className={styles.content}
        tabIndex={0}
        {...{ 'data-testid': 'build-evidence-content' }}
      >
        {data ?? ''}
      </pre>
    );
    /* eslint-enable jsx-a11y/no-noninteractive-tabindex */
  }

  return (
    <div className={styles.backdrop}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={DIALOG_TITLE_ID}
        className={styles.dialog}
        {...{ 'data-testid': 'build-evidence-dialog' }}
      >
        <div className={styles.header}>
          <h3 id={DIALOG_TITLE_ID} className={styles.title}>
            {`${slotLabel} evidence for ${target.requirementId}`}
          </h3>
          <button
            ref={closeButtonRef}
            type="button"
            className={styles.button}
            onClick={onClose}
            {...{ 'data-testid': 'build-evidence-close' }}
          >
            Close
          </button>
        </div>
        <div className={styles.meta}>
          <span>
            Commit: <span className={styles.mono}>{target.commit.slice(0, 7)}</span>
          </span>
          <span>{`Exit code: ${target.exitCode}`}</span>
          <span className={styles.mono}>{target.command}</span>
        </div>
        {body}
      </div>
    </div>
  );
};
