/**
 * A searchable dropdown whose options carry a description and badges. Used where a plain select
 * would show only an opaque value, such as a Skill path or a model id.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import styles from './PlaybookOptionPicker.module.css';

export interface PlaybookPickerOption {
  value: string;
  label: string;
  description?: string;
  badges?: readonly string[];
  disabled?: boolean;
  disabledReason?: string;
}

interface PlaybookOptionPickerProps {
  id?: string;
  value: string | undefined;
  options: readonly PlaybookPickerOption[];
  placeholder: string;
  /** Shown first; choosing it clears the value. */
  emptyOption?: { label: string; description?: string };
  icon?: React.ReactNode;
  loading?: boolean;
  disabled?: boolean;
  searchPlaceholder?: string;
  onChange: (value: string | undefined) => void;
  'data-testid': string;
}

export const PlaybookOptionPicker: React.FC<PlaybookOptionPickerProps> = ({
  id,
  value,
  options,
  placeholder,
  emptyOption,
  icon,
  loading = false,
  disabled = false,
  searchPlaceholder = 'Search',
  onChange,
  'data-testid': testId,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const selected = options.find((option) => option.value === value);
  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const rows: Array<PlaybookPickerOption & { empty?: boolean }> = [
      ...(emptyOption && !terms.length
        ? [{ value: '', label: emptyOption.label, description: emptyOption.description, empty: true }]
        : []),
      ...options.filter((option) => {
        const haystack = `${option.label} ${option.value} ${option.description ?? ''} ${(option.badges ?? []).join(' ')}`
          .toLowerCase();
        return terms.every((term) => haystack.includes(term));
      }),
    ];
    return rows;
  }, [emptyOption, options, query]);

  useEffect(() => {
    if (!open) return undefined;
    searchRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query, open]);

  const choose = (option: PlaybookPickerOption & { empty?: boolean }) => {
    if (option.disabled) return;
    onChange(option.empty ? undefined : option.value);
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => Math.min(filtered.length - 1, current + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => Math.max(0, current - 1));
    } else if (event.key === 'Enter' && filtered[active]) {
      event.preventDefault();
      choose(filtered[active]);
    }
  };

  const triggerLabel = selected?.label
    ?? (value ? value : emptyOption?.label ?? placeholder);
  const triggerDescription = selected?.description
    ?? (value && !selected ? 'Not in the current list' : !value ? emptyOption?.description : undefined);

  return (
    <div
      className={styles.root}
      ref={rootRef}
      onKeyDown={open ? onKeyDown : undefined}
      {...{ 'data-testid': `${testId}-root` }}
    >
      <button
        id={id}
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((current) => !current)}
        {...{ 'data-testid': testId }}
      >
        {icon ? <span className={styles.triggerIcon} aria-hidden>{icon}</span> : null}
        <span className={styles.triggerText}>
          <span className={`${styles.triggerLabel} ${!value && !emptyOption ? styles.placeholder : ''}`}>
            {triggerLabel}
          </span>
          {triggerDescription ? <span className={styles.triggerDescription}>{triggerDescription}</span> : null}
        </span>
        <ChevronDown size={15} aria-hidden className={styles.chevron} />
      </button>

      {open ? (
        <div className={styles.popover} {...{ 'data-testid': `${testId}-popover` }}>
          <label className={styles.search}>
            <Search size={13} aria-hidden />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              {...{ 'data-testid': `${testId}-search` }}
            />
          </label>
          <ul className={styles.list} role="listbox" id={listId} {...{ 'data-testid': `${testId}-list` }}>
            {loading ? <li className={styles.empty}>Loading…</li> : null}
            {!loading && filtered.length === 0 ? <li className={styles.empty}>Nothing matches.</li> : null}
            {filtered.map((option, index) => {
              const isSelected = option.empty ? !value : option.value === value;
              return (
                <li key={option.empty ? '__empty' : option.value} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={option.disabled}
                    className={`${styles.option} ${index === active ? styles.optionActive : ''} ${option.disabled ? styles.optionDisabled : ''}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(option)}
                    title={option.disabled ? option.disabledReason : undefined}
                    {...{ 'data-testid': `${testId}-option-${option.empty ? 'default' : option.value}` }}
                  >
                    <span className={styles.optionText}>
                      <span className={styles.optionLabel}>{option.label}</span>
                      {option.description ? (
                        <span className={styles.optionDescription}>{option.description}</span>
                      ) : null}
                      {option.disabled && option.disabledReason ? (
                        <span className={styles.optionReason}>{option.disabledReason}</span>
                      ) : null}
                      {option.badges?.length ? (
                        <span className={styles.badges}>
                          {option.badges.map((badge) => (
                            <span key={badge} className={styles.badge}>{badge}</span>
                          ))}
                        </span>
                      ) : null}
                    </span>
                    {isSelected ? <Check size={14} aria-hidden className={styles.check} /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
};

export default PlaybookOptionPicker;
