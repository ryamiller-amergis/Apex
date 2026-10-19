import React from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { atsBoardRunInput, type AtsBoardCharterFields } from '../../shared/atsBoard';
import styles from './AtsBoardLaunchForm.module.css';

const charterSchema = z.object({
  objective: z.string().trim().min(20, 'Describe the outcome in a sentence or two.'),
  separation: z.string().trim().min(10, 'Say what separating from the current system must achieve.'),
  staffingModel: z.string().trim().min(10, 'Name the staffing model this Phase 1 serves.'),
  boundaries: z.string().trim().min(10, 'Name what Phase 1 will not do.'),
  nonNegotiables: z.string().trim().min(5, 'Name at least one rule the board cannot break.'),
  authorizeNamedResearch: z.boolean(),
}).superRefine((value, ctx) => {
  const text = [value.objective, value.separation, value.staffingModel, value.boundaries, value.nonNegotiables].join('\n');
  if (/\b(aya|erecruit)\b/i.test(text) && !value.authorizeNamedResearch) {
    ctx.addIssue({
      code: 'custom',
      path: ['authorizeNamedResearch'],
      message: 'Named research for Aya or eRecruit needs explicit authorization.',
    });
  }
});

interface AtsBoardLaunchFormProps {
  pending: boolean;
  onCancel: () => void;
  onStart: (runInput: Record<string, unknown>) => void;
  'data-testid'?: string;
}

export const AtsBoardLaunchForm: React.FC<AtsBoardLaunchFormProps> = ({
  pending,
  onCancel,
  onStart,
  'data-testid': testId = 'ats-board-launch-form',
}) => {
  const { register, handleSubmit, formState: { errors } } = useForm<AtsBoardCharterFields>({
    resolver: zodResolver(charterSchema),
    defaultValues: { authorizeNamedResearch: false },
  });

  return (
    <form
      className={styles.form}
      onSubmit={handleSubmit((fields) => onStart(atsBoardRunInput(fields)))}
      {...{ 'data-testid': testId }}
    >
      <p className={styles.intro}>
        The board proposes. You ratify. Names, prices, and contact details are removed before the agents see the charter.
      </p>
      <label className={styles.field}>
        Outcome
        <textarea {...register('objective')} {...{ 'data-testid': 'ats-board-objective' }} />
        {errors.objective ? <span className={styles.error}>{errors.objective.message}</span> : null}
      </label>
      <label className={styles.field}>
        Separation
        <textarea {...register('separation')} {...{ 'data-testid': 'ats-board-separation' }} />
        {errors.separation ? <span className={styles.error}>{errors.separation.message}</span> : null}
      </label>
      <label className={styles.field}>
        Staffing model
        <textarea {...register('staffingModel')} {...{ 'data-testid': 'ats-board-staffing-model' }} />
        {errors.staffingModel ? <span className={styles.error}>{errors.staffingModel.message}</span> : null}
      </label>
      <label className={styles.field}>
        Out of scope
        <textarea {...register('boundaries')} {...{ 'data-testid': 'ats-board-boundaries' }} />
        {errors.boundaries ? <span className={styles.error}>{errors.boundaries.message}</span> : null}
      </label>
      <label className={styles.field}>
        Rules the board cannot break
        <textarea {...register('nonNegotiables')} {...{ 'data-testid': 'ats-board-non-negotiables' }} />
        {errors.nonNegotiables ? <span className={styles.error}>{errors.nonNegotiables.message}</span> : null}
      </label>
      <label className={styles.check}>
        <input type="checkbox" {...register('authorizeNamedResearch')} {...{ 'data-testid': 'ats-board-authorize-research' }} />
        <span>Authorize public research that names Aya or eRecruit.</span>
      </label>
      {errors.authorizeNamedResearch ? (
        <p className={styles.error} role="alert">{errors.authorizeNamedResearch.message}</p>
      ) : null}
      <div className={styles.actions}>
        <button type="submit" disabled={pending} {...{ 'data-testid': 'ats-board-start' }}>
          {pending ? 'Starting…' : 'Start board review'}
        </button>
        <button type="button" onClick={onCancel} {...{ 'data-testid': 'ats-board-cancel' }}>
          Cancel
        </button>
      </div>
    </form>
  );
};
