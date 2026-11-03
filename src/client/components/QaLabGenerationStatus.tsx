import React from 'react';
import { useChatStream } from '../hooks/useChatStream';
import {
  friendlyChatProgressLabel,
  friendlyToolActivityLabel,
} from '../../shared/utils/chatProgressCopy';
import { ApexLoader } from './ApexLoader';
import { ChatRunProgressLabel } from './ChatRunProgressLabel';
import styles from './QaLabGenerationStatus.module.css';

const RECENT_STEP_COUNT = 5;

export interface QaLabGenerationStatusProps {
  /** Agent thread running the generation. Null before the server records it. */
  threadId: string | null;
}

/** Loader plus the agent's live step while QA Lab generates test cases. */
export const QaLabGenerationStatus: React.FC<QaLabGenerationStatusProps> = ({ threadId }) => {
  const { progressLabel, progressPhase, toolProgress } = useChatStream(threadId);
  const recentSteps = toolProgress.slice(-RECENT_STEP_COUNT).reverse();

  return (
    <div className={styles.root} role="status" {...{ 'data-testid': 'qa-lab-generating' }}>
      <ApexLoader size={72} />
      <div className={styles.label}>Generating your test cases…</div>
      <div className={styles.current} {...{ 'data-testid': 'qa-lab-generating-step' }}>
        <ChatRunProgressLabel
          fallbackLabel={progressPhase || progressLabel
            ? friendlyChatProgressLabel(progressLabel, progressPhase)
            : 'Starting the agent…'}
          progressPhase={progressPhase}
          toolProgress={toolProgress}
        />
      </div>
      {recentSteps.length > 0 && (
        <ol className={styles.steps} {...{ 'data-testid': 'qa-lab-generating-steps' }}>
          {recentSteps.map((step) => (
            <li key={step.callId} className={styles.step}>
              <span className={styles.stepMark} aria-hidden="true">
                {step.status === 'running' ? '…' : step.status === 'error' ? '!' : '✓'}
              </span>
              {friendlyToolActivityLabel(step.toolName, step.args)}
            </li>
          ))}
        </ol>
      )}
      <div className={styles.hint}>This can take a few minutes. You can leave and come back.</div>
    </div>
  );
};
