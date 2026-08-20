import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  RFP_EVALUATION_CHAT_MAX_MESSAGE_CHARS,
  RFP_VERDICTS,
  type RfpReviewerDecision,
  type RfpVerdict,
  type SuggestedReviewerDecision,
} from '../../shared/types/rfpIntake';
import { parseReviewerDecisionFence } from '../../shared/utils/rfpReviewerDecision';
import { formatVerdictLabel } from '../../shared/utils/rfpEvaluationDisplay';
import { useAskRfpEvaluationChat, useRfpEvaluationChat } from '../hooks/useRfpIntake';
import { useApplyRfpReviewerDecision } from '../hooks/useRfpTriage';
import styles from './RfpEvaluationCard.module.css';

const reviewerDecisionSchema = z.object({
  verdict: z.enum(RFP_VERDICTS as unknown as [RfpVerdict, ...RfpVerdict[]]),
  rationale: z.string().trim().min(1, 'Rationale is required').max(4000),
  constraintsToAdd: z.string().max(4000),
  reevaluate: z.boolean(),
});

type ReviewerDecisionFormValues = z.infer<typeof reviewerDecisionSchema>;

interface RfpEvaluationChatProps {
  requestId: string;
  canManage?: boolean;
  reviewerDecision?: RfpReviewerDecision | null;
}

interface RfpReviewerDecisionFormProps {
  requestId: string;
  suggestion: (SuggestedReviewerDecision & { messageId: string }) | null;
  recorded: RfpReviewerDecision | null;
  'data-testid'?: string;
}

const RfpReviewerDecisionForm: React.FC<RfpReviewerDecisionFormProps> = ({
  requestId,
  suggestion,
  recorded,
}) => {
  const apply = useApplyRfpReviewerDecision();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ReviewerDecisionFormValues>({
    resolver: zodResolver(reviewerDecisionSchema),
    defaultValues: {
      verdict: suggestion?.verdict ?? recorded?.verdict ?? 'build',
      rationale: suggestion?.rationale ?? recorded?.rationale ?? '',
      constraintsToAdd: suggestion?.constraintsToAdd ?? '',
      reevaluate: true,
    },
  });

  useEffect(() => {
    reset({
      verdict: suggestion?.verdict ?? recorded?.verdict ?? 'build',
      rationale: suggestion?.rationale ?? recorded?.rationale ?? '',
      constraintsToAdd: suggestion?.constraintsToAdd ?? '',
      reevaluate: true,
    });
  }, [suggestion, recorded, reset]);

  const onSubmit = async (values: ReviewerDecisionFormValues) => {
    await apply.mutateAsync({
      id: requestId,
      verdict: values.verdict,
      rationale: values.rationale,
      constraintsToAdd: values.constraintsToAdd.trim() || undefined,
      sourceMessageIds: suggestion ? [suggestion.messageId] : [],
      reevaluate: values.reevaluate,
    });
  };

  return (
    <form
      className={styles.applyPanel}
      onSubmit={handleSubmit((values) => void onSubmit(values))}
      {...{ 'data-testid': 'rfp-reviewer-decision-form' }}
    >
      <h3 className={styles.headline}>
        {recorded ? 'Update reviewer decision' : 'Record reviewer decision'}
      </h3>
      {suggestion && (
        <p className={styles.helper} {...{ 'data-testid': 'rfp-reviewer-decision-suggestion' }}>
          The evaluator proposed {formatVerdictLabel(suggestion.verdict)}. Apply it only if you agree.
        </p>
      )}
      <label className={styles.helper} htmlFor="rfp-reviewer-decision-verdict">Verdict</label>
      <select
        id="rfp-reviewer-decision-verdict"
        className={styles.select}
        {...register('verdict')}
        {...{ 'data-testid': 'rfp-reviewer-decision-verdict' }}
      >
        {RFP_VERDICTS.map((verdict) => (
          <option key={verdict} value={verdict}>{formatVerdictLabel(verdict)}</option>
        ))}
      </select>
      <label className={styles.helper} htmlFor="rfp-reviewer-decision-rationale">Why this call</label>
      <textarea
        id="rfp-reviewer-decision-rationale"
        className={styles.textarea}
        {...register('rationale')}
        {...{ 'data-testid': 'rfp-reviewer-decision-rationale' }}
      />
      {errors.rationale && (
        <p className={styles.error} role="alert">{errors.rationale.message}</p>
      )}
      <label className={styles.helper} htmlFor="rfp-reviewer-decision-constraints">Constraints to add</label>
      <textarea
        id="rfp-reviewer-decision-constraints"
        className={styles.textarea}
        {...register('constraintsToAdd')}
        {...{ 'data-testid': 'rfp-reviewer-decision-constraints' }}
      />
      <label className={styles.checkboxRow} htmlFor="rfp-reviewer-decision-reevaluate">
        <input
          id="rfp-reviewer-decision-reevaluate"
          type="checkbox"
          {...register('reevaluate')}
          {...{ 'data-testid': 'rfp-reviewer-decision-reevaluate' }}
        />
        Re-run evaluation with these constraints
      </label>
      {apply.isError && (
        <p className={styles.error} role="alert">
          {apply.error.message || 'Could not record the reviewer decision. Try again.'}
        </p>
      )}
      <button
        type="submit"
        className={styles.primaryButton}
        disabled={isSubmitting || apply.isPending}
        {...{ 'data-testid': 'rfp-reviewer-decision-submit' }}
      >
        {apply.isPending ? 'Applying…' : 'Apply reviewer decision'}
      </button>
    </form>
  );
};

export const RfpEvaluationChat: React.FC<RfpEvaluationChatProps> = ({
  requestId,
  canManage = false,
  reviewerDecision = null,
}) => {
  const [draft, setDraft] = useState('');
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const chatQuery = useRfpEvaluationChat(requestId, true);
  const ask = useAskRfpEvaluationChat();
  const messages = chatQuery.data ?? [];
  const suggestion = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const item = messages[index];
      if (item.role !== 'assistant') continue;
      const parsed = parseReviewerDecisionFence(item.body);
      if (parsed.suggestion) {
        return { ...parsed.suggestion, messageId: item.id };
      }
    }
    return null;
  }, [messages]);

  useEffect(() => {
    const node = transcriptRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, ask.isPending]);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || ask.isPending) return;
    try {
      await ask.mutateAsync({ id: requestId, message });
      setDraft('');
    } catch {
      // Error is shown below the composer.
    }
  };

  return (
    <section className={styles.chat} {...{ 'data-testid': 'rfp-evaluation-chat' }}>
      <h3 className={styles.headline}>Ask about this evaluation</h3>
      <p className={styles.helper}>
        Probe the reasoning — for example whether a standalone SDLC build is valid.
        Asking does not change the stored AI evaluation.
        {canManage ? ' After you agree, record a reviewer decision below.' : ''}
      </p>
      <div
        ref={transcriptRef}
        className={styles.transcript}
        aria-live="polite"
        {...{ 'data-testid': 'rfp-evaluation-chat-transcript' }}
      >
        {chatQuery.isLoading && <p className={styles.helper}>Loading conversation…</p>}
        {chatQuery.isError && (
          <p className={styles.error} role="alert">Could not load the conversation.</p>
        )}
        {!chatQuery.isLoading && messages.length === 0 && (
          <p className={styles.helper}>No questions yet. Ask why the evaluator made this call.</p>
        )}
        {messages.map((item) => {
          const body = item.role === 'assistant'
            ? parseReviewerDecisionFence(item.body).displayBody
            : item.body;
          return (
            <div
              key={item.id}
              className={`${styles.bubble} ${item.role === 'user' ? styles.user : styles.assistant}`}
              {...{ 'data-testid': `rfp-evaluation-chat-${item.role}-${item.id}` }}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
            </div>
          );
        })}
        {ask.isPending && (
          <p className={styles.helper} {...{ 'data-testid': 'rfp-evaluation-chat-pending' }}>
            Thinking…
          </p>
        )}
      </div>
      <form className={styles.composer} onSubmit={(event) => void onSubmit(event)} {...{ 'data-testid': 'rfp-evaluation-chat-form' }}>
        <label className={styles.helper} htmlFor="rfp-evaluation-chat-input">Question</label>
        <textarea
          id="rfp-evaluation-chat-input"
          className={styles.textarea}
          value={draft}
          maxLength={RFP_EVALUATION_CHAT_MAX_MESSAGE_CHARS}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Would a committed SDLC build as a standalone app be valid?"
          aria-label="Ask about this evaluation"
          {...{ 'data-testid': 'rfp-evaluation-chat-input' }}
        />
        {ask.isError && (
          <p className={styles.error} role="alert">
            {ask.error.message || 'Could not ask the evaluator. Try again.'}
          </p>
        )}
        <button
          type="submit"
          className={styles.primaryButton}
          disabled={ask.isPending || draft.trim() === ''}
          {...{ 'data-testid': 'rfp-evaluation-chat-submit' }}
        >
          {ask.isPending ? 'Asking…' : 'Ask'}
        </button>
      </form>
      {canManage && (
        <RfpReviewerDecisionForm
          requestId={requestId}
          suggestion={suggestion}
          recorded={reviewerDecision}
          {...{ 'data-testid': 'rfp-reviewer-decision-apply' }}
        />
      )}
    </section>
  );
};
