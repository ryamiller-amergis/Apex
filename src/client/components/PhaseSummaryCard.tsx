import React, { useEffect, useRef, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { PhaseName } from '../../shared/types/interview';
import {
  useAmendRequirementsSummary,
  useApprovePhaseSummary,
  useEditPhaseSummary,
  useGenerateRequirementsSummary,
  usePhaseSummary,
} from '../hooks/useInterviews';
import styles from './PhaseSummaryCard.module.css';

const summarySchema = z.object({
  content: z.string(),
});

type SummaryFormValues = z.infer<typeof summarySchema>;

interface PhaseSummaryCardProps {
  interviewId: string;
  phase: PhaseName;
  currentUserId: string | null | undefined;
  technicalOwnerId: string | null | undefined;
  canManage: boolean;
  'data-testid'?: string;
}

export const PhaseSummaryCard: React.FC<PhaseSummaryCardProps> = ({
  interviewId,
  phase,
  currentUserId,
  technicalOwnerId,
  canManage,
  'data-testid': testId,
}) => {
  const [isAmending, setIsAmending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const draftSavePromiseRef = useRef<Promise<unknown> | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    watch,
    getValues,
    setError,
    formState: { errors },
  } = useForm<SummaryFormValues>({
    resolver: zodResolver(summarySchema),
    defaultValues: { content: '' },
  });
  const summaryQuery = usePhaseSummary(interviewId, phase);
  const editSummary = useEditPhaseSummary();
  const generateSummary = useGenerateRequirementsSummary();
  const approveSummary = useApprovePhaseSummary();
  const amendSummary = useAmendRequirementsSummary();

  const summary = summaryQuery.data;
  const content = watch('content');
  const contentField = register('content');

  useEffect(() => {
    reset({ content: summary?.content ?? '' });
  }, [interviewId, reset]); // eslint-disable-line react-hooks/exhaustive-deps -- rebind only when the interview changes

  useEffect(() => {
    if (!summary) return;
    const local = getValues('content');
    if (local.trim() !== '' && local !== summary.content) return;
    reset({ content: summary.content });
  }, [getValues, reset, summary]);

  if (summaryQuery.isLoading) {
    return (
      <div
        className={styles.loading}
        role="status"
        aria-label={`Loading ${phase} phase summary`}
        {...{ 'data-testid': `phase-summary-${phase}-loading` }}
      >
        Loading phase summary…
      </div>
    );
  }
  if (summaryQuery.isError || !summary) {
    return (
      <div
        className={styles.error}
        role="alert"
        {...{ 'data-testid': `phase-summary-${phase}-error` }}
      >
        Unable to load the phase summary.
      </div>
    );
  }

  const isOwner = summary.ownerId != null && summary.ownerId === currentUserId;
  const isTechnicalOwner =
    technicalOwnerId != null && technicalOwnerId === currentUserId;
  const canEditDraft =
    canManage && isOwner && summary.status === 'draft' && !summary.locked;
  const canAmend =
    canManage
    && phase === 'requirements'
    && summary.status === 'approved'
    && summary.amendable
    && isTechnicalOwner;
  const isPending =
    editSummary.isPending
    || generateSummary.isPending
    || approveSummary.isPending
    || amendSummary.isPending;
  const title = `${phase === 'requirements' ? 'Requirements' : 'Technical'} Summary`;

  const saveDraftIfChanged = async (): Promise<void> => {
    if (!canEditDraft || content === summary.content) return;
    const savePromise = editSummary.mutateAsync({ interviewId, phase, content });
    draftSavePromiseRef.current = savePromise;
    try {
      await savePromise;
    } finally {
      if (draftSavePromiseRef.current === savePromise) {
        draftSavePromiseRef.current = null;
      }
    }
  };

  const approve = handleSubmit(async ({ content: submittedContent }) => {
    setActionError(null);
    if (submittedContent.trim().length === 0) {
      setError('content', {
        type: 'validate',
        message: 'Please add content to the summary before approving.',
      });
      return;
    }
    try {
      if (draftSavePromiseRef.current) {
        await draftSavePromiseRef.current;
      } else if (submittedContent !== summary.content) {
        await editSummary.mutateAsync({
          interviewId,
          phase,
          content: submittedContent,
        });
      }
      await approveSummary.mutateAsync({ interviewId, phase });
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Unable to approve the summary.',
      );
    }
  });

  const generate = async (): Promise<void> => {
    setActionError(null);
    try {
      const generated = await generateSummary.mutateAsync({ interviewId });
      reset({ content: generated.content });
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : 'Unable to load the generated summary.',
      );
    }
  };

  const saveAmendment = handleSubmit(async ({ content: submittedContent }) => {
    setActionError(null);
    try {
      await amendSummary.mutateAsync({
        interviewId,
        content: submittedContent,
      });
      setIsAmending(false);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Failed to save amendment.',
      );
    }
  });

  const cancelAmendment = (): void => {
    reset({ content: summary.content });
    setActionError(null);
    setIsAmending(false);
  };

  return (
    <section
      className={styles.card}
      aria-labelledby={`phase-summary-${phase}-title`}
      {...{ 'data-testid': testId ?? `phase-summary-${phase}-card` }}
    >
      <header className={styles.header}>
        <h2 id={`phase-summary-${phase}-title`} className={styles.title}>
          {title}
        </h2>
        {canAmend && !isAmending && (
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => {
              setActionError(null);
              setIsAmending(true);
            }}
            aria-label={`Amend ${title}`}
            title="Amend approved summary"
            {...{ 'data-testid': `phase-summary-${phase}-amend` }}
          >
            ✎
          </button>
        )}
      </header>

      <div className={styles.body}>
        {isAmending ? (
          <>
            <textarea
              rows={7}
              className={`${styles.textarea} ${styles.amendTextarea}`}
              aria-label={`Amend ${title}`}
              disabled={isPending}
              {...contentField}
              {...{ 'data-testid': `phase-summary-${phase}-amend-content` }}
            />
            <p className={styles.amendNotice}>
              You are amending an approved summary. The Requirements owner will
              be notified when you save.
            </p>
          </>
        ) : canEditDraft ? (
          <>
            <textarea
              rows={7}
              className={styles.textarea}
              aria-label={title}
              disabled={isPending}
              {...contentField}
              onBlur={(event) => {
                void contentField.onBlur(event);
                void saveDraftIfChanged();
              }}
              {...{ 'data-testid': `phase-summary-${phase}-content` }}
            />
            <p className={styles.helper}>
              Edit freely — this summary is not yet approved.
            </p>
          </>
        ) : (
          <div
            className={styles.readonly}
            {...{ 'data-testid': `phase-summary-${phase}-readonly` }}
          >
            {summary.content || 'No summary content yet.'}
          </div>
        )}

        {(errors.content?.message || actionError) && (
          <div className={styles.validation} role="alert">
            {errors.content?.message ?? actionError}
          </div>
        )}

        {summary.approvedAt && !isAmending && (
          <p className={styles.timestamp}>
            Approved {new Date(summary.approvedAt).toLocaleString()}
          </p>
        )}
      </div>

      <footer className={styles.footer}>
        {summary.status === 'approved' && (
          <span
            className={styles.approved}
            {...{ 'data-testid': `phase-summary-${phase}-approved` }}
          >
            ✓ Approved
          </span>
        )}
        {isAmending ? (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={cancelAmendment}
              disabled={isPending}
              {...{ 'data-testid': `phase-summary-${phase}-cancel-amendment` }}
            >
              Cancel
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => void saveAmendment()}
              disabled={isPending}
              {...{ 'data-testid': `phase-summary-${phase}-save-amendment` }}
            >
              {amendSummary.isPending ? 'Saving…' : 'Save Amendment'}
            </button>
          </div>
        ) : canEditDraft ? (
          <>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => void generate()}
              disabled={isPending || phase !== 'requirements'}
              title={
                phase === 'requirements'
                  ? 'Load the summary generated by the Requirements phase'
                  : 'Technical summary generation is not available yet'
              }
              {...{ 'data-testid': `phase-summary-${phase}-generate` }}
            >
              {generateSummary.isPending ? 'Generating…' : 'Generate with AI'}
            </button>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => void approve()}
                disabled={isPending || content.trim().length === 0}
                {...{ 'data-testid': `phase-summary-${phase}-approve` }}
              >
                {approveSummary.isPending ? 'Approving…' : 'Approve Summary'}
              </button>
            </div>
          </>
        ) : null}
      </footer>
    </section>
  );
};
