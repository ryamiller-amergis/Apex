import React from 'react';
import type { HarnessSummaryNoticeState } from '../../chatHarness/types';
import styles from './agentChat.module.css';

export interface AgentSummaryNoticeProps {
  notice: HarnessSummaryNoticeState | null;
  testIdPrefix?: string;
  testId?: string;
  className?: string;
}

export const AgentSummaryNotice: React.FC<AgentSummaryNoticeProps> = ({
  notice,
  testIdPrefix,
  testId,
  className,
}) => {
  if (!notice || (notice.status === 'completed' && !notice.isFallback)) {
    return null;
  }

  const resolvedTestId = testId
    ?? (testIdPrefix ? `${testIdPrefix}-summary-notice` : 'agent-summary-notice');

  const isRunning = notice.status === 'running';
  const isError = notice.status === 'error';
  const isFallback = !isRunning && !isError && (notice.status === 'fallback' || notice.isFallback);

  const toneClass = isError
    ? styles.summaryNoticeError
    : isFallback
      ? styles.summaryNoticeWarning
      : styles.summaryNoticeRunning;

  const message = isRunning
    ? (notice.text || 'Summarizing conversation…')
    : isError
      ? (notice.text || notice.error || 'Could not summarize this conversation.')
      : (notice.text || 'Only a trimmed transcript was kept for this summary.');

  return (
    <div
      className={`${styles.summaryNotice} ${toneClass} ${className ?? ''}`}
      role="status"
      aria-live="polite"
      {...{ 'data-testid': resolvedTestId }}
    >
      {isRunning ? <span className={styles.activitySpinner} aria-hidden="true" /> : null}
      <span>{message}</span>
    </div>
  );
};
