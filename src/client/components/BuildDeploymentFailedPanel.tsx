import React from 'react';
import { formatSupportContacts } from '../../shared/buildPlanCopy';
import { RetryDeploymentButton } from './RetryDeploymentButton';
import styles from './BuildPreviewTab.module.css';

export interface BuildDeploymentFailedPanelProps {
  commit: string;
  failedStage: string | null;
  errorExcerpt: string | null;
  pipelineUrl: string | null;
  supportContactNames: string[];
  canRetryDeployment: boolean;
  onRetryDeployment: () => Promise<unknown>;
}

export const BuildDeploymentFailedPanel: React.FC<BuildDeploymentFailedPanelProps> = ({
  commit,
  failedStage,
  errorExcerpt,
  pipelineUrl,
  supportContactNames,
  canRetryDeployment,
  onRetryDeployment,
}) => {
  const nonBlank = supportContactNames.filter((name) => name.trim().length > 0);
  const who = formatSupportContacts(nonBlank);
  const verb = nonBlank.length === 1 ? 'has' : 'have';
  const shortCommit = commit ? commit.slice(0, 7) : 'unknown';

  return (
    <div
      className={styles.failedPanel}
      role="alert"
      {...{ 'data-testid': 'build-deployment-failed-panel' }}
    >
      <p className={styles.failedTitle}>
        Your feature was built and passed its checks, but deployment failed.
      </p>
      <p
        className={styles.failedContacts}
        {...{ 'data-testid': 'build-deployment-failed-contacts' }}
      >
        {`${who} ${verb} been notified.`}
      </p>
      {canRetryDeployment && failedStage && (
        <div
          className={styles.failedDiagnostic}
          {...{ 'data-testid': 'build-deployment-failed-stage' }}
        >
          <span>{`Failed stage: ${failedStage}. Commit ${shortCommit}. `}</span>
          {pipelineUrl && (
            <a
              href={pipelineUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.link}
              {...{ 'data-testid': 'build-deployment-pipeline-link' }}
            >
              Open the pipeline run (opens in a new tab).
            </a>
          )}
          {errorExcerpt && <pre className={styles.errorExcerpt}>{errorExcerpt}</pre>}
        </div>
      )}
      {canRetryDeployment && (
        // data-testid-exempt
        <RetryDeploymentButton onRetry={onRetryDeployment} />
      )}
    </div>
  );
};
