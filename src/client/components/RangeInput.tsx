import React, { useState, useCallback, useEffect, useRef } from 'react';
import { parseRange, selectionToRangeString } from '../utils/pageRangeParser';
import styles from './RangeInput.module.css';

interface RangeInputProps {
  maxPage: number;
  selectedIndices: number[];
  onSelectionChange: (indices: number[], hasDuplicates: boolean) => void;
  externalUpdate?: number;
}

export const RangeInput: React.FC<RangeInputProps> = ({
  maxPage,
  selectedIndices,
  onSelectionChange,
  externalUpdate = 0,
}) => {
  const [inputValue, setInputValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isExternalUpdateRef = useRef(false);

  useEffect(() => {
    if (externalUpdate > 0) {
      isExternalUpdateRef.current = true;
      const rangeStr = selectionToRangeString(selectedIndices);
      setInputValue(rangeStr);
      setError(null);
      setTimeout(() => {
        isExternalUpdateRef.current = false;
      }, 0);
    }
  }, [externalUpdate, selectedIndices]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setInputValue(val);

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      debounceRef.current = setTimeout(() => {
        if (isExternalUpdateRef.current) return;

        if (!val.trim()) {
          setError(null);
          onSelectionChange([], false);
          return;
        }

        const result = parseRange(val, maxPage);
        if (result.error) {
          setError(result.error);
        } else {
          setError(null);
          onSelectionChange(result.pages, result.hasDuplicates);
        }
      }, 300);
    },
    [maxPage, onSelectionChange],
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div className={styles.container} data-testid="pdf-range-input-container">
      <label htmlFor="pdf-range-input" className={styles.label}>
        Page range
      </label>
      <input
        id="pdf-range-input"
        type="text"
        className={`${styles.input} ${error ? styles.inputError : ''}`}
        value={inputValue}
        onChange={handleChange}
        placeholder="e.g. 1-5, 10, 20-25"
        aria-describedby={error ? 'pdf-range-error' : undefined}
        aria-invalid={!!error}
        data-testid="pdf-range-input"
      />
      {error && (
        <p
          id="pdf-range-error"
          className={styles.error}
          role="alert"
          data-testid="pdf-range-error"
        >
          {error}
        </p>
      )}
    </div>
  );
};
