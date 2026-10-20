import React, { useCallback, useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Mic, Square } from 'lucide-react';
import { atsBoardRunInput, type AtsBoardCharterFields } from '../../shared/atsBoard';
import { useSpeechInput } from '../hooks/useSpeechInput';
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

type CharterTextField = Exclude<keyof AtsBoardCharterFields, 'authorizeNamedResearch'>;

interface CharterFieldCopy {
  name: CharterTextField;
  label: string;
  hint: string;
  placeholder: string;
  testId: string;
}

const CHARTER_FIELDS: CharterFieldCopy[] = [
  {
    name: 'objective',
    label: 'What should Phase 1 achieve?',
    hint: 'Describe the result in a sentence or two: what changes for clients, recruiters, or the business.',
    placeholder: 'e.g. Recruiters take a client request to a filled assignment in one place, without re-keying data.',
    testId: 'ats-board-objective',
  },
  {
    name: 'separation',
    label: 'What must leaving the current system accomplish?',
    hint: 'Why move off it, and what has to keep working without it on day one.',
    placeholder: 'e.g. We can run intake, submittals, and placements without logging in to the old ATS.',
    testId: 'ats-board-separation',
  },
  {
    name: 'staffingModel',
    label: 'Which kind of staffing does Phase 1 serve?',
    hint: 'Name the business line or placement type the board should design for.',
    placeholder: 'e.g. Contract travel nursing for hospital clients.',
    testId: 'ats-board-staffing-model',
  },
  {
    name: 'boundaries',
    label: 'What is out of scope for Phase 1?',
    hint: 'List what the board should leave for later so it does not plan too much.',
    placeholder: 'e.g. No payroll, invoicing, or credentialing in the first release.',
    testId: 'ats-board-boundaries',
  },
  {
    name: 'nonNegotiables',
    label: 'What rules must the board never break?',
    hint: 'Hard limits every recommendation must respect: compliance, budget, tools, or process.',
    placeholder: 'e.g. Do not copy old screens. Keep candidate data in our own tenant.',
    testId: 'ats-board-non-negotiables',
  },
];

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
  const [dictatingField, setDictatingField] = useState(null as CharterTextField | null);
  const idPrefix = useId();
  const { register, handleSubmit, setValue, getValues, formState: { errors } } = useForm<AtsBoardCharterFields>({
    resolver: zodResolver(charterSchema),
    defaultValues: { authorizeNamedResearch: false },
  });
  const speech = useSpeechInput(
    useCallback(
      (text: string) => {
        if (dictatingField) setValue(dictatingField, text, { shouldDirty: true });
      },
      [dictatingField, setValue],
    ),
  );

  const toggleDictation = (field: CharterTextField) => {
    if (speech.isListening) {
      speech.stop();
      return;
    }
    setDictatingField(field);
    speech.toggle(getValues(field) ?? '');
  };

  const activeField = speech.isListening ? dictatingField : null;

  return (
    <form
      className={styles.form}
      onSubmit={handleSubmit((fields) => {
        if (speech.isListening) speech.stop();
        onStart(atsBoardRunInput(fields));
      })}
      {...{ 'data-testid': testId }}
    >
      <div className={styles.intro}>
        <p>
          Give the board a short charter. Plain sentences are fine. Answer each question as you would brief a new
          leader. You can type or use the microphone to talk through an answer.
        </p>
        <p className={styles.introNote}>
          The board proposes and you ratify. Names, prices, and contact details are removed before the agents see the
          charter.
        </p>
      </div>
      {CHARTER_FIELDS.map((field) => {
        const inputId = `${idPrefix}-${field.name}`;
        const hintId = `${inputId}-hint`;
        const errorId = `${inputId}-error`;
        const error = errors[field.name];
        const isActive = activeField === field.name;
        const micDisabled = !speech.isSpeechSupported || pending || (speech.isListening && !isActive);
        return (
          <div key={field.name} className={styles.field}>
            <div className={styles.fieldHeader}>
              <label htmlFor={inputId} className={styles.label}>
                {field.label}
              </label>
              <button
                type="button"
                className={`${styles.micBtn} ${isActive ? styles.micBtnActive : ''}`}
                onClick={() => toggleDictation(field.name)}
                disabled={micDisabled}
                aria-pressed={isActive}
                aria-label={isActive ? `Stop dictating: ${field.label}` : `Dictate: ${field.label}`}
                title={speech.isSpeechSupported
                  ? (isActive ? 'Stop listening' : 'Talk to fill in this answer')
                  : 'Speech recognition is not supported in this browser'}
                {...{ 'data-testid': `${field.testId}-mic` }}
              >
                {isActive ? <Square size={14} aria-hidden /> : <Mic size={14} aria-hidden />}
              </button>
            </div>
            <p id={hintId} className={styles.hint}>{field.hint}</p>
            <textarea
              id={inputId}
              placeholder={field.placeholder}
              aria-describedby={error ? `${hintId} ${errorId}` : hintId}
              aria-invalid={error ? true : undefined}
              className={isActive ? styles.textareaListening : undefined}
              {...register(field.name)}
              {...{ 'data-testid': field.testId }}
            />
            {isActive ? (
              <span className={styles.listening} role="status">Listening… your speech is being transcribed.</span>
            ) : null}
            {error ? <span id={errorId} className={styles.error}>{error.message}</span> : null}
          </div>
        );
      })}
      {speech.speechError ? (
        <p className={styles.error} role="alert" {...{ 'data-testid': 'ats-board-speech-error' }}>
          {speech.speechError}
        </p>
      ) : null}
      <label className={styles.check}>
        <input type="checkbox" {...register('authorizeNamedResearch')} {...{ 'data-testid': 'ats-board-authorize-research' }} />
        <span>
          Authorize public research that names Aya or eRecruit.
          <span className={styles.hint}> Required if your answers mention either product.</span>
        </span>
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
