import React from 'react';
import type { BuildRunStatus } from '../../shared/types/build';
import type {
  BuildRevisionProgressView,
  BuildRevisionStage,
} from '../../shared/types/buildRevision';
import styles from './RequestChangesDialog.module.css';

export interface BuildRevisionProgressProps {
  revision: BuildRevisionProgressView | null;
  buildStatus: BuildRunStatus;
  onOpenRequestChanges: () => void;
  onRetryAmendment: () => void;
}

function stagePhrase(stage: BuildRevisionStage | null): string | null {
  switch (stage) {
    case 'asking':
      return 'asking questions';
    case 'drafting':
      return 'amending the brief';
    case 'awaiting_approval':
      return 'waiting for your approval';
    case 'building':
    case 'planning':
      return 'building';
    case 'preview_ready':
      return 'preview ready';
    default:
      return null;
  }
}

export const BuildRevisionProgress: React.FC<BuildRevisionProgressProps> = ({
  revision,
  buildStatus,
  onOpenRequestChanges,
  onRetryAmendment,
}) => {
  if (!revision) return null;

  const phrase = stagePhrase(revision.stage);
  const progressText = phrase
    ? `Revision ${revision.number} of ${revision.revisionsLimit} — ${phrase}`
    : `Revision ${revision.number} of ${revision.revisionsLimit}`;
  const capReached = revision.revisionsUsed >= revision.revisionsLimit;
  const buttonDisabled = buildStatus !== 'preview_ready' || capReached;
  const buttonLabel = revision.actingForRequester
    ? `Request changes for ${revision.requesterDisplayName}`
    : 'Request changes';

  return (
    <div className={styles.progressContainer}>
      {revision.revisionsUsed > 0 && (
        <div
          role="status"
          aria-live="polite"
          className={styles.progressLine}
          {...{ 'data-testid': 'build-revision-progress' }}
        >
          {progressText}
        </div>
      )}

      {revision.amendmentError && (
        <div
          role="alert"
          className={styles.errorBanner}
          {...{ 'data-testid': 'build-revision-error-banner' }}
        >
          <span>{revision.amendmentError.message}</span>
          <button
            type="button"
            className={styles.retryButton}
            onClick={onRetryAmendment}
            {...{ 'data-testid': 'build-revision-retry' }}
          >
            Try again
          </button>
        </div>
      )}

      {revision.viewerCanRequestChanges && (
        <div className={styles.headerActionGroup}>
          <button
            type="button"
            disabled={buttonDisabled}
            className={styles.requestButton}
            onClick={onOpenRequestChanges}
            {...{ 'data-testid': 'build-request-changes-button' }}
          >
            {buttonLabel}
          </button>
          {capReached && (
            <span
              className={styles.capNote}
              {...{ 'data-testid': 'build-revision-cap-note' }}
            >
              {`All ${revision.revisionsLimit} revisions used`}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
