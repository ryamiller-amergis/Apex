import React from 'react';
import type {
  BuildDeploymentView,
  BuildPreviewEntry,
  BuildRunStatus,
} from '../../shared/types/build';
import { BuildDeploymentFailedPanel } from './BuildDeploymentFailedPanel';
import { BuildQueuePosition } from './BuildQueuePosition';
import styles from './BuildPreviewTab.module.css';

export interface BuildPreviewTabProps {
  buildStatus: BuildRunStatus;
  currentRevisionNumber: number;
  deployment: BuildDeploymentView | null;
  previews: BuildPreviewEntry[];
  canRetryDeployment: boolean;
  onRetryDeployment: () => Promise<unknown>;
}

function statusLabel(
  deployment: BuildDeploymentView | null,
  hasLivePreview: boolean,
): string {
  if (!deployment) return 'No preview yet';
  switch (deployment.status) {
    case 'not_started':
      return 'No preview yet';
    case 'queued':
      return 'Waiting';
    case 'deploying':
      return 'Deploying';
    case 'succeeded':
      return hasLivePreview ? 'Ready' : 'Ended';
    case 'failed':
      return 'Deployment failed';
    default: {
      const exhaustive: never = deployment.status;
      return exhaustive;
    }
  }
}

export const BuildPreviewTab: React.FC<BuildPreviewTabProps> = ({
  buildStatus,
  currentRevisionNumber,
  deployment,
  previews,
  canRetryDeployment,
  onRetryDeployment,
}) => {
  const liveEntry = previews.find((entry) => entry.isLive) ?? null;
  const label = statusLabel(deployment, liveEntry !== null);
  const latestCommit = previews[0]?.commit ?? '';
  const windowEnded =
    deployment?.status === 'succeeded' && !liveEntry;

  return (
    <section className={styles.root} {...{ 'data-testid': 'build-preview-tab' }}>
      <div className={styles.card}>
        <div className={styles.statusRow}>
          <span
            className={styles.statusBadge}
            {...{ 'data-testid': 'build-preview-status' }}
          >
            {label}
          </span>
        </div>

        { (!deployment || deployment.status === 'not_started') && (
          <p className={styles.copy}>
            No preview yet. Apex deploys one after your build passes its checks.
          </p>
        )}

        {deployment?.status === 'queued' && (
          <BuildQueuePosition queuePosition={deployment.queuePosition} />
        )}

        {deployment?.status === 'deploying' && (
          <p className={styles.copy}>
            Deploying your feature to the development environment.
          </p>
        )}

        {deployment?.status === 'succeeded' && liveEntry && liveEntry.previewUrl && (
          <div className={styles.readyBlock}>
            <p className={styles.copy}>Your preview is ready.</p>
            <a
              href={liveEntry.previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.link}
              {...{ 'data-testid': 'build-preview-current-link' }}
            >
              {`Open the preview for revision ${liveEntry.revisionNumber} (opens in a new tab)`}
            </a>
          </div>
        )}

        {windowEnded && (
          <p
            className={styles.endedNotice}
            {...{ 'data-testid': 'build-preview-ended-notice' }}
          >
            The preview window ended. Request changes to get a new preview.
          </p>
        )}

        {(buildStatus === 'deployment_failed' || deployment?.status === 'failed') && (
          // data-testid-exempt
          <BuildDeploymentFailedPanel
            commit={latestCommit}
            failedStage={deployment?.failedStage ?? null}
            errorExcerpt={deployment?.errorExcerpt ?? null}
            pipelineUrl={deployment?.pipelineUrl ?? null}
            supportContactNames={deployment?.supportContactNames ?? []}
            canRetryDeployment={canRetryDeployment}
            onRetryDeployment={onRetryDeployment}
          />
        )}
      </div>

      {previews.length > 0 && (
        <div className={styles.historySection}>
          <h3 className={styles.historyHeading}>Preview history</h3>
          <ul
            className={styles.historyList}
            {...{ 'data-testid': 'build-preview-history-list' }}
          >
            {previews.map((entry) => (
              <li
                key={entry.revisionNumber}
                className={styles.historyRow}
                {...{
                  'data-testid': `build-preview-history-row-${entry.revisionNumber}`,
                }}
              >
                <span className={styles.historyMeta}>
                  {`Revision ${entry.revisionNumber ?? currentRevisionNumber}, ${entry.deploymentStatus}.`}
                </span>
                {entry.isLive && entry.previewUrl ? (
                  <a
                    href={entry.previewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.link}
                    {...{
                      'data-testid': `build-preview-history-link-${entry.revisionNumber}`,
                    }}
                  >
                    {`Open the preview for revision ${entry.revisionNumber} (opens in a new tab)`}
                  </a>
                ) : (
                  <span className={styles.replacedNote}>
                    Replaced by a later deployment.
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
};
