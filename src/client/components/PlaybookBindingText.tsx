/**
 * A text field that can pull in values from earlier steps without typing `${...}` by hand.
 * "Insert data" lists what is available; the chips under the field name each value read.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link2, Plus, X } from 'lucide-react';
import type { PlaybookBindingOption, PlaybookTokenReference } from '../utils/playbookBindings';
import styles from './PlaybookBuilder.module.css';

interface PlaybookBindingTextProps {
  id: string;
  value: string;
  multiline?: boolean;
  placeholder?: string;
  disabled: boolean;
  bindings: readonly PlaybookBindingOption[];
  references: readonly PlaybookTokenReference[];
  onChange: (value: string | undefined) => void;
  'data-testid': string;
}

export const PlaybookBindingText: React.FC<PlaybookBindingTextProps> = ({
  id,
  value,
  multiline = false,
  placeholder,
  disabled,
  bindings,
  references,
  onChange,
  'data-testid': testId,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const caret = useRef<number | null>(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  const groups = useMemo(() => {
    const bySource = new Map<string, PlaybookBindingOption[]>();
    for (const binding of bindings) {
      bySource.set(binding.sourceLabel, [...(bySource.get(binding.sourceLabel) ?? []), binding]);
    }
    return [...bySource.entries()];
  }, [bindings]);

  const insert = (token: string) => {
    const at = caret.current ?? value.length;
    const before = value.slice(0, at);
    const after = value.slice(at);
    const spacer = before && !/\s$/.test(before) ? (multiline ? '\n\n' : ' ') : '';
    onChange(`${before}${spacer}${token}${after}`);
    setMenuOpen(false);
  };

  const remove = (token: string) => {
    const next = value.split(token).join('').replace(/\n{3,}/g, '\n\n').trim();
    onChange(next || undefined);
  };

  const common = {
    id,
    ref: inputRef,
    className: styles.fieldInput,
    value,
    disabled,
    placeholder,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(event.target.value === '' ? undefined : event.target.value),
    onSelect: (event: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      caret.current = event.currentTarget.selectionStart;
    },
  };

  return (
    <div className={styles.bindingText} ref={rootRef}>
      {multiline ? <textarea rows={4} {...common} {...{ 'data-testid': testId }} /> : <input {...common} {...{ 'data-testid': testId }} />}
      <div className={styles.bindingBar}>
        {references.map((reference) => (
          <span
            key={reference.token}
            className={`${styles.bindingChip} ${reference.valid ? '' : styles.bindingChipInvalid}`}
            title={reference.valid ? reference.token : `${reference.token} is not available before this step`}
          >
            <Link2 size={11} aria-hidden />
            {reference.label}
            {!disabled ? (
              <button
                type="button"
                className={styles.bindingChipRemove}
                aria-label={`Remove ${reference.label}`}
                onClick={() => remove(reference.token)}
                {...{ 'data-testid': `${testId}-remove-binding` }}
              >
                <X size={10} aria-hidden />
              </button>
            ) : null}
          </span>
        ))}
        {!disabled && bindings.length ? (
          <button
            type="button"
            className={styles.bindingInsert}
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            {...{ 'data-testid': `${testId}-insert` }}
          >
            <Plus size={11} aria-hidden /> Insert data
          </button>
        ) : null}
      </div>
      {menuOpen ? (
        <div className={styles.bindingMenu} role="menu" {...{ 'data-testid': `${testId}-insert-menu` }}>
          {groups.map(([source, options]) => (
            <div key={source} className={styles.bindingMenuGroup}>
              <span className={styles.bindingMenuSource}>{source}</span>
              {options.map((option) => (
                <button
                  key={option.token}
                  type="button"
                  role="menuitem"
                  className={styles.bindingMenuItem}
                  onClick={() => insert(option.token)}
                  {...{ 'data-testid': `${testId}-insert-${option.stepId || 'input'}-${option.field}` }}
                >
                  {option.fieldLabel}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

export default PlaybookBindingText;
