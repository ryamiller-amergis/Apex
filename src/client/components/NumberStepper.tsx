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
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
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
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
}) => {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const atMin = value <= min;
  const atMax = value >= max;

  return (
    <div
      className={styles.stepper}
      id={id}
      role="group"
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      data-invalid={ariaInvalid || undefined}
      data-testid="number-stepper"
    >
      <button
        type="button"
        className={styles.btn}
        onClick={() => onChange(clamp(value - step))}
        disabled={disabled || atMin}
        aria-label="Decrease"
      >
        −
      </button>
      <div className={styles.valueWrap}>
        <span className={styles.value} data-testid="number-stepper-value">
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
      >
        +
      </button>
    </div>
  );
};

export default NumberStepper;
