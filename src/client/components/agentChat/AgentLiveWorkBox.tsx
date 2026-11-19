import React from 'react';
import type { AgentRunPhase } from '../../../shared/types/chat';
import type { AgentActivityItem } from '../../chatHarness/types';
import type { ToolProgress } from '../../hooks/useChatStream';
import { ChatRunProgressLabel } from '../ChatRunProgressLabel';
import { AgentActivityLog } from './AgentActivityLog';
import styles from './agentChat.module.css';

export interface AgentLiveWorkBoxTestIds {
  root?: string;
  progress?: string;
  progressLabel?: string;
  busy?: string;
  thinking?: string;
  steps?: string;
  toolGroup?: string;
}

export interface AgentLiveWorkBoxProps {
  activity: ReadonlyArray<AgentActivityItem>;
  progressLabel?: string | null;
  progressPhase?: AgentRunPhase | null;
  toolProgress?: ToolProgress[];
  fallbackLabel?: string;
  testIdPrefix?: string;
  testIds?: AgentLiveWorkBoxTestIds;
  className?: string;
}

export const AgentLiveWorkBox: React.FC<AgentLiveWorkBoxProps> = ({
  activity,
  progressLabel = null,
  progressPhase = null,
  toolProgress = [],
  fallbackLabel = 'Working through your message',
  testIdPrefix,
  testIds,
  className,
}) => {
  const progressTestId = testIds?.progress
    ?? (testIdPrefix ? `${testIdPrefix}-agent-progress` : 'agent-progress');
  const busyTestId = testIds?.busy
    ?? (testIdPrefix ? `${testIdPrefix}-agent-busy` : 'agent-busy');
  const effectiveFallback = progressLabel || fallbackLabel;

  const logTestIds = {
    thinking: testIds?.thinking,
    steps: testIds?.steps,
    toolGroup: testIds?.toolGroup,
  };

  const progressBox = (
    <div
      className={`${styles.liveWorkBox} ${className ?? ''}`}
      aria-live={testIds?.root ? undefined : 'polite'}
      aria-busy={testIds?.root ? undefined : true}
      {...{ 'data-testid': progressTestId }}
    >
      <p
        className={styles.activityHeader}
        {...(testIds?.progressLabel ? { 'data-testid': testIds.progressLabel } : {})}
      >
        <span
          className={styles.activitySpinner}
          aria-hidden="true"
          {...{ 'data-testid': busyTestId }}
        />
        {progressPhase === 'queued' ? (
          <span {...{ 'data-testid': 'agent-run-status-queued' }}>Queued</span>
        ) : progressPhase === 'dispatched' ? (
          <span {...{ 'data-testid': 'agent-run-status-dispatched' }}>Dispatched</span>
        ) : (
          <ChatRunProgressLabel
            fallbackLabel={effectiveFallback}
            progressPhase={progressPhase}
            toolProgress={toolProgress}
          />
        )}
      </p>
      {activity.length > 0 ? (
        <AgentActivityLog
          items={activity}
          testIdPrefix={testIdPrefix}
          testIds={logTestIds}
        />
      ) : null}
    </div>
  );

  if (testIds?.root) {
    return (
      <div
        aria-live="polite"
        aria-busy="true"
        {...{ 'data-testid': testIds.root }}
      >
        {progressBox}
      </div>
    );
  }

  return progressBox;
};
