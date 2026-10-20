/**
 * The human review for a parked `feedback-review` step.
 *
 * Choices come from the AI steps named on the step. The panel does not search the run for other agents.
 */
import React, { useMemo, useState } from 'react';
import {
  FEEDBACK_REVIEW_ACTIONS,
  FEEDBACK_REVIEW_ACTION_LABELS,
  feedbackItemKey,
  noteRequired,
  promptsForSources,
  type FeedbackReviewAction,
  type FeedbackReviewItem,
} from '../../shared/feedbackReview';
import type { PlaybookRunDetail, PlaybookStepRun } from '../../shared/types/playbook';
import { PlaybookRunApiError, usePlaybookFeedbackDecision } from '../hooks/usePlaybookRuns';
import styles from './PlaybookGateReviewPanel.module.css';

function sourceIds(step: PlaybookStepRun): string[] {
  const value = step.inputInline?.sourceStepIds;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export const PlaybookFeedbackReviewPanel: React.FC<{
  project: string;
  run: PlaybookRunDetail;
  'data-testid'?: string;
}> = ({ project, run, ...rest }) => {
  const reviewStep = run.steps.find(
    (step) => step.stepId === run.suspension?.stepId && step.status === 'suspended'
  );
  const isFeedback = run.suspension?.reason === 'feedback_review';
  const prompts = useMemo(() => {
    if (!reviewStep) return [];
    const selected = new Set(sourceIds(reviewStep));
    return promptsForSources(
      run.steps
        .filter((step) => selected.has(step.stepId) && step.status === 'completed')
        .map((step) => ({ stepId: step.stepId, output: step.outputInline }))
    );
  }, [reviewStep, run.steps]);
  const [items, setItems] = useState<Record<string, FeedbackReviewItem>>({});
  const [comment, setComment] = useState('');
  const decision = usePlaybookFeedbackDecision(project, run.runId, reviewStep?.id ?? '');

  if (!isFeedback || !reviewStep) return null;

  const subject =
    typeof reviewStep.inputInline?.subject === 'string'
      ? reviewStep.inputInline.subject
      : 'Review the selected AI work';
  const choices = prompts.map((prompt) => {
    const current = items[feedbackItemKey(prompt)];
    return (
      current ?? {
        sourceStepId: prompt.sourceStepId,
        itemId: prompt.itemId,
        action: 'accept' as const,
      }
    );
  });
  const missingNote = choices.some((item) => noteRequired(item.action) && !item.note?.trim());
  const error = decision.error instanceof PlaybookRunApiError ? decision.error.message : null;

  const update = (key: string, patch: Partial<FeedbackReviewItem>, base: FeedbackReviewItem) => {
    setItems((current) => ({ ...current, [key]: { ...base, ...current[key], ...patch } }));
  };

  const submit = (stopped: boolean) => {
    const note = comment.trim();
    decision.mutate({
      stopped,
      ...(note ? { comment: note } : {}),
      items: choices.map((item) => ({
        sourceStepId: item.sourceStepId,
        itemId: item.itemId,
        action: item.action,
        ...(item.note?.trim() ? { note: item.note.trim() } : {}),
      })),
    });
  };

  return (
    <section
      className={styles.gate}
      aria-labelledby={`feedback-title-${reviewStep.id}`}
      {...{ 'data-testid': rest['data-testid'] ?? 'playbook-feedback-review' }}
    >
      <h3 className={styles.title} id={`feedback-title-${reviewStep.id}`}>
        {subject}
      </h3>
      <p className={styles.mode}>Choose what to do with each item. The next step will use these notes.</p>
      {prompts.length === 0 ? (
        <p className={styles.mode}>The selected AI steps have not finished yet.</p>
      ) : (
        <ul className={styles.itemList}>
          {prompts.map((prompt) => {
            const key = feedbackItemKey(prompt);
            const current = choices.find((item) => feedbackItemKey(item) === key)!;
            return (
              <li key={key} className={styles.overrideItem}>
                <p className={styles.overrideLegend}>{prompt.title}</p>
                <p className={styles.overrideQuestion}>{prompt.detail}</p>
                {prompt.recommendation ? (
                  <p className={styles.recommendation}>Suggested choice: {prompt.recommendation}</p>
                ) : null}
                <label className={styles.overrideLabel}>
                  Your choice
                  <select
                    value={current.action}
                    disabled={decision.isPending}
                    onChange={(event) =>
                      update(key, { action: event.target.value as FeedbackReviewAction }, current)
                    }
                    {...{ 'data-testid': `playbook-feedback-action-${prompt.itemId}` }}
                  >
                    {FEEDBACK_REVIEW_ACTIONS.map((action) => (
                      <option key={action} value={action}>
                        {FEEDBACK_REVIEW_ACTION_LABELS[action]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.overrideLabel}>
                  Note
                  <textarea
                    value={current.note ?? ''}
                    disabled={decision.isPending}
                    onChange={(event) => update(key, { note: event.target.value }, current)}
                    {...{ 'data-testid': `playbook-feedback-note-${prompt.itemId}` }}
                  />
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <label className={styles.note}>
        Overall note
        <textarea
          value={comment}
          disabled={decision.isPending}
          onChange={(event) => setComment(event.target.value)}
          {...{ 'data-testid': 'playbook-feedback-comment' }}
        />
      </label>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.approve}
          disabled={decision.isPending || prompts.length === 0 || missingNote}
          onClick={() => submit(false)}
          {...{ 'data-testid': 'playbook-feedback-continue' }}
        >
          Send these choices
        </button>
        <button
          type="button"
          className={styles.reject}
          disabled={decision.isPending || prompts.length === 0 || missingNote}
          onClick={() => submit(true)}
          {...{ 'data-testid': 'playbook-feedback-stop' }}
        >
          Stop this outcome
        </button>
      </div>
    </section>
  );
};

export default PlaybookFeedbackReviewPanel;
