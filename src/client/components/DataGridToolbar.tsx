import React from 'react';
import styles from './DataGridToolbar.module.css';

export interface DataGridFilterOption<T extends string = string> {
  label: string;
  value: T;
}

export interface DataGridFilterPillsProps<T extends string> {
  options: readonly DataGridFilterOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Optional prefix for `data-testid` on each pill: `{testIdPrefix}-{value}` */
  testIdPrefix?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

export function DataGridFilterPills<T extends string>({
  options,
  value,
  onChange,
  testIdPrefix,
  'aria-label': ariaLabel,
  'data-testid': dataTestId,
}: DataGridFilterPillsProps<T>) {
  return (
    <div
      className={styles.filterGroup}
      role="group"
      aria-label={ariaLabel}
      {...(dataTestId ? { 'data-testid': dataTestId } : {})}
    >      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={`${styles.filterPill} ${active ? styles.filterPillActive : ''}`}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            {...(testIdPrefix
              ? { 'data-testid': `${testIdPrefix}-${option.value}` }
              : {})}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export interface DataGridFilterSelectProps<T extends string = string> {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly DataGridFilterOption<T>[];
  testId?: string;
  'data-testid'?: string;
  /** When true, first option is treated as empty/all (value ""). */
  includeEmptyOption?: boolean;
  emptyOptionLabel?: string;
}

export function DataGridFilterSelect<T extends string>({
  label,
  value,
  onChange,
  options,
  testId,
  'data-testid': dataTestId,
  includeEmptyOption,
  emptyOptionLabel = 'All',
}: DataGridFilterSelectProps<T>) {
  const resolvedTestId = testId ?? dataTestId;
  return (
    <label className={styles.filterField}>
      <span className={styles.filterLabel}>{label}</span>
      <select
        className={styles.filterSelect}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        aria-label={label}
        {...(resolvedTestId ? { 'data-testid': resolvedTestId } : {})}
      >
        {includeEmptyOption && <option value="">{emptyOptionLabel}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface DataGridToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  searchTestId?: string;
  children?: React.ReactNode;
}

export const DataGridSearchIcon: React.FC = () => (
  <svg
    className={styles.searchIcon}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <circle cx="6.5" cy="6.5" r="4.5" />
    <line x1="10" y1="10" x2="14" y2="14" />
  </svg>
);

export const DataGridToolbar: React.FC<DataGridToolbarProps> = ({
  searchValue,
  onSearchChange,
  searchPlaceholder,
  searchTestId,
  children,
}) => (
  <div className={styles.toolbar} {...{ 'data-testid': 'data-grid-toolbar' }}>
    <div className={styles.filters}>{children}</div>
    <div className={styles.searchWrap}>
      <DataGridSearchIcon />
      <input
        className={styles.searchInput}
        type="search"
        placeholder={searchPlaceholder}
        value={searchValue}
        onChange={(e) => onSearchChange(e.target.value)}
        {...(searchTestId ? { 'data-testid': searchTestId } : {})}
      />
    </div>
  </div>
);
