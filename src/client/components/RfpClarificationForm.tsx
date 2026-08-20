import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { RfpRequestDetail } from '../../shared/types/rfpIntake';
import { useClarifyRfpRequest } from '../hooks/useRfpIntake';
import {
  rfpIntakeFormSchema,
  toRfpIntakePayload,
  type RfpIntakeFormValues,
} from './rfpIntakeFormSchema';
import styles from './RfpIntakeLanding.module.css';

interface RfpClarificationFormProps {
  detail: RfpRequestDetail;
}

export const RfpClarificationForm: React.FC<RfpClarificationFormProps> = ({ detail }) => {
  const clarify = useClarifyRfpRequest();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RfpIntakeFormValues>({
    resolver: zodResolver(rfpIntakeFormSchema),
    defaultValues: {
      title: detail.title,
      stakeholder: detail.stakeholder,
      request: detail.request,
      problem: detail.problem,
      audience: detail.audience,
      dataSensitivity: detail.dataSensitivity,
      existingSolution: detail.existingSolution,
      advantage: detail.advantage ?? '',
      constraints: detail.constraints ?? '',
      requestType: detail.requestType ?? '',
      existingSystemStack: detail.existingSystemStack ?? '',
    },
  });

  const onSubmit = async (values: RfpIntakeFormValues) => {
    await clarify.mutateAsync({ id: detail.id, intake: toRfpIntakePayload(values) });
  };

  return (
    <form
      className={styles.form}
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
      {...{ 'data-testid': 'rfp-clarification-form' }}
    >
      <h3 className={styles.blockTitle}>Answer clarifying questions</h3>
      {detail.currentEvaluation?.clarifyingQuestions?.map((question) => (
        <p key={question} className={styles.subtitle}>{question}</p>
      ))}
      <label className={styles.field}>
        <span className={styles.label}>Updated request</span>
        <textarea className={styles.textarea} {...register('request')} {...{ 'data-testid': 'rfp-clarify-request' }} />
        {errors.request && <span className={styles.fieldError}>{errors.request.message}</span>}
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Updated problem</span>
        <textarea className={styles.textarea} {...register('problem')} {...{ 'data-testid': 'rfp-clarify-problem' }} />
      </label>
      {clarify.isError && (
        <p className={styles.fieldError} role="alert">{clarify.error.message}</p>
      )}
      <button
        type="submit"
        className={styles.primaryButton}
        disabled={isSubmitting || clarify.isPending}
        {...{ 'data-testid': 'rfp-clarify-submit' }}
      >
        {clarify.isPending ? 'Resubmitting…' : 'Resubmit for evaluation'}
      </button>
    </form>
  );
};
