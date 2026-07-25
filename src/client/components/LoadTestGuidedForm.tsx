import React from 'react';
import type { UseFormRegister, FieldErrors, UseFormSetValue, UseFormWatch } from 'react-hook-form';
import type { LoadTestBuilderFormValues } from '../utils/loadTestBuilderSchema';
import { LoadTestMultiStepEditor } from './LoadTestMultiStepEditor';
import styles from './LoadTestGuidedForm.module.css';

export type AllowlistedTargetOption = {
  id: string;
  baseUrl: string;
  environmentLabel: string;
  isReachable: boolean;
};

interface LoadTestGuidedFormProps {
  register: UseFormRegister<LoadTestBuilderFormValues>;
  errors: FieldErrors<LoadTestBuilderFormValues>;
  setValue: UseFormSetValue<LoadTestBuilderFormValues>;
  watch: UseFormWatch<LoadTestBuilderFormValues>;
  targets: AllowlistedTargetOption[];
  targetsLoading?: boolean;
  readOnly?: boolean;
}

export const LoadTestGuidedForm: React.FC<LoadTestGuidedFormProps> = ({
  register,
  errors,
  setValue,
  watch,
  targets,
  targetsLoading = false,
  readOnly = false,
}) => {
  const flowType = watch('flowType');

  return (
    <div className={styles.form} data-testid="load-test-guided-form">
      <div className={styles.field}>
        <label htmlFor="load-test-name">Name</label>
        <input
          id="load-test-name"
          type="text"
          disabled={readOnly}
          aria-invalid={Boolean(errors.name)}
          aria-describedby={errors.name ? 'load-test-name-error' : undefined}
          {...register('name')}
        />
        {errors.name && (
          <span id="load-test-name-error" className={styles.error} role="alert">
            {errors.name.message}
          </span>
        )}
      </div>

      <div className={styles.field}>
        <label htmlFor="load-test-description">Description</label>
        <textarea id="load-test-description" rows={2} disabled={readOnly} {...register('description')} />
      </div>

      <div className={styles.field}>
        <label htmlFor="load-test-target">Allowlisted target</label>
        {targetsLoading ? (
          <span className={styles.hint}>Loading targets…</span>
        ) : (
          <select
            id="load-test-target"
            disabled={readOnly}
            aria-invalid={Boolean(errors.targetId)}
            aria-describedby={errors.targetId ? 'load-test-target-error' : undefined}
            {...register('targetId')}
          >
            <option value="">Select a non-prod target</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.environmentLabel} — {t.baseUrl}
                {!t.isReachable ? ' (unreachable)' : ''}
              </option>
            ))}
          </select>
        )}
        {errors.targetId && (
          <span id="load-test-target-error" className={styles.error} role="alert">
            {errors.targetId.message}
          </span>
        )}
      </div>

      <div className={styles.field}>
        <label htmlFor="load-test-flow-type">Flow type</label>
        <select
          id="load-test-flow-type"
          disabled={readOnly}
          {...register('flowType')}
          onChange={(e) => {
            const next = e.target.value as 'single' | 'multi_step';
            setValue('flowType', next);
          }}
        >
          <option value="single">Single endpoint</option>
          <option value="multi_step">Multi-step</option>
        </select>
      </div>

      <LoadTestMultiStepEditor
        register={register}
        errors={errors}
        setValue={setValue}
        watch={watch}
        readOnly={readOnly}
        allowMultiple={flowType === 'multi_step'}
      />

      <fieldset className={styles.fieldset} disabled={readOnly}>
        <legend>Load profile</legend>
        <div className={styles.row}>
          <div className={styles.field}>
            <label htmlFor="load-test-vus">Virtual users</label>
            <input
              id="load-test-vus"
              type="number"
              aria-invalid={Boolean(errors.loadProfile?.vus)}
              {...register('loadProfile.vus', { valueAsNumber: true })}
            />
            {errors.loadProfile?.vus && (
              <span className={styles.error} role="alert">
                {errors.loadProfile.vus.message}
              </span>
            )}
          </div>
          <div className={styles.field}>
            <label htmlFor="load-test-duration">Duration (minutes)</label>
            <input
              id="load-test-duration"
              type="number"
              {...register('loadProfile.durationMinutes', { valueAsNumber: true })}
            />
            {errors.loadProfile?.durationMinutes && (
              <span className={styles.error} role="alert">
                {errors.loadProfile.durationMinutes.message}
              </span>
            )}
          </div>
          <div className={styles.field}>
            <label htmlFor="load-test-rps">RPS cap (optional)</label>
            <input
              id="load-test-rps"
              type="number"
              {...register('loadProfile.rpsCap', {
                setValueAs: (v) => (v === '' || v === null || Number.isNaN(Number(v)) ? undefined : Number(v)),
              })}
            />
          </div>
        </div>
      </fieldset>

      <fieldset className={styles.fieldset} disabled={readOnly}>
        <legend>Client thresholds</legend>
        <div className={styles.row}>
          <div className={styles.field}>
            <label htmlFor="load-test-threshold-metric">Metric</label>
            <input id="load-test-threshold-metric" type="text" {...register('clientThresholds.0.metric')} />
          </div>
          <div className={styles.field}>
            <label htmlFor="load-test-threshold-expr">Expression</label>
            <input id="load-test-threshold-expr" type="text" {...register('clientThresholds.0.expression')} />
          </div>
        </div>
        {errors.clientThresholds && (
          <span className={styles.error} role="alert">
            {errors.clientThresholds.message as string}
          </span>
        )}
      </fieldset>

      <fieldset className={styles.fieldset} disabled={readOnly}>
        <legend>Secret references</legend>
        <p className={styles.hint}>
          Store Key Vault reference identifiers only — never paste resolved secrets or bearer tokens.
        </p>
        <div className={styles.row}>
          <div className={styles.field}>
            <label htmlFor="load-test-secret-key">Ref key</label>
            <input id="load-test-secret-key" type="text" {...register('secretRefKey')} />
          </div>
          <div className={styles.field}>
            <label htmlFor="load-test-secret-value">Ref identifier</label>
            <input
              id="load-test-secret-value"
              type="text"
              aria-invalid={Boolean(errors.secretRefValue)}
              {...register('secretRefValue')}
            />
            {errors.secretRefValue && (
              <span className={styles.error} role="alert">
                {errors.secretRefValue.message}
              </span>
            )}
          </div>
        </div>
      </fieldset>

      <p className={styles.hint}>
        Payloads must be synthetic or anonymized (no production PII). Scripts are the execution source of
        truth after save.
      </p>
    </div>
  );
};

export default LoadTestGuidedForm;
