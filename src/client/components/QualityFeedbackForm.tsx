import React, { useId, useMemo, useState } from 'react';
import { useForm, type FieldPath } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type {
  WorkflowEvaluationDefinitionView,
  WorkflowEvaluationEvent,
  WorkflowEvaluationReviewerRoleState,
  WorkflowEvaluationSubjectType,
} from '../../shared/types/workflowEvaluation';
import {
  useSubmitWorkflowEvaluation,
  useWorkflowEvaluationDefinitions,
  WorkflowEvaluationApiError,
} from '../hooks/useWorkflowEvaluations';
import {
  buildQualityFeedbackSchema,
  defaultQualityFeedbackValues,
  fieldForErrorCode,
  hasLowScore,
  needsCorrectedArtifact,
  toCreateRequest,
  type QualityFeedbackFormValues,
} from '../utils/qualityFeedbackSchema';
import styles from './QualityFeedbackForm.module.css';

export type CorrectedArtifactConfig = {
  /** Section heading, e.g. "Corrected PRD". */
  label: string;
  /** Current artifact text in Apex. When present the reviewer can submit it as-is. */
  snapshotMarkdown?: string;
  /** Shown in the snapshot notice, e.g. the formatted last-updated date. */
  snapshotLabel?: string;
};

export interface QualityFeedbackFormProps {
  project: string | undefined;
  subjectType: WorkflowEvaluationSubjectType;
  subjectId: string;
  stageKey: string;
  canSubmit: boolean;
  correctedArtifact: CorrectedArtifactConfig;
  successMessage: string;
  testIdPrefix?: string;
  /** Test id for the form element; defaults to `${testIdPrefix}-form`. */
  'data-testid'?: string;
  onSubmitted?: (event: WorkflowEvaluationEvent) => void;
}

export const QualityFeedbackForm: React.FC<QualityFeedbackFormProps> = ({
  project,
  subjectType,
  subjectId,
  stageKey,
  canSubmit,
  correctedArtifact,
  successMessage,
  testIdPrefix = 'quality-feedback',
  'data-testid': formTestId = `${testIdPrefix}-form`,
  onSubmitted,
}) => {
  const definitionsQuery = useWorkflowEvaluationDefinitions({
    project,
    subjectType,
    stageKey,
    enabled: canSubmit,
  });

  if (!canSubmit) return null;

  if (definitionsQuery.isLoading) {
    return (
      <div className={styles.skeleton} aria-busy="true" {...{ 'data-testid': `${testIdPrefix}-form-loading` }}>
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className={styles.skeletonRow} />
        ))}
      </div>
    );
  }

  if (definitionsQuery.isError || !definitionsQuery.data) {
    return (
      <div className={styles.inlineError} role="alert" {...{ 'data-testid': `${testIdPrefix}-definitions-error` }}>
        <span>Couldn&apos;t load the feedback form.</span>
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => void definitionsQuery.refetch()}
          {...{ 'data-testid': `${testIdPrefix}-definitions-retry` }}
        >
          Retry
        </button>
      </div>
    );
  }

  const definition = definitionsQuery.data.definitions.find((item) => item.stageKey === stageKey);
  if (!definition) {
    return (
      <p className={styles.muted} {...{ 'data-testid': `${testIdPrefix}-definitions-missing` }}>
        Feedback isn&apos;t set up for this stage yet.
      </p>
    );
  }

  return (
    <QualityFeedbackFields
      key={`${definition.id}:${subjectId}`}
      project={project}
      subjectId={subjectId}
      definition={definition}
      reviewer={definitionsQuery.data.reviewer}
      correctedArtifact={correctedArtifact}
      successMessage={successMessage}
      testIdPrefix={testIdPrefix}
      formTestId={formTestId}
      onSubmitted={onSubmitted}
    />
  );
};

interface QualityFeedbackFieldsProps {
  project: string | undefined;
  subjectId: string;
  definition: WorkflowEvaluationDefinitionView;
  reviewer: WorkflowEvaluationReviewerRoleState;
  correctedArtifact: CorrectedArtifactConfig;
  successMessage: string;
  testIdPrefix: string;
  formTestId: string;
  onSubmitted?: (event: WorkflowEvaluationEvent) => void;
}

const QualityFeedbackFields: React.FC<QualityFeedbackFieldsProps> = ({
  project,
  subjectId,
  definition,
  reviewer,
  correctedArtifact,
  successMessage,
  testIdPrefix: p,
  formTestId,
  onSubmitted,
}) => {
  const formId = useId();
  const snapshotAvailable = Boolean(correctedArtifact.snapshotMarkdown?.trim());
  const requiresRole = reviewer.requiresSelection;
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const schema = useMemo(
    () => buildQualityFeedbackSchema(definition, { requiresRole, snapshotAvailable }),
    [definition, requiresRole, snapshotAvailable],
  );
  const defaults = useMemo(
    () => defaultQualityFeedbackValues(definition, { derivedRoleKey: reviewer.derivedRoleKey, snapshotAvailable }),
    [definition, reviewer.derivedRoleKey, snapshotAvailable],
  );
  const {
    register,
    handleSubmit,
    watch,
    reset,
    setError,
    formState: { errors },
  } = useForm<QualityFeedbackFormValues>({ resolver: zodResolver(schema), defaultValues: defaults });

  const submit = useSubmitWorkflowEvaluation({ project, subjectType: definition.subjectType, subjectId });

  const criteria = watch('criteria');
  const outcome = watch('outcome');
  const correctedSource = watch('correctedSource');
  const lowScore = hasLowScore(criteria);
  const showCorrected = needsCorrectedArtifact(definition, outcome);
  const derivedRoleLabel = reviewer.options.find((option) => option.key === reviewer.derivedRoleKey)?.label;

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    setSaved(false);
    try {
      const event = await submit.mutateAsync(
        toCreateRequest(values, { definition, subjectId, requiresRole, snapshotAvailable }),
      );
      reset(defaults);
      setSaved(true);
      onSubmitted?.(event);
    } catch (err) {
      const apiError = err instanceof WorkflowEvaluationApiError ? err : null;
      const field = fieldForErrorCode(apiError?.code);
      const message = err instanceof Error ? err.message : 'Feedback could not be saved.';
      if (field === 'criteria') {
        const firstKey = definition.criteria[0]?.key;
        if (firstKey) {
          setError(`criteria.${firstKey}` as FieldPath<QualityFeedbackFormValues>, { message }, { shouldFocus: true });
          return;
        }
      } else if (field) {
        setError(field, { message }, { shouldFocus: true });
        return;
      }
      setSubmitError(message);
    }
  });

  const errorFor = (name: string, message: string | undefined) =>
    message ? (
      <p id={`${formId}-${name}-error`} className={styles.fieldError} role="alert" {...{ 'data-testid': `${p}-error-${name}` }}>
        {message}
      </p>
    ) : null;

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate {...{ 'data-testid': formTestId }}>
      <fieldset className={styles.fieldsetReset} disabled={submit.isPending}>
        {definition.criteria.map((criterion) => {
          const error = errors.criteria?.[criterion.key]?.message;
          const helpId = `${formId}-${criterion.key}-help`;
          return (
            <fieldset
              key={criterion.key}
              className={styles.criterion}
              aria-describedby={error ? `${helpId} ${formId}-${criterion.key}-error` : helpId}
              aria-invalid={Boolean(error)}
              {...{ 'data-testid': `${p}-criterion-${criterion.key}` }}
            >
              <legend className={styles.legend}>{criterion.label}</legend>
              <p id={helpId} className={styles.help}>{criterion.helpText}</p>
              <div className={styles.scale}>
                {definition.scale.map((entry) => (
                  <label key={entry.score} className={styles.scaleOption}>
                    <input
                      type="radio"
                      value={String(entry.score)}
                      {...register(`criteria.${criterion.key}` as FieldPath<QualityFeedbackFormValues>)}
                      {...{ 'data-testid': `${p}-score-${criterion.key}-${entry.score}` }}
                    />
                    <span className={styles.scaleScore}>{entry.score}</span>
                    <span className={styles.scaleLabel}>{entry.label}</span>
                  </label>
                ))}
              </div>
              {errorFor(criterion.key, error)}
            </fieldset>
          );
        })}

        <fieldset className={styles.group} aria-invalid={Boolean(errors.outcome)}>
          <legend className={styles.legend}>Outcome</legend>
          <div className={styles.options}>
            {definition.outcomes.map((item) => (
              <label key={item.key} className={styles.option}>
                <input
                  type="radio"
                  value={item.key}
                  {...register('outcome')}
                  {...{ 'data-testid': `${p}-outcome-${item.key}` }}
                />
                {item.label}
              </label>
            ))}
          </div>
          {errorFor('outcome', errors.outcome?.message)}
        </fieldset>

        {lowScore && (
          <fieldset className={styles.group} aria-invalid={Boolean(errors.reasonCodes)}>
            <legend className={styles.legend}>What went wrong?</legend>
            <p className={styles.help}>Needed because a score is 2 or lower.</p>
            <div className={styles.options}>
              {definition.reasonCodes.map((reason) => (
                <label key={reason.key} className={styles.option}>
                  <input
                    type="checkbox"
                    value={reason.key}
                    {...register('reasonCodes')}
                    {...{ 'data-testid': `${p}-reason-${reason.key}` }}
                  />
                  {reason.label}
                </label>
              ))}
            </div>
            {errorFor('reasonCodes', errors.reasonCodes?.message)}
          </fieldset>
        )}

        <div className={styles.group}>
          <label className={styles.legend} htmlFor={`${formId}-comment`}>
            Comment{lowScore ? '' : ' (optional)'}
          </label>
          {lowScore && (
            <p className={styles.help}>At least {definition.minLowScoreCommentLength} characters.</p>
          )}
          <textarea
            id={`${formId}-comment`}
            className={styles.textarea}
            rows={4}
            aria-invalid={Boolean(errors.comment)}
            aria-describedby={errors.comment ? `${formId}-comment-error` : undefined}
            {...register('comment')}
            {...{ 'data-testid': `${p}-comment` }}
          />
          {errorFor('comment', errors.comment?.message)}
        </div>

        <div className={styles.group}>
          {requiresRole ? (
            <>
              <label className={styles.legend} htmlFor={`${formId}-role`}>Your role</label>
              <select
                id={`${formId}-role`}
                className={styles.select}
                aria-invalid={Boolean(errors.reviewerRole)}
                {...register('reviewerRole')}
                {...{ 'data-testid': `${p}-role-select` }}
              >
                <option value="">Choose a role…</option>
                {reviewer.options.map((option) => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </select>
              {errorFor('reviewerRole', errors.reviewerRole?.message)}
            </>
          ) : (
            <p className={styles.help} {...{ 'data-testid': `${p}-role` }}>
              Submitting as <strong>{derivedRoleLabel ?? 'reviewer'}</strong> (from your project groups).
            </p>
          )}
        </div>

        {showCorrected && (
          <fieldset className={styles.group} aria-invalid={Boolean(errors.correctedText)}>
            <legend className={styles.legend}>{correctedArtifact.label}</legend>
            {snapshotAvailable && (
              <div className={styles.options}>
                <label className={styles.option}>
                  <input
                    type="radio"
                    value="current_prd"
                    {...register('correctedSource')}
                    {...{ 'data-testid': `${p}-corrected-source-snapshot` }}
                  />
                  Use the current version in Apex
                </label>
                <label className={styles.option}>
                  <input
                    type="radio"
                    value="pasted"
                    {...register('correctedSource')}
                    {...{ 'data-testid': `${p}-corrected-source-paste` }}
                  />
                  Paste a corrected version
                </label>
              </div>
            )}
            {snapshotAvailable && correctedSource === 'current_prd' ? (
              <p className={styles.help} {...{ 'data-testid': `${p}-snapshot-notice` }}>
                Snapshot captured automatically from Apex
                {correctedArtifact.snapshotLabel ? ` (last updated ${correctedArtifact.snapshotLabel})` : ''}.
              </p>
            ) : (
              <>
                <label className={styles.srOnly} htmlFor={`${formId}-corrected`}>Corrected version (pasted)</label>
                <textarea
                  id={`${formId}-corrected`}
                  className={styles.textarea}
                  rows={8}
                  placeholder="Paste the corrected version here"
                  aria-invalid={Boolean(errors.correctedText)}
                  {...register('correctedText')}
                  {...{ 'data-testid': `${p}-paste-field` }}
                />
              </>
            )}
            {errorFor('correctedText', errors.correctedText?.message)}
          </fieldset>
        )}

        {submitError && (
          <p className={styles.submitError} role="alert" {...{ 'data-testid': `${p}-submit-error` }}>
            {submitError}
          </p>
        )}
        {saved && (
          <p className={styles.success} role="status" {...{ 'data-testid': `${p}-success` }}>
            {successMessage}
          </p>
        )}

        <div className={styles.actions}>
          <button
            type="submit"
            className={styles.primaryButton}
            {...{ 'data-testid': `${p}-submit` }}
          >
            {submit.isPending ? 'Submitting…' : 'Submit feedback'}
          </button>
        </div>
      </fieldset>
    </form>
  );
};
