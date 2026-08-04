import React from 'react';
import type {
  FieldErrors,
  UseFormRegister,
  UseFormSetValue,
  UseFormWatch,
} from 'react-hook-form';
import type { LoadTestBuilderFormValues } from '../utils/loadTestBuilderSchema';
import styles from './LoadTestMultiStepEditor.module.css';

interface LoadTestMultiStepEditorProps {
  register: UseFormRegister<LoadTestBuilderFormValues>;
  errors: FieldErrors<LoadTestBuilderFormValues>;
  setValue: UseFormSetValue<LoadTestBuilderFormValues>;
  watch: UseFormWatch<LoadTestBuilderFormValues>;
  readOnly?: boolean;
  allowMultiple?: boolean;
}

export const LoadTestMultiStepEditor: React.FC<LoadTestMultiStepEditorProps> = ({
  register,
  errors,
  setValue,
  watch,
  readOnly = false,
  allowMultiple = true,
}) => {
  const steps = watch('steps') ?? [];

  const addStep = () => {
    setValue('steps', [...steps, { method: 'GET', path: '/', extractions: [] }], {
      shouldDirty: true,
    });
  };

  const removeStep = (index: number) => {
    if (steps.length <= 1) return;
    setValue(
      'steps',
      steps.filter((_, i) => i !== index),
      { shouldDirty: true },
    );
  };

  const addExtraction = (stepIndex: number) => {
    const next = steps.map((step, i) => {
      if (i !== stepIndex) return step;
      return {
        ...step,
        extractions: [
          ...(step.extractions ?? []),
          { name: '', source: 'json_path' as const, expression: '' },
        ],
      };
    });
    setValue('steps', next, { shouldDirty: true });
  };

  return (
    <div className={styles.editor} data-testid="load-test-multi-step-editor">
      <div className={styles.header}>
        <h3 className={styles.title}>{allowMultiple ? 'Steps' : 'Request'}</h3>
        {allowMultiple && !readOnly && (
          <button type="button" className={styles.addBtn} onClick={addStep}>
            Add step
          </button>
        )}
      </div>

      {steps.length === 0 && (
        <p className={styles.empty}>Add a first step to define the flow.</p>
      )}

      {steps.map((step, index) => (
        <div key={index} className={styles.stepCard}>
          <div className={styles.stepHeader}>
            <span className={styles.stepLabel}>Step {index + 1}</span>
            {allowMultiple && !readOnly && steps.length > 1 && (
              <button type="button" className={styles.removeBtn} onClick={() => removeStep(index)}>
                Remove
              </button>
            )}
          </div>
          <div className={styles.row}>
            <div className={styles.field}>
              <label htmlFor={`step-method-${index}`}>Method</label>
              <select
                id={`step-method-${index}`}
                disabled={readOnly}
                {...register(`steps.${index}.method`)}
              >
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.fieldWide}>
              <label htmlFor={`step-path-${index}`}>Path</label>
              <input
                id={`step-path-${index}`}
                type="text"
                disabled={readOnly}
                placeholder="/api/resource"
                {...register(`steps.${index}.path`)}
              />
            </div>
          </div>
          <div className={styles.field}>
            <label htmlFor={`step-body-${index}`}>Body (synthetic/anonymized)</label>
            <textarea
              id={`step-body-${index}`}
              rows={3}
              disabled={readOnly}
              {...register(`steps.${index}.body`)}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor={`step-headers-${index}`}>Headers (JSON or Header: value lines)</label>
            <textarea
              id={`step-headers-${index}`}
              rows={2}
              disabled={readOnly}
              {...register(`steps.${index}.headersText`)}
            />
          </div>

          <div className={styles.extractions}>
            <div className={styles.stepHeader}>
              <span className={styles.stepLabel}>Extractions</span>
              {!readOnly && (
                <button type="button" className={styles.addBtn} onClick={() => addExtraction(index)}>
                  Add extraction
                </button>
              )}
            </div>
            {(step.extractions ?? []).map((_, exIndex) => (
              <div key={exIndex} className={styles.row}>
                <div className={styles.field}>
                  <label htmlFor={`ex-name-${index}-${exIndex}`}>Variable</label>
                  <input
                    id={`ex-name-${index}-${exIndex}`}
                    type="text"
                    disabled={readOnly}
                    {...register(`steps.${index}.extractions.${exIndex}.name`)}
                  />
                </div>
                <div className={styles.field}>
                  <label htmlFor={`ex-source-${index}-${exIndex}`}>Source</label>
                  <select
                    id={`ex-source-${index}-${exIndex}`}
                    disabled={readOnly}
                    {...register(`steps.${index}.extractions.${exIndex}.source`)}
                  >
                    <option value="json_path">JSONPath</option>
                    <option value="regex">Regex</option>
                  </select>
                </div>
                <div className={styles.fieldWide}>
                  <label htmlFor={`ex-expr-${index}-${exIndex}`}>Expression</label>
                  <input
                    id={`ex-expr-${index}-${exIndex}`}
                    type="text"
                    disabled={readOnly}
                    {...register(`steps.${index}.extractions.${exIndex}.expression`)}
                  />
                </div>
              </div>
            ))}
          </div>

          {Array.isArray(errors.steps) && errors.steps[index] && (
            <span className={styles.error} role="alert">
              {(errors.steps[index] as { message?: string })?.message ??
                'Step is incomplete'}
            </span>
          )}
        </div>
      ))}

      {errors.steps && !Array.isArray(errors.steps) && (
        <span className={styles.error} role="alert">
          {errors.steps.message as string}
        </span>
      )}
    </div>
  );
};

export default LoadTestMultiStepEditor;
