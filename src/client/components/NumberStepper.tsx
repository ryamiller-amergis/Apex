import React from 'react';
import styles from './NumberStepper.module.css';

export interface NumberStepperProps {
  id?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Optional unit label shown under the value (e.g. "min", "VUs"). */
  unit?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'data-testid'?: string;
}

/**
 * Compact − / value / + stepper (same interaction pattern as PDF preview zoom
 * and standup duration controls). Prefer this over `<input type="number">`
 * so native spinner arrows never appear.
 */
export const NumberStepper: React.FC<NumberStepperProps> = ({
  id,
  value,
  onChange,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  step = 1,
  unit,
  disabled = false,
  className,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  'data-testid': testId = 'number-stepper',
}) => {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const atMin = value <= min;
  const atMax = value >= max;

  return (
    <div
      className={[styles.stepper, className].filter(Boolean).join(' ')}
      id={id}
      role="group"
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      data-invalid={ariaInvalid || undefined}
      {...{ 'data-testid': testId }}
    >
      <button
        type="button"
        className={styles.btn}
        onClick={() => onChange(clamp(value - step))}
        disabled={disabled || atMin}
        aria-label="Decrease"
        {...{ 'data-testid': `${testId}-decrease` }}
      >
        −
      </button>
      <div className={styles.valueWrap}>
        <span className={styles.value} {...{ 'data-testid': `${testId}-value` }}>
          {value}
        </span>
        {unit ? <span className={styles.unit}>{unit}</span> : null}
      </div>
      <button
        type="button"
        className={styles.btn}
        onClick={() => onChange(clamp(value + step))}
        disabled={disabled || atMax}
        aria-label="Increase"
        {...{ 'data-testid': `${testId}-increase` }}
      >
        +
      </button>
    </div>
  );
};

export default NumberStepper;
