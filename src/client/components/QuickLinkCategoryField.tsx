import React, { useEffect, useRef, useState } from 'react';
import { QUICK_LINK_CATEGORY_MAX_LENGTH } from '../../shared/types/projectQuickLinks';
import styles from './QuickLinkCategoryField.module.css';

const NEW_CATEGORY = '__new_category__';

interface QuickLinkCategoryFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Existing categories to offer for this context. */
  options: string[];
  error?: string;
  disabled?: boolean;
  compact?: boolean;
  /** Hide the visible label (an aria-label is still set). */
  hideLabel?: boolean;
  'data-testid': string;
}

/**
 * Pick an existing category or type a new one. The `<select>` keeps native keyboard behavior;
 * choosing "+ New category…" swaps in a text input, and "Choose existing" swaps back.
 */
export const QuickLinkCategoryField: React.FC<QuickLinkCategoryFieldProps> = ({
  id,
  label,
  value,
  onChange,
  options,
  error,
  disabled = false,
  compact = false,
  hideLabel = false,
  'data-testid': testId,
}) => {
  const [isNew, setIsNew] = useState(() => Boolean(value) && !options.includes(value));
  const inputRef = useRef<HTMLInputElement>(null);
  const focusInputRef = useRef(false);

  useEffect(() => {
    if (isNew && focusInputRef.current) {
      focusInputRef.current = false;
      inputRef.current?.focus();
    }
  }, [isNew]);

  const fieldClass = `${styles.control} ${compact ? styles.compact : ''}`;

  return (
    <div className={styles.field}>
      <label className={hideLabel ? styles.visuallyHidden : styles.label} htmlFor={id}>
        {label}
      </label>
      {isNew ? (
        <div className={styles.newRow}>
          <input
            ref={inputRef}
            id={id}
            className={fieldClass}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="New category name"
            maxLength={QUICK_LINK_CATEGORY_MAX_LENGTH}
            disabled={disabled}
            aria-invalid={Boolean(error)}
            {...{ 'data-testid': `${testId}-new` }}
          />
          {options.length > 0 && (
            <button
              type="button"
              className={styles.switchButton}
              onClick={() => {
                setIsNew(false);
                onChange('');
              }}
              disabled={disabled}
              {...{ 'data-testid': `${testId}-choose-existing` }}
            >
              Choose existing
            </button>
          )}
        </div>
      ) : (
        <select
          id={id}
          className={fieldClass}
          value={value}
          onChange={(e) => {
            if (e.target.value === NEW_CATEGORY) {
              focusInputRef.current = true;
              setIsNew(true);
              onChange('');
              return;
            }
            onChange(e.target.value);
          }}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          {...{ 'data-testid': testId }}
        >
          <option value="">No category</option>
          {options.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
          <option value={NEW_CATEGORY}>+ New category…</option>
        </select>
      )}
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
};

export default QuickLinkCategoryField;
