import React from 'react';
import type { UseFormRegister, FieldErrors, UseFormSetValue, UseFormWatch } from 'react-hook-form';
import type { LoadTestBuilderFormValues } from '../utils/loadTestBuilderSchema';
import { LOAD_TEST_CLIENT_CAPS } from '../utils/loadTestBuilderSchema';
import { LoadTestMultiStepEditor } from './LoadTestMultiStepEditor';
import { NumberStepper } from './NumberStepper';
import styles from './LoadTestGuidedForm.module.css';

export type AllowlistedTargetOption = {
  id: string;
  baseUrl: string;
  environmentLabel: string;
  isReachable: boolean;
};

/** Curated k6 client-threshold metrics for the guided builder. */
export const LOAD_TEST_METRIC_OPTIONS = [
  { value: 'http_req_duration', label: 'http_req_duration' },
  { value: 'http_req_failed', label: 'http_req_failed' },
  { value: 'http_reqs', label: 'http_reqs' },
  { value: 'iteration_duration', label: 'iteration_duration' },
  { value: 'checks', label: 'checks' },
] as const;

/** Curated k6 threshold expressions paired with common SLOs. */
export const LOAD_TEST_EXPRESSION_OPTIONS = [
  { value: 'p(95)<500', label: 'p(95) < 500ms' },
  { value: 'p(95)<1000', label: 'p(95) < 1s' },
  { value: 'p(99)<1500', label: 'p(99) < 1.5s' },
  { value: 'avg<300', label: 'avg < 300ms' },
  { value: 'rate<0.01', label: 'rate < 1%' },
  { value: 'rate<0.05', label: 'rate < 5%' },
  { value: 'rate>0.99', label: 'rate > 99% (checks)' },
] as const;

interface LoadTestGuidedFormProps {
  register: UseFormRegister<LoadTestBuilderFormValues>;
  errors: FieldErrors<LoadTestBuilderFormValues>;
  setValue: UseFormSetValue<LoadTestBuilderFormValues>;
  watch: UseFormWatch<LoadTestBuilderFormValues>;
  targets: AllowlistedTargetOption[];
  targetsLoading?: boolean;
  readOnly?: boolean;
}

function selectOrCustomValue(options: readonly { value: string }[], current: string): string {
  return options.some((o) => o.value === current) ? current : '__custom__';
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
  const vus = watch('loadProfile.vus') ?? 1;
  const durationMinutes = watch('loadProfile.durationMinutes') ?? 1;
  const rpsCap = watch('loadProfile.rpsCap');
  const metric = watch('clientThresholds.0.metric') ?? '';
  const expression = watch('clientThresholds.0.expression') ?? '';
  const metricSelect = selectOrCustomValue(LOAD_TEST_METRIC_OPTIONS, metric);
  const expressionSelect = selectOrCustomValue(LOAD_TEST_EXPRESSION_OPTIONS, expression);

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
            setValue('flowType', next, { shouldDirty: true });
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
            <label id="load-test-vus-label" htmlFor="load-test-vus">
              Virtual users
            </label>
            <NumberStepper
              id="load-test-vus"
              aria-label="Virtual users"
              aria-describedby={errors.loadProfile?.vus ? 'load-test-vus-error' : undefined}
              aria-invalid={Boolean(errors.loadProfile?.vus)}
              value={vus}
              min={1}
              max={LOAD_TEST_CLIENT_CAPS.maxVus}
              step={1}
              unit="VUs"
              disabled={readOnly}
              onChange={(next) => setValue('loadProfile.vus', next, { shouldDirty: true, shouldValidate: true })}
            />
            {errors.loadProfile?.vus && (
              <span id="load-test-vus-error" className={styles.error} role="alert">
                {errors.loadProfile.vus.message}
              </span>
            )}
          </div>
          <div className={styles.field}>
            <label htmlFor="load-test-duration">Duration</label>
            <NumberStepper
              id="load-test-duration"
              aria-label="Duration in minutes"
              aria-describedby={
                errors.loadProfile?.durationMinutes ? 'load-test-duration-error' : undefined
              }
              aria-invalid={Boolean(errors.loadProfile?.durationMinutes)}
              value={durationMinutes}
              min={1}
              max={LOAD_TEST_CLIENT_CAPS.maxDurationMinutes}
              step={1}
              unit="min"
              disabled={readOnly}
              onChange={(next) =>
                setValue('loadProfile.durationMinutes', next, { shouldDirty: true, shouldValidate: true })
              }
            />
            {errors.loadProfile?.durationMinutes && (
              <span id="load-test-duration-error" className={styles.error} role="alert">
                {errors.loadProfile.durationMinutes.message}
              </span>
            )}
          </div>
          <div className={styles.field}>
            <label htmlFor="load-test-rps">RPS cap (optional)</label>
            <NumberStepper
              id="load-test-rps"
              aria-label="RPS cap"
              value={rpsCap ?? 0}
              min={0}
              max={LOAD_TEST_CLIENT_CAPS.maxRpsCap}
              step={10}
              unit="RPS"
              disabled={readOnly}
              onChange={(next) =>
                setValue('loadProfile.rpsCap', next === 0 ? undefined : next, {
                  shouldDirty: true,
                  shouldValidate: true,
                })
              }
            />
            <span className={styles.hint}>0 means no RPS cap</span>
          </div>
        </div>
      </fieldset>

      <fieldset className={styles.fieldset} disabled={readOnly}>
        <legend>Client thresholds</legend>
        <div className={styles.row}>
          <div className={styles.field}>
            <label htmlFor="load-test-threshold-metric">Metric</label>
            <select
              id="load-test-threshold-metric"
              value={metricSelect}
              disabled={readOnly}
              onChange={(e) => {
                const next = e.target.value;
                if (next === '__custom__') {
                  setValue('clientThresholds.0.metric', metric || '', { shouldDirty: true });
                  return;
                }
                setValue('clientThresholds.0.metric', next, { shouldDirty: true, shouldValidate: true });
              }}
            >
              {LOAD_TEST_METRIC_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
              <option value="__custom__">Custom…</option>
            </select>
            {metricSelect === '__custom__' && (
              <input
                type="text"
                className={styles.customFollowUp}
                aria-label="Custom metric"
                disabled={readOnly}
                value={metric}
                onChange={(e) =>
                  setValue('clientThresholds.0.metric', e.target.value, {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }
              />
            )}
          </div>
          <div className={styles.field}>
            <label htmlFor="load-test-threshold-expr">Expression</label>
            <select
              id="load-test-threshold-expr"
              value={expressionSelect}
              disabled={readOnly}
              onChange={(e) => {
                const next = e.target.value;
                if (next === '__custom__') {
                  setValue('clientThresholds.0.expression', expression || '', { shouldDirty: true });
                  return;
                }
                setValue('clientThresholds.0.expression', next, {
                  shouldDirty: true,
                  shouldValidate: true,
                });
              }}
            >
              {LOAD_TEST_EXPRESSION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
              <option value="__custom__">Custom…</option>
            </select>
            {expressionSelect === '__custom__' && (
              <input
                type="text"
                className={styles.customFollowUp}
                aria-label="Custom expression"
                disabled={readOnly}
                value={expression}
                onChange={(e) =>
                  setValue('clientThresholds.0.expression', e.target.value, {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }
              />
            )}
          </div>
        </div>
        {errors.clientThresholds && (
          <span className={styles.error} role="alert">
            {errors.clientThresholds.message as string}
          </span>
        )}
      </fieldset>

      <p className={styles.hint}>
        Payloads must be synthetic or anonymized (no production PII). Scripts are the execution source of
        truth after save.
      </p>
    </div>
  );
};

export default LoadTestGuidedForm;
