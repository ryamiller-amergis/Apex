import React, { useEffect, useId, useRef } from 'react';
import type { WorkflowEvaluationSubjectType } from '../../shared/types/workflowEvaluation';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useQualityFeedbackPromptState } from '../hooks/useQualityFeedbackPromptState';
import {
  useWorkflowEvaluationDefinitions,
  useWorkflowEvaluationEvents,
} from '../hooks/useWorkflowEvaluations';
import styles from './QualityFeedbackPromptController.module.css';

export interface QualityFeedbackPromptControllerProps {
  enabled: boolean;
  project: string;
  userId: string;
  subjectType: WorkflowEvaluationSubjectType;
  subjectId: string;
  stageKey: string;
  /** Used in copy, e.g. "PRD". */
  subjectLabel: string;
  canSubmit: boolean;
  /** The subject is in a state where feedback makes sense (e.g. PRD in review). */
  promptReady: boolean;
  /** Another automatic overlay is open; the modal waits and is not consumed. */
  suppressModal?: boolean;
  onOpenPanel: () => void;
  testIdPrefix?: string;
}

/**
 * Optional nudge to give feedback: one modal per user, browser, subject and
 * stage, then a banner until feedback exists or the user dismisses it. It
 * never touches approval state.
 */
export const QualityFeedbackPromptController: React.FC<QualityFeedbackPromptControllerProps> = ({
  enabled,
  project,
  userId,
  subjectType,
  subjectId,
  stageKey,
  subjectLabel,
  canSubmit,
  promptReady,
  suppressModal = false,
  onOpenPanel,
  testIdPrefix: p = 'quality-feedback',
}) => {
  const active = enabled && canSubmit && promptReady && Boolean(userId);
  const prompt = useQualityFeedbackPromptState({ userId, project, subjectType, subjectId, stageKey });
  const definitionsQuery = useWorkflowEvaluationDefinitions({ project, subjectType, stageKey, enabled: active });
  const eventsQuery = useWorkflowEvaluationEvents({
    project,
    subjectType,
    subjectId,
    stageKey,
    includeOlderVersions: true,
    enabled: active,
  });
  const settled = eventsQuery.isSuccess
    && definitionsQuery.isSuccess
    && definitionsQuery.data.definitions.some((definition) => definition.stageKey === stageKey);
  const hasEvent = (eventsQuery.data?.events ?? []).some((event) => event.stageKey === stageKey);
  const eligible = active && settled && !hasEvent;
  const modalVisible = eligible && !prompt.modalSeen && !suppressModal;
  const bannerVisible = eligible && !prompt.bannerDismissed && !modalVisible;
  const { recordModalShown } = prompt;

  useEffect(() => {
    if (modalVisible) recordModalShown();
  }, [modalVisible, recordModalShown]);

  return (
    <>
      {modalVisible && (
        <QualityFeedbackPromptModal
          subjectLabel={subjectLabel}
          testIdPrefix={p}
          data-testid={`${p}-modal`}
          onGiveFeedback={() => {
            prompt.markModalSeen();
            onOpenPanel();
          }}
          onSkip={prompt.markModalSeen}
        />
      )}
      {bannerVisible && (
        <div className={styles.banner} role="region" aria-label="Quality feedback" {...{ 'data-testid': `${p}-banner` }}>
          <span className={styles.bannerText}>
            How well did the AI write this {subjectLabel}? Feedback is optional and never blocks approval.
          </span>
          <div className={styles.bannerActions}>
            <button
              type="button"
              className={styles.bannerPrimary}
              onClick={onOpenPanel}
              {...{ 'data-testid': `${p}-banner-open` }}
            >
              Open Quality feedback
            </button>
            <button
              type="button"
              className={styles.bannerDismiss}
              onClick={prompt.dismissBanner}
              aria-label="Dismiss quality feedback banner"
              {...{ 'data-testid': `${p}-banner-dismiss` }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </>
  );
};

interface QualityFeedbackPromptModalProps {
  subjectLabel: string;
  testIdPrefix: string;
  'data-testid': string;
  onGiveFeedback: () => void;
  onSkip: () => void;
}

const QualityFeedbackPromptModal: React.FC<QualityFeedbackPromptModalProps> = ({
  subjectLabel,
  testIdPrefix: p,
  'data-testid': testId,
  onGiveFeedback,
  onSkip,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(dialogRef, { open: true, onClose: onSkip });

  return (
    <div
      className={styles.overlay}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onSkip();
      }}
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...{ 'data-testid': testId }}
      >
        <h2 id={titleId} className={styles.title}>How well did the AI write this {subjectLabel}?</h2>
        <p className={styles.body}>
          Feedback is optional and improves the AI over time. It never blocks review or approval.
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={onSkip}
            {...{ 'data-testid': `${p}-modal-skip` }}
          >
            Skip
          </button>
          <button
            type="button"
            className={styles.primary}
            onClick={onGiveFeedback}
            {...{ 'data-testid': `${p}-modal-give-feedback` }}
          >
            Give feedback
          </button>
        </div>
      </div>
    </div>
  );
};
