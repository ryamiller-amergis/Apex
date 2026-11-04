import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { BUILD_REVISION_FEEDBACK_MAX_LENGTH } from '../../shared/types/buildRevision';
import styles from './RequestChangesDialog.module.css';

const feedbackSchema = z.object({
  feedback: z
    .string()
    .transform((v) => v)
    .refine((v) => v.trim().length > 0, {
      message: 'Describe what you want changed.',
    })
    .refine((v) => v.trim().length <= BUILD_REVISION_FEEDBACK_MAX_LENGTH, {
      message: 'Use 4,000 characters or fewer.',
    }),
});

type FormValues = z.infer<typeof feedbackSchema>;

export interface RequestChangesDialogProps {
  open: boolean;
  actingForRequester: boolean;
  requesterDisplayName: string;
  onClose: () => void;
  onSubmit: (feedback: string) => Promise<unknown>;
}

export const RequestChangesDialog: React.FC<RequestChangesDialogProps> = ({
  open,
  actingForRequester,
  requesterDisplayName,
  onClose,
  onSubmit,
}) => {
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(feedbackSchema),
    defaultValues: { feedback: '' },
  });

  if (!open) return null;

  const currentFeedback = watch('feedback') ?? '';
  const trimmedCount = currentFeedback.trim().length;
  const titleText = actingForRequester
    ? `Request changes for ${requesterDisplayName}`
    : 'Request changes';
  const submitLabel = isSubmitting
    ? 'Sending…'
    : actingForRequester
      ? `Send changes for ${requesterDisplayName}`
      : 'Send changes';
  const displayedError = errors.feedback?.message ?? serverError;

  const onFormSubmit = async (values: FormValues) => {
    setServerError(null);
    try {
      await onSubmit(values.feedback.trim());
      onClose();
    } catch (err) {
      setServerError(
        err instanceof Error && err.message
          ? err.message
          : 'Could not send your changes. Try again.',
      );
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="build-request-changes-title"
      className={styles.backdrop}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      {...{ 'data-testid': 'build-request-changes-dialog' }}
    >
      <div className={styles.dialog}>
        <h2 id="build-request-changes-title" className={styles.title}>
          {titleText}
        </h2>
        {actingForRequester && (
          <p
            className={styles.onBehalf}
            {...{ 'data-testid': 'build-request-changes-on-behalf-of' }}
          >
            {`Request changes for ${requesterDisplayName}`}
          </p>
        )}
        <form
          onSubmit={handleSubmit(onFormSubmit)}
          noValidate
          className={styles.form}
          {...{ 'data-testid': 'build-request-changes-form' }}
        >
          <label
            htmlFor="build-request-changes-feedback-input"
            className={styles.label}
          >
            What should change?
          </label>
          <textarea
            id="build-request-changes-feedback-input"
            rows={5}
            aria-describedby="build-request-changes-help build-request-changes-count-el"
            className={styles.textarea}
            {...register('feedback')}
            {...{ 'data-testid': 'build-request-changes-feedback' }}
          />
          <div className={styles.metaRow}>
            <span id="build-request-changes-help" className={styles.helpText}>
              We remove passwords and keys from what you write before saving it.
            </span>
            <span
              id="build-request-changes-count-el"
              className={styles.countText}
              {...{ 'data-testid': 'build-request-changes-count' }}
            >
              {`${trimmedCount} / ${BUILD_REVISION_FEEDBACK_MAX_LENGTH}`}
            </span>
          </div>
          {displayedError && (
            <p
              role="alert"
              className={styles.errorText}
              {...{ 'data-testid': 'build-request-changes-error' }}
            >
              {displayedError}
            </p>
          )}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.cancelButton}
              onClick={onClose}
              {...{ 'data-testid': 'build-request-changes-cancel' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className={styles.submitButton}
              {...{ 'data-testid': 'build-request-changes-submit' }}
            >
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
