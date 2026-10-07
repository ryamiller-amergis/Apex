import React, { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import type { InterviewBriefRecord, InterviewBriefSections } from '../../shared/types/interview';
import styles from './InterviewBriefReview.module.css';

interface BriefFormValues {
  problemAndOutcome: string;
  users: string;
  scope: string;
  businessRules: string;
  scenarios: string;
  acceptanceCriteria: string;
  assumptions: string;
  unresolvedItems: string;
}

interface InterviewBriefReviewProps {
  brief: InterviewBriefRecord | null | undefined;
  isLoading: boolean;
  isSaving: boolean;
  isDrafting: boolean;
  isApproving: boolean;
  error?: string | null;
  onSave: (sections: InterviewBriefSections) => Promise<void>;
  onDraft: () => Promise<void>;
  onApprove: () => Promise<void>;
}

const EMPTY_VALUES: BriefFormValues = {
  problemAndOutcome: '',
  users: '',
  scope: '',
  businessRules: '',
  scenarios: '',
  acceptanceCriteria: '',
  assumptions: '',
  unresolvedItems: '',
};

const FIELDS: Array<{ key: Exclude<keyof BriefFormValues, 'unresolvedItems'>; label: string }> = [
  { key: 'problemAndOutcome', label: 'Problem and outcome' },
  { key: 'users', label: 'Users' },
  { key: 'scope', label: 'Scope' },
  { key: 'businessRules', label: 'Business rules' },
  { key: 'scenarios', label: 'Main scenarios' },
  { key: 'acceptanceCriteria', label: 'Acceptance criteria' },
  { key: 'assumptions', label: 'Assumptions' },
];

export const InterviewBriefReview: React.FC<InterviewBriefReviewProps> = ({
  brief,
  isLoading,
  isSaving,
  isDrafting,
  isApproving,
  error = null,
  onSave,
  onDraft,
  onApprove,
}) => {
  const { register, handleSubmit, reset, formState: { isDirty } } = useForm<BriefFormValues>({
    defaultValues: EMPTY_VALUES,
  });

  useEffect(() => {
    if (!brief) {
      reset(EMPTY_VALUES);
      return;
    }
    reset({
      ...brief.sections,
      unresolvedItems: brief.sections.unresolvedItems.join('\n'),
    });
  }, [brief, reset]);

  const approved = brief?.status === 'approved';
  const submit = handleSubmit(async (values) => {
    await onSave({
      ...values,
      unresolvedItems: values.unresolvedItems
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean),
    });
  });

  if (isLoading) return <div className={styles.state}>Loading brief…</div>;

  return (
    <section className={styles.panel} aria-labelledby="interview-brief-heading">
      <div className={styles.header}>
        <div>
          <h2 id="interview-brief-heading">Review interview brief</h2>
          <p>Confirm the requirements that will become the canonical PRD input.</p>
        </div>
        <span className={styles.status}>{approved ? 'Approved' : `Draft v${brief?.version ?? 0}`}</span>
      </div>

      {error && <div className={styles.error} role="alert">{error}</div>}

      <form
        onSubmit={(event) => void submit(event)}
        className={styles.form}
        {...{ 'data-testid': 'interview-brief-form' }}
      >
        {FIELDS.map((field) => (
          <label key={field.key} className={styles.field}>
            <span>{field.label}</span>
            <textarea
              rows={3}
              disabled={approved}
              {...register(field.key)}
              {...{ 'data-testid': `interview-brief-${field.key}` }}
            />
          </label>
        ))}
        <label className={styles.field}>
          <span>Unresolved items</span>
          <small>Enter one item per line. Approval is allowed with unresolved items.</small>
          <textarea
            rows={3}
            disabled={approved}
            {...register('unresolvedItems')}
            {...{ 'data-testid': 'interview-brief-unresolvedItems' }}
          />
        </label>

        <div className={styles.actions}>
          {!approved && (
            <>
              <button
                type="button"
                className={styles.secondary}
                disabled={isDrafting || isSaving || isApproving || isDirty}
                onClick={() => void onDraft()}
                {...{ 'data-testid': 'draft-interview-brief' }}
                title={isDirty ? 'Save or discard changes before drafting again' : undefined}
              >
                {isDrafting ? 'Drafting…' : (brief ? 'Redraft from conversation' : 'Draft from conversation')}
              </button>
              <button
                type="submit"
                className={styles.secondary}
                disabled={isDrafting || isSaving || isApproving || !isDirty}
                {...{ 'data-testid': 'save-interview-brief' }}
              >
                {isSaving ? 'Saving…' : 'Save draft'}
              </button>
              <button
                type="button"
                className={styles.primary}
                disabled={isDrafting || isSaving || isApproving || !brief || isDirty}
                onClick={() => void onApprove()}
                {...{ 'data-testid': 'approve-interview-brief' }}
                title={isDirty ? 'Save changes before approving' : undefined}
              >
                {isApproving ? 'Approving…' : 'Approve brief'}
              </button>
            </>
          )}
        </div>
      </form>
    </section>
  );
};
