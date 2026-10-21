import React, { useEffect, useRef, useState } from 'react';
import {
  useCancelPlaybookRun,
  useRetryPlaybookStep,
} from '../hooks/usePlaybookRuns';
import { useAppShell } from '../hooks/useAppShell';
import type { PlaybookRunDetail } from '../../shared/types/playbook';
import styles from './PlaybookRunActions.module.css';

interface PlaybookRunActionsProps {
  run: PlaybookRunDetail;
}

export const PlaybookRunActions: React.FC<PlaybookRunActionsProps> = ({ run }) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const keepRunRef = useRef<HTMLButtonElement>(null);
  const cancelMutation = useCancelPlaybookRun(run.project, run.runId);
  const retryMutation = useRetryPlaybookStep(run.project, run.runId);

  useEffect(() => {
    if (dialogOpen) keepRunRef.current?.focus();
  }, [dialogOpen]);

  const { can, userId } = useAppShell();
  const mayAct = userId === run.initiatorUserId || can('playbooks:admin');
  const canCancel = run.status === 'running' || run.status === 'suspended';
  const retryableStep = run.steps.find(
    (step) => step.stepId === run.currentStepId && step.status === 'failed_retryable'
  );
  const error = cancelMutation.error ?? retryMutation.error;

  if (!mayAct || (!canCancel && !retryableStep)) return null;

  const closeDialog = (): void => {
    setDialogOpen(false);
    window.setTimeout(() => cancelButtonRef.current?.focus(), 0);
  };

  const confirmCancel = async (): Promise<void> => {
    try {
      const result = await cancelMutation.mutateAsync({});
      setSuccess(
        result.outcome === 'already-cancelled' ? 'Run was already cancelled.' : 'Run cancelled.'
      );
      closeDialog();
    } catch {
      // The mutation error remains in the dialog so the user may retry or keep the run.
    }
  };

  const retryStep = async (): Promise<void> => {
    if (!retryableStep) return;
    try {
      await retryMutation.mutateAsync({ stepRunId: retryableStep.id });
      setSuccess(`Retry started for ${retryableStep.stepId}.`);
    } catch {
      // Rendered below with a retryable native button still available.
    }
  };

  return (
    <div
      className={styles.actions}
      aria-label={`Actions for ${run.definitionName}`}
      {...{ 'data-testid': 'playbook-run-actions' }}
    >
      {canCancel ? (
        <button
          ref={cancelButtonRef}
          type="button"
          className={`${styles.button} ${styles.danger}`}
          disabled={cancelMutation.isPending}
          aria-busy={cancelMutation.isPending}
          aria-label={`Cancel ${run.definitionName}`}
          onClick={() => {
            setSuccess(null);
            cancelMutation.reset();
            setDialogOpen(true);
          }}
          {...{ 'data-testid': 'playbook-run-cancel' }}
        >
          {cancelMutation.isPending ? 'Cancelling…' : 'Cancel'}
        </button>
      ) : null}

      {retryableStep ? (
        <button
          type="button"
          className={styles.button}
          disabled={retryMutation.isPending}
          aria-busy={retryMutation.isPending}
          aria-label={`Retry ${retryableStep.stepId} in ${run.definitionName}`}
          onClick={() => {
            setSuccess(null);
            retryMutation.reset();
            void retryStep();
          }}
          {...{ 'data-testid': 'playbook-run-retry-step' }}
        >
          {retryMutation.isPending ? 'Retrying…' : 'Retry step'}
        </button>
      ) : null}

      {error ? (
        <p
          className={`${styles.message} ${styles.error}`}
          role="alert"
          {...{ 'data-testid': 'playbook-run-action-error' }}
        >
          {error.status === 403
            ? 'Your access changed. Run details were refreshed.'
            : error.message}
        </p>
      ) : null}

      {success ? (
        <p
          className={styles.message}
          role="status"
          aria-live="polite"
          {...{ 'data-testid': 'playbook-run-action-success' }}
        >
          {success}
        </p>
      ) : null}

      {dialogOpen ? (
        <div className={styles.backdrop}>
          <section
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`cancel-playbook-${run.runId}`}
            {...{ 'data-testid': 'playbook-cancel-dialog' }}
          >
            <h2 className={styles.dialogTitle} id={`cancel-playbook-${run.runId}`}>
              Cancel {run.definitionName}?
            </h2>
            <p className={styles.dialogText}>
              The active run and its open steps will be cancelled.
            </p>
            {cancelMutation.error ? (
              <p className={`${styles.message} ${styles.error}`} role="alert">
                {cancelMutation.error.message}
              </p>
            ) : null}
            <div className={styles.dialogActions}>
              <button
                ref={keepRunRef}
                type="button"
                className={styles.button}
                disabled={cancelMutation.isPending}
                onClick={closeDialog}
                {...{ 'data-testid': 'playbook-cancel-keep-run' }}
              >
                Keep run
              </button>
              <button
                type="button"
                className={`${styles.button} ${styles.danger}`}
                disabled={cancelMutation.isPending}
                aria-busy={cancelMutation.isPending}
                onClick={() => void confirmCancel()}
                {...{ 'data-testid': 'playbook-cancel-confirm' }}
              >
                {cancelMutation.isPending ? 'Cancelling…' : 'Cancel run'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
};

export default PlaybookRunActions;
