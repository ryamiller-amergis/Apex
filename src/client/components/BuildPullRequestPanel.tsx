import React from 'react';
import type { BuildPullRequestSummary } from '../../shared/types/build';
import { formatSupportContacts } from '../../shared/buildPlanCopy';
import styles from './BuildAccept.module.css';

export interface BuildPullRequestPanelProps {
  summary: BuildPullRequestSummary | null;
}

export const BuildPullRequestPanel: React.FC<BuildPullRequestPanelProps> = ({
  summary,
}) => {
  if (!summary) return null;

  const reviewerText = formatSupportContacts(summary.reviewerNames);

  return (
    <section
      aria-label="Pull request status"
      aria-live="polite"
      className={styles.prPanel}
      {...{ 'data-testid': 'build-pr-panel' }}
    >
      {summary.state === 'opening_pull_request' && (
        <p className={styles.stateText} {...{ 'data-testid': 'build-pr-state' }}>
          Opening your pull request…
        </p>
      )}

      {summary.state === 'syncing' && (
        <p className={styles.stateText} {...{ 'data-testid': 'build-pr-state' }}>
          Your feature is being brought up to date with the latest code. This can take several minutes.
        </p>
      )}

      {summary.state === 'pull_request_open' && (
        <div className={styles.openDetails}>
          <p className={styles.stateText} {...{ 'data-testid': 'build-pr-state' }}>
            Your pull request is open. Engineers will review it.
          </p>
          {summary.url && (
            <a
              href={summary.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open pull request, opens in a new tab"
              className={styles.prLink}
              {...{ 'data-testid': 'build-pr-link' }}
            >
              Open pull request
            </a>
          )}
          <p
            className={styles.metaText}
            {...{ 'data-testid': 'build-pr-reviewers' }}
          >
            {summary.reviewersAdded === false
              ? `We could not add reviewers automatically. ${reviewerText} have been told.`
              : `Reviewers: ${reviewerText}`}
          </p>
          {summary.syncCommitSha && (
            <p
              className={styles.metaText}
              {...{ 'data-testid': 'build-pr-sync-note' }}
            >
              A sync commit was added after your preview. No new preview was made for it.
            </p>
          )}
        </div>
      )}

      {summary.state === 'needs_developer' && (
        <p
          className={styles.needsDevText}
          {...{ 'data-testid': 'build-needs-developer-notice' }}
        >
          {`We could not bring your feature up to date with the latest code on our own. ${reviewerText} have been told and will pick it up.`}
        </p>
      )}
    </section>
  );
};
