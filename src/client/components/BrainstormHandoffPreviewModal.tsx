import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { BrainstormActionId } from '../../shared/types/brainstormArtifact';
import { BrainstormApiError } from '../hooks/useBrainstormSessions';
import { useConfirmHandoff, usePreviewHandoff } from '../hooks/useBrainstormActions';
import styles from './BrainstormNextActionsPanel.module.css';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const ERROR_MESSAGES: Record<string, string> = {
  ARTIFACT_VERSION_CONFLICT: 'The artifact changed. Review the current version, then try again.',
  PREVIEW_STALE: 'The artifact changed after this preview. Close it and preview again.',
  ACTION_UNAVAILABLE: 'This action is no longer available.',
  HANDOFF_INTERRUPTED: 'Creating the record was interrupted. Try again.',
};

function errorMessage(err: unknown): string {
  if (err instanceof BrainstormApiError) {
    if (err.code && ERROR_MESSAGES[err.code]) return ERROR_MESSAGES[err.code];
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong. Try again.';
}

function errorReasons(err: unknown): string[] {
  if (!(err instanceof BrainstormApiError)) return [];
  const reasons = err.body.reasons;
  if (!Array.isArray(reasons)) return [];
  return reasons
    .map((reason) => (reason && typeof reason === 'object' && typeof (reason as { text?: unknown }).text === 'string' ? (reason as { text: string }).text : null))
    .filter((text): text is string => Boolean(text));
}

interface BrainstormHandoffPreviewModalProps {
  project: string;
  sessionId: string;
  actionId: BrainstormActionId;
  actionLabel: string;
  expectedVersion: number;
  onClose: () => void;
}

export const BrainstormHandoffPreviewModal: React.FC<BrainstormHandoffPreviewModalProps> = ({
  project,
  sessionId,
  actionId,
  actionLabel,
  expectedVersion,
  onClose,
}) => {
  const preview = usePreviewHandoff(project, sessionId);
  const confirm = useConfirmHandoff(project, sessionId);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const { mutate: requestPreview } = preview;

  useEffect(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    requestPreview({ actionId, expectedVersion });
    return () => {
      returnFocus.current?.focus();
    };
  }, [actionId, expectedVersion, requestPreview]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const titleId = `brainstorm-handoff-title-${sessionId}`;
  const result = confirm.data;
  const previewData = preview.data;

  let body: React.ReactNode;
  if (result) {
    body = (
      <div role="status">
        <p className={styles.modalText}>Done. The record was created from version {previewData?.artifactVersion ?? expectedVersion}.</p>
        {result.resultRef.link && (
          <Link to={result.resultRef.link} className={styles.resultLink} {...{ 'data-testid': 'brainstorm-handoff-result-link' }}>
            Open {previewData?.target.label ?? actionLabel}
          </Link>
        )}
      </div>
    );
  } else if (preview.isPending || preview.isIdle) {
    body = <p className={styles.modalText} aria-busy="true">Preparing the preview…</p>;
  } else if (preview.isError) {
    const reasons = errorReasons(preview.error);
    body = (
      <div className={styles.modalError} role="alert">
        <p>{errorMessage(preview.error)}</p>
        {reasons.length > 0 && (
          <ul>
            {reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        )}
      </div>
    );
  } else if (previewData) {
    body = (
      <>
        <dl className={styles.summary}>
          {previewData.summary.map((item) => (
            <div key={item.label} className={styles.summaryRow}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
        {previewData.sections.length > 0 && (
          <>
            <h3 className={styles.subheading}>Sections</h3>
            <ul className={styles.sections}>
              {previewData.sections.map((section) => <li key={section}>{section}</li>)}
            </ul>
          </>
        )}
        {previewData.notes.map((note) => <p key={note} className={styles.note}>{note}</p>)}
        {confirm.isError && (
          <div className={styles.modalError} role="alert">
            <p>{errorMessage(confirm.error)}</p>
            {errorReasons(confirm.error).map((reason) => <p key={reason}>{reason}</p>)}
          </div>
        )}
      </>
    );
  }

  return (
    <div className={styles.backdrop}>
      <button
        type="button"
        className={styles.backdropButton}
        aria-label="Close preview"
        tabIndex={-1}
        onClick={onClose}
        {...{ 'data-testid': 'brainstorm-handoff-backdrop' }}
      />
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- modal dialog traps Tab focus and closes on Escape */}
      <div
        ref={dialogRef}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        {...{ 'data-testid': 'brainstorm-handoff-modal' }}
      >
        <h2 id={titleId} className={styles.modalTitle}>{actionLabel}</h2>
        {body}
        <div className={styles.modalActions}>
          <button type="button" className={styles.button} onClick={onClose} {...{ 'data-testid': 'brainstorm-handoff-cancel' }}>
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && (
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              disabled={!previewData || confirm.isPending}
              onClick={() => previewData && confirm.mutate(previewData)}
              {...{ 'data-testid': 'brainstorm-handoff-confirm' }}
            >
              {confirm.isPending ? 'Creating…' : 'Confirm'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
