import React, { useState, useRef, useEffect, useCallback } from 'react';
import type {
  BuildAllowedActions,
  BuildSuspensionView,
} from '../../shared/types/buildRunControls';
import { absoluteTime } from './playbookStatusFormat';
import styles from './BuildRunControls.module.css';

export interface BuildRunControlsProps {
  allowedActions: BuildAllowedActions;
  suspension: BuildSuspensionView | null;
  onCancel: (reason?: string) => Promise<unknown>;
  onResume: () => Promise<unknown>;
}

export const BuildRunControls: React.FC<BuildRunControlsProps> = ({
  allowedActions,
  suspension,
  onCancel,
  onResume,
}) => {
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [resumePending, setResumePending] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const dismissBtnRef = useRef<HTMLButtonElement | null>(null);
  const cancelTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (cancelDialogOpen) {
      dismissBtnRef.current?.focus();
    }
  }, [cancelDialogOpen]);

  const handleCloseCancelDialog = useCallback(() => {
    setCancelDialogOpen(false);
    cancelTriggerRef.current?.focus();
  }, []);

  const handleConfirmCancel = useCallback(async () => {
    if (cancelPending) return;
    setCancelPending(true);
    setCancelError(null);
    try {
      await onCancel();
      setCancelDialogOpen(false);
    } catch (err) {
      setCancelError(
        err instanceof Error && err.message
          ? err.message
          : 'Could not cancel this build. Try again.',
      );
    } finally {
      setCancelPending(false);
    }
  }, [cancelPending, onCancel]);

  const handleResume = useCallback(async () => {
    if (resumePending) return;
    setResumePending(true);
    setResumeError(null);
    try {
      await onResume();
    } catch (err) {
      setResumeError(
        err instanceof Error && err.message
          ? err.message
          : 'Could not resume this build.',
      );
    } finally {
      setResumePending(false);
    }
  }, [onResume, resumePending]);

  if (!allowedActions.cancel && !allowedActions.resume && !suspension) {
    return null;
  }

  return (
    <div className={styles.root}>
      {suspension && (
        <div
          className={styles.suspensionBlock}
          {...{ 'data-testid': 'build-suspension-notice' }}
        >
          <p
            className={styles.suspensionReason}
            {...{ 'data-testid': 'build-suspension-reason' }}
          >
            {suspension.message}
          </p>
          {suspension.deadlineAt && (
            <p
              className={styles.suspensionMeta}
              {...{ 'data-testid': 'build-suspension-deadline' }}
            >
              {`Deadline: ${absoluteTime(suspension.deadlineAt)}`}
            </p>
          )}
          {suspension.used !== null && suspension.limit !== null && (
            <p
              className={styles.suspensionMeta}
              {...{ 'data-testid': 'build-suspension-cap-usage' }}
            >
              {`${suspension.used} of ${suspension.limit}`}
            </p>
          )}
        </div>
      )}

      <div className={styles.buttonRow}>
        {allowedActions.resume && (
          <button
            type="button"
            disabled={resumePending}
            aria-busy={resumePending}
            className={styles.resumeButton}
            onClick={() => {
              void handleResume();
            }}
            {...{ 'data-testid': 'build-resume-button' }}
          >
            Resume build
          </button>
        )}

        {allowedActions.cancel && (
          <button
            ref={cancelTriggerRef}
            type="button"
            disabled={cancelPending}
            aria-busy={cancelPending}
            className={styles.cancelButton}
            onClick={() => {
              setCancelError(null);
              setCancelDialogOpen(true);
            }}
            {...{ 'data-testid': 'build-cancel-button' }}
          >
            Cancel build
          </button>
        )}
      </div>

      {resumeError && (
        <p
          role="alert"
          className={styles.errorText}
          {...{ 'data-testid': 'build-resume-error' }}
        >
          {resumeError}
        </p>
      )}

      {cancelError && (
        <p
          role="alert"
          className={styles.errorText}
          {...{ 'data-testid': 'build-cancel-error' }}
        >
          {cancelError}
        </p>
      )}

      {cancelDialogOpen && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="build-cancel-dialog-title"
          aria-describedby="build-cancel-dialog-desc"
          className={styles.backdrop}
          {...{ 'data-testid': 'build-cancel-dialog' }}
        >
          <div className={styles.dialog}>
            <h2 id="build-cancel-dialog-title" className={styles.dialogTitle}>
              Cancel this build?
            </h2>
            <p id="build-cancel-dialog-desc" className={styles.dialogDesc}>
              Running agents will stop and any preview lease will be released. This cannot be undone.
            </p>
            <div className={styles.dialogActions}>
              <button
                ref={dismissBtnRef}
                type="button"
                className={styles.dismissButton}
                onClick={handleCloseCancelDialog}
                {...{ 'data-testid': 'build-cancel-dismiss' }}
              >
                Keep building
              </button>
              <button
                type="button"
                disabled={cancelPending}
                aria-busy={cancelPending}
                className={styles.confirmCancelButton}
                onClick={() => {
                  void handleConfirmCancel();
                }}
                {...{ 'data-testid': 'build-cancel-confirm' }}
              >
                {cancelPending ? 'Cancelling…' : 'Confirm cancel'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
