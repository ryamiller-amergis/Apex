import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useActiveUsers, useAvailableApproverPool } from '../hooks/useInterviews';
import type { ActiveUser } from '../../shared/types/interview';
import type { ApproverPoolResponse } from '../../shared/types/projectSettings';
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
  onConfirm: (selections: {
    prdOwnerId?: string;
    designDocOwnerId?: string;
    designPrototypeOwnerId?: string;
    testCaseOwnerId?: string;
    prdApproverIds?: string[];
    designDocApproverIds?: string[];
    designPrototypeApproverIds?: string[];
    testCaseApproverIds?: string[];
  }) => void;
  onCancel: () => void;
  isSubmitting?: boolean;
}

function renderPoolChips(
  pool: ApproverPoolResponse,
  selectedIds: string[],
  onToggle: (id: string) => void,
) {
  return (
    <div className={styles.approverSection}>
      {pool.groups.map((group) => (
        <div key={group.id}>
          <div className={styles.groupHeader}>
            <span className={styles.groupLabel}>{group.name}</span>
            <button
              type="button"
              className={styles.selectAllBtn}
              onClick={() => {
                const memberIds = group.members.map((m) => m.userId);
                const allSelected = memberIds.every((id) => selectedIds.includes(id));
                if (allSelected) {
                  memberIds.forEach((id) => onToggle(id));
                } else {
                  memberIds.filter((id) => !selectedIds.includes(id)).forEach((id) => onToggle(id));
                }
              }}
            >
              {group.members.every((m) => selectedIds.includes(m.userId)) ? 'Deselect all' : 'Select all'}
            </button>
          </div>
          <div className={styles.chipGrid}>
            {group.members.map((m) => {
              const selected = selectedIds.includes(m.userId);
              return (
                <button
                  key={m.userId}
                  type="button"
                  className={`${styles.chip} ${selected ? styles.chipSelected : ''}`}
                  onClick={() => onToggle(m.userId)}
                >
                  {selected && <svg className={styles.chipCheck} viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 12.5l-4-4 1.4-1.4 2.6 2.6 5.6-5.6 1.4 1.4z"/></svg>}
                  {m.displayName ?? m.email ?? m.userId}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {pool.individuals.length > 0 && (
        <div>
          {pool.groups.length > 0 && (
            <div className={styles.groupHeader}>
              <span className={styles.groupLabel}>Individuals</span>
            </div>
          )}
          <div className={styles.chipGrid}>
            {pool.individuals.map((ind) => {
              const selected = selectedIds.includes(ind.userId);
              return (
                <button
                  key={ind.userId}
                  type="button"
                  className={`${styles.chip} ${selected ? styles.chipSelected : ''}`}
                  onClick={() => onToggle(ind.userId)}
                >
                  {selected && <svg className={styles.chipCheck} viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 12.5l-4-4 1.4-1.4 2.6 2.6 5.6-5.6 1.4 1.4z"/></svg>}
                  {ind.displayName ?? ind.email ?? ind.userId}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export const SectionOwnerModal: React.FC<SectionOwnerModalProps> = ({
  project,
  onConfirm,
  onCancel,
  isSubmitting = false,
}) => {
  const [step, setStep] = useState<1 | 2>(1);
  const [prdOwnerId, setPrdOwnerId] = useState('');
  const [designDocOwnerId, setDesignDocOwnerId] = useState('');
  const [designPrototypeOwnerId, setDesignPrototypeOwnerId] = useState('');
  const [testCaseOwnerId, setTestCaseOwnerId] = useState('');
  const [prdApproverIds, setPrdApproverIds] = useState<string[]>([]);
  const [designDocApproverIds, setDesignDocApproverIds] = useState<string[]>([]);
  const [designPrototypeApproverIds, setDesignPrototypeApproverIds] = useState<string[]>([]);
  const [testCaseApproverIds, setTestCaseApproverIds] = useState<string[]>([]);

  const { data: users = [], isLoading } = useActiveUsers();
  const { data: prdPool, isLoading: prdPoolLoading } = useAvailableApproverPool(project, 'prd', false);
  const { data: ddPool, isLoading: ddPoolLoading } = useAvailableApproverPool(project, 'design_doc', false);
  const { data: protoPool, isLoading: protoPoolLoading } = useAvailableApproverPool(project, 'design_prototype', false);
  const { data: qaPool, isLoading: qaPoolLoading } = useAvailableApproverPool(project, 'test_case', false);

  const togglePrdApprover = useCallback((id: string) => {
    setPrdApproverIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }, []);

  const toggleDdApprover = useCallback((id: string) => {
    setDesignDocApproverIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }, []);

  const toggleProtoApprover = useCallback((id: string) => {
    setDesignPrototypeApproverIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }, []);

  const toggleQaApprover = useCallback((id: string) => {
    setTestCaseApproverIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  const allOwnersSelected =
    !!prdOwnerId && !!designDocOwnerId && !!designPrototypeOwnerId && !!testCaseOwnerId;

  const hasPrdPool = prdPool && (prdPool.individuals.length > 0 || prdPool.groups.length > 0);
  const hasDdPool = ddPool && (ddPool.individuals.length > 0 || ddPool.groups.length > 0);
  const hasProtoPool = protoPool && (protoPool.individuals.length > 0 || protoPool.groups.length > 0);
  const hasQaPool = qaPool && (qaPool.individuals.length > 0 || qaPool.groups.length > 0);

  const canConfirm =
    allOwnersSelected &&
    (!hasPrdPool || prdApproverIds.length > 0) &&
    (!hasDdPool || designDocApproverIds.length > 0) &&
    (!hasProtoPool || designPrototypeApproverIds.length > 0) &&
    (!hasQaPool || testCaseApproverIds.length > 0) &&
    !isSubmitting;

  const handleConfirm = () => {
    if (!canConfirm) return;
    onConfirm({
      prdOwnerId,
      designDocOwnerId,
      designPrototypeOwnerId,
      testCaseOwnerId,
      prdApproverIds: prdApproverIds.length > 0 ? prdApproverIds : undefined,
      designDocApproverIds: designDocApproverIds.length > 0 ? designDocApproverIds : undefined,
      designPrototypeApproverIds: designPrototypeApproverIds.length > 0 ? designPrototypeApproverIds : undefined,
      testCaseApproverIds: testCaseApproverIds.length > 0 ? testCaseApproverIds : undefined,
    });
  };

  return (
    <div
      className={styles.overlay}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="section-owner-title"
    >
      <div className={styles.card}>
        <div className={styles.header}>
          <div className={styles.headerText}>
            <h2 className={styles.title} id="section-owner-title">
              Assign Owners &amp; Reviewers
            </h2>
            <p className={styles.subtitle}>
              {step === 1
                ? 'Assign an owner for each document type.'
                : 'Select reviewers from the configured pool for each document type.'}
            </p>
          </div>
          <button
            className={styles.closeBtn}
            onClick={onCancel}
            aria-label="Close"
            type="button"
          >
            ✕
          </button>
        </div>

        <div className={styles.stepper}>
          <div className={`${styles.stepDot} ${step >= 1 ? styles.stepActive : ''} ${step > 1 ? styles.stepComplete : ''}`}>
            <span>1</span>
          </div>
          <div className={styles.stepLine} />
          <div className={`${styles.stepDot} ${step >= 2 ? styles.stepActive : ''}`}>
            <span>2</span>
          </div>
        </div>
        <div className={styles.stepLabel}>
          {step === 1 ? 'Step 1 of 2 — Select Owners' : 'Step 2 of 2 — Select Reviewers'}
        </div>

        {step === 1 && (
          <div className={styles.fields}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="so-prd-owner">
                PRD Owner (BA) *
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
                Design Doc Owner (Developer) *
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

            <div className={styles.field}>
              <label className={styles.label} htmlFor="so-proto-owner">
                Design Prototype Owner (UI/UX) *
              </label>
              {isLoading ? (
                <span className={styles.loadingText}>Loading users…</span>
              ) : (
                <UserCombobox
                  id="so-proto-owner"
                  users={users}
                  selectedId={designPrototypeOwnerId}
                  onSelect={setDesignPrototypeOwnerId}
                  placeholder="Search by name or email…"
                  disabled={isSubmitting}
                />
              )}
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="so-qa-owner">
                Test Case Owner (QA) *
              </label>
              {isLoading ? (
                <span className={styles.loadingText}>Loading users…</span>
              ) : (
                <UserCombobox
                  id="so-qa-owner"
                  users={users}
                  selectedId={testCaseOwnerId}
                  onSelect={setTestCaseOwnerId}
                  placeholder="Search by name or email…"
                  disabled={isSubmitting}
                />
              )}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className={styles.fields}>
            <div className={styles.field}>
              <label className={styles.label}>PRD Reviewers *</label>
              {prdPoolLoading ? (
                <span className={styles.loadingText}>Loading…</span>
              ) : !prdPool || (prdPool.individuals.length === 0 && prdPool.groups.length === 0) ? (
                <span className={styles.noApprovers}>No approvers configured</span>
              ) : (
                renderPoolChips(prdPool, prdApproverIds, togglePrdApprover)
              )}
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Design Doc Reviewers *</label>
              {ddPoolLoading ? (
                <span className={styles.loadingText}>Loading…</span>
              ) : !ddPool || (ddPool.individuals.length === 0 && ddPool.groups.length === 0) ? (
                <span className={styles.noApprovers}>No approvers configured</span>
              ) : (
                renderPoolChips(ddPool, designDocApproverIds, toggleDdApprover)
              )}
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Design Prototype Reviewers *</label>
              {protoPoolLoading ? (
                <span className={styles.loadingText}>Loading…</span>
              ) : !protoPool || (protoPool.individuals.length === 0 && protoPool.groups.length === 0) ? (
                <span className={styles.noApprovers}>No approvers configured</span>
              ) : (
                renderPoolChips(protoPool, designPrototypeApproverIds, toggleProtoApprover)
              )}
            </div>

            <div className={styles.field}>
              <label className={styles.label}>QA Reviewers *</label>
              {qaPoolLoading ? (
                <span className={styles.loadingText}>Loading…</span>
              ) : !qaPool || (qaPool.individuals.length === 0 && qaPool.groups.length === 0) ? (
                <span className={styles.noApprovers}>No approvers configured</span>
              ) : (
                renderPoolChips(qaPool, testCaseApproverIds, toggleQaApprover)
              )}
            </div>
          </div>
        )}

        {step === 2 && !canConfirm && !isSubmitting && (
          <p className={styles.validationHint}>
            Select at least one reviewer in each section
          </p>
        )}

        <div className={styles.navRow}>
          {step === 1 ? (
            <>
              <button
                className={styles.btnSkip}
                onClick={onCancel}
                disabled={isSubmitting}
                type="button"
              >
                Cancel
              </button>
              <button
                className={styles.btnConfirm}
                onClick={() => setStep(2)}
                disabled={!allOwnersSelected || isSubmitting}
                type="button"
              >
                Next →
              </button>
            </>
          ) : (
            <>
              <button
                className={styles.btnSkip}
                onClick={() => setStep(1)}
                disabled={isSubmitting}
                type="button"
              >
                ← Back
              </button>
              <button
                className={styles.btnConfirm}
                onClick={handleConfirm}
                disabled={!canConfirm}
                type="button"
              >
                {isSubmitting ? 'Creating…' : 'Confirm & Start Interview'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default SectionOwnerModal;
