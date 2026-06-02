import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useActiveUsers } from '../hooks/useInterviews';
import type { ActiveUser } from '../../shared/types/interview';
import styles from './SectionOwnerModal.module.css';

interface UserComboboxProps {
  id: string;
  users: ActiveUser[];
  selectedId: string;
  onSelect: (oid: string) => void;
  placeholder: string;
  disabled?: boolean;
}

const UserCombobox: React.FC<UserComboboxProps> = ({
  id, users, selectedId, onSelect, placeholder, disabled = false,
}) => {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedUser = users.find((u) => u.oid === selectedId);

  const filtered = query.trim()
    ? users.filter((u) => {
        const q = query.toLowerCase();
        return (u.displayName?.toLowerCase().includes(q)) ||
               (u.email?.toLowerCase().includes(q));
      })
    : users;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    setHighlightIdx(-1);
  }, [query]);

  useEffect(() => {
    if (highlightIdx >= 0 && listRef.current) {
      const el = listRef.current.children[highlightIdx] as HTMLElement | undefined;
      el?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightIdx]);

  const handleSelect = useCallback((oid: string) => {
    onSelect(oid);
    setQuery('');
    setOpen(false);
  }, [onSelect]);

  const handleClear = useCallback(() => {
    onSelect('');
    setQuery('');
    setOpen(false);
  }, [onSelect]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true);
      e.preventDefault();
      return;
    }
    if (!open) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
    } else if (e.key === 'Enter' && highlightIdx >= 0 && filtered[highlightIdx]) {
      e.preventDefault();
      handleSelect(filtered[highlightIdx].oid);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }, [open, highlightIdx, filtered, handleSelect]);

  if (selectedUser) {
    return (
      <div className={styles.selectedChip}>
        <span className={styles.selectedAvatar}>
          {(selectedUser.displayName ?? '?')[0].toUpperCase()}
        </span>
        <span className={styles.selectedInfo}>
          <span className={styles.selectedName}>{selectedUser.displayName ?? 'Unknown'}</span>
          {selectedUser.email && <span className={styles.selectedEmail}>{selectedUser.email}</span>}
        </span>
        {!disabled && (
          <button
            type="button"
            className={styles.selectedClear}
            onClick={handleClear}
            aria-label="Clear selection"
          >×</button>
        )}
      </div>
    );
  }

  return (
    <div className={styles.comboWrapper} ref={wrapperRef}>
      <input
        id={id}
        type="text"
        className={styles.comboInput}
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-listbox`}
        aria-autocomplete="list"
      />
      {open && filtered.length > 0 && (
        <ul
          id={`${id}-listbox`}
          className={styles.comboDropdown}
          role="listbox"
          ref={listRef}
        >
          {filtered.map((u, idx) => (
            <li
              key={u.oid}
              role="option"
              aria-selected={idx === highlightIdx}
              className={`${styles.comboOption} ${idx === highlightIdx ? styles.comboOptionHighlight : ''}`}
              onMouseDown={() => handleSelect(u.oid)}
              onMouseEnter={() => setHighlightIdx(idx)}
            >
              <span className={styles.comboAvatar}>
                {(u.displayName ?? '?')[0].toUpperCase()}
              </span>
              <span className={styles.comboOptionInfo}>
                <span className={styles.comboOptionName}>{u.displayName ?? 'Unknown'}</span>
                {u.email && <span className={styles.comboOptionEmail}>{u.email}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && query.trim() && filtered.length === 0 && (
        <div className={styles.comboEmpty}>No users match "{query}"</div>
      )}
    </div>
  );
};

interface SectionOwnerModalProps {
  project: string;
  onConfirm: (owners: { prdOwnerId?: string; designDocOwnerId?: string }) => void;
  onSkip: () => void;
  isSubmitting?: boolean;
}

export const SectionOwnerModal: React.FC<SectionOwnerModalProps> = ({
  project: _project,
  onConfirm,
  onSkip,
  isSubmitting = false,
}) => {
  const [prdOwnerId, setPrdOwnerId] = useState('');
  const [designDocOwnerId, setDesignDocOwnerId] = useState('');

  const { data: users = [], isLoading } = useActiveUsers();

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onSkip();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onSkip]);

  const handleConfirm = () => {
    onConfirm({
      prdOwnerId: prdOwnerId || undefined,
      designDocOwnerId: designDocOwnerId || undefined,
    });
  };

  return (
    <div
      className={styles.overlay}
      onClick={(e) => { if (e.target === e.currentTarget) onSkip(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="section-owner-title"
    >
      <div className={styles.card}>
        <div className={styles.header}>
          <div className={styles.headerText}>
            <h2 className={styles.title} id="section-owner-title">
              Assign Section Owners
            </h2>
            <p className={styles.subtitle}>
              Select the subject matter expert responsible for each document.
            </p>
          </div>
          <button
            className={styles.closeBtn}
            onClick={onSkip}
            aria-label="Close"
            type="button"
          >
            ✕
          </button>
        </div>

        <div className={styles.fields}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="so-prd-owner">
              PRD Owner (BA)
            </label>
            {isLoading ? (
              <span className={styles.loadingText}>Loading users…</span>
            ) : (
              <UserCombobox
                id="so-prd-owner"
                users={users}
                selectedId={prdOwnerId}
                onSelect={setPrdOwnerId}
                placeholder="Search by name or email…"
                disabled={isSubmitting}
              />
            )}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="so-dd-owner">
              Design Doc Owner (Developer)
            </label>
            {isLoading ? (
              <span className={styles.loadingText}>Loading users…</span>
            ) : (
              <UserCombobox
                id="so-dd-owner"
                users={users}
                selectedId={designDocOwnerId}
                onSelect={setDesignDocOwnerId}
                placeholder="Search by name or email…"
                disabled={isSubmitting}
              />
            )}
          </div>
        </div>

        <div className={styles.footer}>
          <button
            className={styles.btnSkip}
            onClick={onSkip}
            disabled={isSubmitting}
            type="button"
          >
            Skip
          </button>
          <button
            className={styles.btnConfirm}
            onClick={handleConfirm}
            disabled={isSubmitting}
            type="button"
          >
            {isSubmitting ? 'Creating…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SectionOwnerModal;
