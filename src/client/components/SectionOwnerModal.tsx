import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useActiveUsers, useAvailableApproverPool, useInterviewGroupsWithMembers } from '../hooks/useInterviews';
import { useReviewerAvailability } from '../hooks/useReviewerAvailability';
import type { ActiveUser } from '../../shared/types/interview';
import type { ReviewerDocumentType } from '../../shared/types/approvals';
import type { ApproverPoolResponse } from '../../shared/types/projectSettings';
import styles from './SectionOwnerModal.module.css';

/** Reviewer modules a kickoff can assign. `adr` is out of scope here. */
type KickoffModuleType = Exclude<ReviewerDocumentType, 'adr'>;

/** Kebab-case suffix used for labels and test ids (QA reads better than test-case). */
type KickoffModuleKey = 'prd' | 'design-doc' | 'design-prototype' | 'qa';

interface ReviewerModule {
  documentType: KickoffModuleType;
  uiKey: KickoffModuleKey;
  label: string;
  pool: ApproverPoolResponse | undefined;
  poolLoading: boolean;
  selectedIds: string[];
  onToggle: (id: string) => void;
}

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
            {...{ 'data-testid': `${id}-clear-btn` }}
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
        {...{ 'data-testid': `${id}-input` }}
      />
      {open && filtered.length > 0 && (
        <ul
          id={`${id}-listbox`}
          className={styles.comboDropdown}
          role="listbox"
          ref={listRef}
          {...{ 'data-testid': `${id}-listbox` }}
        >
          {filtered.map((u, idx) => (
            <li
              key={u.oid}
              role="option"
              aria-selected={idx === highlightIdx}
              className={`${styles.comboOption} ${idx === highlightIdx ? styles.comboOptionHighlight : ''}`}
              onMouseDown={() => handleSelect(u.oid)}
              onMouseEnter={() => setHighlightIdx(idx)}
              {...{ 'data-testid': `${id}-option-${u.oid}` }}
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
  /** When false, hide Design Prototype owner/reviewer fields. Defaults to true. */
  prototypeStageEnabled?: boolean;
  /** When false, hide Test Case owner/reviewer fields. Defaults to true. */
  testCasesEnabled?: boolean;
}

function renderPoolChips(
  pool: ApproverPoolResponse,
  selectedIds: string[],
  onToggle: (id: string) => void,
  sectionKey: string,
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
              {...{ 'data-testid': `section-owner-${sectionKey}-group-${group.id}-select-all-btn` }}
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
                  {...{ 'data-testid': `section-owner-${sectionKey}-chip-${m.userId}` }}
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
                  {...{ 'data-testid': `section-owner-${sectionKey}-chip-${ind.userId}` }}
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
  prototypeStageEnabled = true,
  testCasesEnabled = true,
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

  const { data: users = [], isLoading } = useActiveUsers(project);
  const { data: groupsWithMembers = [], isLoading: groupsLoading } = useInterviewGroupsWithMembers(project);
  const { data: prdPool, isLoading: prdPoolLoading } = useAvailableApproverPool(project, 'prd', false);
  const { data: ddPool, isLoading: ddPoolLoading } = useAvailableApproverPool(project, 'design_doc', false);
  const { data: protoPool, isLoading: protoPoolLoading } = useAvailableApproverPool(project, 'design_prototype', false);
  const { data: qaPool, isLoading: qaPoolLoading } = useAvailableApproverPool(project, 'test_case', false);
  const availability = useReviewerAvailability(project, 'interviews');

  const OWNER_GROUP_MAP: Record<string, string[]> = useMemo(() => ({
    prd: ['BA', 'Product-Owner'],
    designDoc: ['Developer'],
    designPrototype: ['UI/UX'],
    testCase: ['QA'],
  }), []);

  const usersFromGroups = useCallback((groupNames: string[]): ActiveUser[] => {
    const seen = new Set<string>();
    const result: ActiveUser[] = [];
    for (const g of groupsWithMembers) {
      if (groupNames.includes(g.name)) {
        for (const m of g.members) {
          if (!seen.has(m.userId)) {
            seen.add(m.userId);
            result.push({ oid: m.userId, displayName: m.displayName, email: m.email });
          }
        }
      }
    }
    return result.length > 0 ? result : users;
  }, [groupsWithMembers, users]);

  const prdOwnerUsers = useMemo(() => usersFromGroups(OWNER_GROUP_MAP.prd), [usersFromGroups, OWNER_GROUP_MAP]);
  const ddOwnerUsers = useMemo(() => usersFromGroups(OWNER_GROUP_MAP.designDoc), [usersFromGroups, OWNER_GROUP_MAP]);
  const protoOwnerUsers = useMemo(() => usersFromGroups(OWNER_GROUP_MAP.designPrototype), [usersFromGroups, OWNER_GROUP_MAP]);
  const qaOwnerUsers = useMemo(() => usersFromGroups(OWNER_GROUP_MAP.testCase), [usersFromGroups, OWNER_GROUP_MAP]);

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

  const allOwnersSelected =
    !!prdOwnerId &&
    !!designDocOwnerId &&
    (!prototypeStageEnabled || !!designPrototypeOwnerId) &&
    (!testCasesEnabled || !!testCaseOwnerId);

  const enabledModules: ReviewerModule[] = useMemo(() => {
    const modules: ReviewerModule[] = [
      {
        documentType: 'prd',
        uiKey: 'prd',
        label: 'PRD Reviewers',
        pool: prdPool,
        poolLoading: prdPoolLoading,
        selectedIds: prdApproverIds,
        onToggle: togglePrdApprover,
      },
      {
        documentType: 'design_doc',
        uiKey: 'design-doc',
        label: 'Design Doc Reviewers',
        pool: ddPool,
        poolLoading: ddPoolLoading,
        selectedIds: designDocApproverIds,
        onToggle: toggleDdApprover,
      },
    ];
    if (prototypeStageEnabled) {
      modules.push({
        documentType: 'design_prototype',
        uiKey: 'design-prototype',
        label: 'Design Prototype Reviewers',
        pool: protoPool,
        poolLoading: protoPoolLoading,
        selectedIds: designPrototypeApproverIds,
        onToggle: toggleProtoApprover,
      });
    }
    if (testCasesEnabled) {
      modules.push({
        documentType: 'test_case',
        uiKey: 'qa',
        label: 'QA Reviewers',
        pool: qaPool,
        poolLoading: qaPoolLoading,
        selectedIds: testCaseApproverIds,
        onToggle: toggleQaApprover,
      });
    }
    return modules;
  }, [
    prdPool, prdPoolLoading, prdApproverIds, togglePrdApprover,
    ddPool, ddPoolLoading, designDocApproverIds, toggleDdApprover,
    protoPool, protoPoolLoading, designPrototypeApproverIds, toggleProtoApprover,
    qaPool, qaPoolLoading, testCaseApproverIds, toggleQaApprover,
    prototypeStageEnabled, testCasesEnabled,
  ]);

  const availabilityFailed = availability.isError;
  const availabilityLoaded = !availabilityFailed && !!availability.data;
  const availabilityPending = !availabilityFailed && !availability.data;

  // Availability is the sole has-reviewers signal; the pools only supply chips.
  const availableModules = useMemo(() => {
    if (!availabilityLoaded) return [];
    const availableTypes = new Set(
      (availability.data?.modules ?? []).filter((m) => m.available).map((m) => m.documentType),
    );
    return enabledModules.filter((m) => availableTypes.has(m.documentType));
  }, [availabilityLoaded, availability.data, enabledModules]);

  /** Only a successful load may collapse the wizard to a single owner step. */
  const skipReviewerStep = availabilityLoaded && availableModules.length === 0;
  const effectiveStep = skipReviewerStep ? 1 : step;

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  const canConfirm =
    allOwnersSelected &&
    availabilityLoaded &&
    availableModules.every((m) => m.selectedIds.length > 0) &&
    !isSubmitting;

  const handleConfirm = () => {
    if (!canConfirm) return;
    onConfirm({
      prdOwnerId,
      designDocOwnerId,
      designPrototypeOwnerId: prototypeStageEnabled ? designPrototypeOwnerId : undefined,
      testCaseOwnerId: testCasesEnabled ? testCaseOwnerId : undefined,
      prdApproverIds: prdApproverIds.length > 0 ? prdApproverIds : undefined,
      designDocApproverIds: designDocApproverIds.length > 0 ? designDocApproverIds : undefined,
      designPrototypeApproverIds:
        prototypeStageEnabled && designPrototypeApproverIds.length > 0
          ? designPrototypeApproverIds
          : undefined,
      testCaseApproverIds:
        testCasesEnabled && testCaseApproverIds.length > 0 ? testCaseApproverIds : undefined,
    });
  };

  /** No module has a live reviewer: owner-only start, every assignment list empty. */
  const handleConfirmWithoutReviewers = () => {
    if (!allOwnersSelected || isSubmitting) return;
    onConfirm({
      prdOwnerId,
      designDocOwnerId,
      designPrototypeOwnerId: prototypeStageEnabled ? designPrototypeOwnerId : undefined,
      testCaseOwnerId: testCasesEnabled ? testCaseOwnerId : undefined,
      prdApproverIds: [],
      designDocApproverIds: [],
      designPrototypeApproverIds: [],
      testCaseApproverIds: [],
    });
  };

  return (
    <div
      className={styles.overlay}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="section-owner-title"
      {...{ 'data-testid': 'section-owner-modal' }}
    >
      <div className={styles.card}>
        <div className={styles.header}>
          <div className={styles.headerText}>
            <h2 className={styles.title} id="section-owner-title">
              Assign Owners &amp; Reviewers
            </h2>
            <p className={styles.subtitle}>
              {effectiveStep === 1
                ? 'Assign an owner for each document type.'
                : 'Select reviewers from the configured pool for each document type.'}
            </p>
          </div>
          <button
            className={styles.closeBtn}
            onClick={onCancel}
            aria-label="Close"
            type="button"
            {...{ 'data-testid': 'section-owner-close-btn' }}
          >
            ✕
          </button>
        </div>

        <div className={styles.stepper}>
          <div className={`${styles.stepDot} ${styles.stepActive} ${effectiveStep > 1 ? styles.stepComplete : ''}`}>
            <span>1</span>
          </div>
          {!skipReviewerStep && (
            <>
              <div className={styles.stepLine} />
              <div className={`${styles.stepDot} ${effectiveStep >= 2 ? styles.stepActive : ''}`}>
                <span>2</span>
              </div>
            </>
          )}
        </div>
        <div className={styles.stepLabel}>
          {skipReviewerStep
            ? 'Step 1 of 1 — Select Owners'
            : effectiveStep === 1
              ? 'Step 1 of 2 — Select Owners'
              : 'Step 2 of 2 — Select Reviewers'}
        </div>

        <div className={styles.scrollBody}>
          {effectiveStep === 1 && (
            <div className={styles.fields}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="so-prd-owner">
                  PRD Owner (BA) *
                </label>
                {isLoading || groupsLoading ? (
                  <span className={styles.loadingText}>Loading users…</span>
                ) : (
                  <UserCombobox
                    id="so-prd-owner"
                    users={prdOwnerUsers}
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
                {isLoading || groupsLoading ? (
                  <span className={styles.loadingText}>Loading users…</span>
                ) : (
                  <UserCombobox
                    id="so-dd-owner"
                    users={ddOwnerUsers}
                    selectedId={designDocOwnerId}
                    onSelect={setDesignDocOwnerId}
                    placeholder="Search by name or email…"
                    disabled={isSubmitting}
                  />
                )}
              </div>

              {prototypeStageEnabled && (
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="so-proto-owner">
                    Design Prototype Owner (UI/UX) *
                  </label>
                  {isLoading || groupsLoading ? (
                    <span className={styles.loadingText}>Loading users…</span>
                  ) : (
                    <UserCombobox
                      id="so-proto-owner"
                      users={protoOwnerUsers}
                      selectedId={designPrototypeOwnerId}
                      onSelect={setDesignPrototypeOwnerId}
                      placeholder="Search by name or email…"
                      disabled={isSubmitting}
                    />
                  )}
                </div>
              )}

              {testCasesEnabled && (
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="so-qa-owner">
                    Test Case Owner (QA) *
                  </label>
                  {isLoading || groupsLoading ? (
                    <span className={styles.loadingText}>Loading users…</span>
                  ) : (
                    <UserCombobox
                      id="so-qa-owner"
                      users={qaOwnerUsers}
                      selectedId={testCaseOwnerId}
                      onSelect={setTestCaseOwnerId}
                      placeholder="Search by name or email…"
                      disabled={isSubmitting}
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {effectiveStep === 2 && (
            <div className={styles.fields}>
              {availabilityFailed &&
                enabledModules.map((module) => (
                  <div className={styles.field} key={module.uiKey}>
                    <label className={styles.label}>{module.label} *</label>
                    <div
                      role="alert"
                      className={styles.approverSection}
                      {...{ 'data-testid': `reviewer-availability-error-${module.uiKey}` }}
                    >
                      <span className={styles.noApprovers}>
                        Could not check reviewer availability.
                      </span>
                      <button
                        type="button"
                        className={styles.selectAllBtn}
                        onClick={() => { void availability.refetch(); }}
                        disabled={isSubmitting}
                        {...{ 'data-testid': `section-owner-reviewer-retry-${module.uiKey}` }}
                      >
                        Retry
                      </button>
                    </div>
                  </div>
                ))}

              {availabilityPending && (
                <span className={styles.loadingText}>Checking reviewer availability…</span>
              )}

              {availabilityLoaded &&
                availableModules.map((module) => (
                  <div
                    className={styles.field}
                    key={module.uiKey}
                    {...{ 'data-testid': `reviewer-picker-${module.uiKey}` }}
                  >
                    <label className={styles.label}>{module.label} *</label>
                    {module.poolLoading ? (
                      <span className={styles.loadingText}>Loading…</span>
                    ) : !module.pool ||
                      (module.pool.individuals.length === 0 && module.pool.groups.length === 0) ? (
                      <span className={styles.noApprovers}>No approvers configured</span>
                    ) : (
                      renderPoolChips(
                        module.pool,
                        module.selectedIds,
                        module.onToggle,
                        module.uiKey,
                      )
                    )}
                  </div>
                ))}
            </div>
          )}

          {effectiveStep === 2 && !canConfirm && !isSubmitting && (
            <p className={styles.validationHint}>
              Select at least one reviewer in each section
            </p>
          )}
        </div>

        <div className={styles.navRow}>
          {effectiveStep === 1 ? (
            <>
              <button
                className={styles.btnSkip}
                onClick={onCancel}
                disabled={isSubmitting}
                type="button"
                {...{ 'data-testid': 'section-owner-cancel-btn' }}
              >
                Cancel
              </button>
              {skipReviewerStep ? (
                <button
                  className={styles.btnConfirm}
                  onClick={handleConfirmWithoutReviewers}
                  disabled={!allOwnersSelected || isSubmitting}
                  type="button"
                  {...{ 'data-testid': 'confirm-start-interview-no-reviewers' }}
                >
                  {isSubmitting ? 'Creating…' : 'Confirm & Start Interview'}
                </button>
              ) : (
                <button
                  className={styles.btnConfirm}
                  onClick={() => setStep(2)}
                  disabled={!allOwnersSelected || isSubmitting}
                  type="button"
                  {...{ 'data-testid': 'section-owner-next-btn' }}
                >
                  Next →
                </button>
              )}
            </>
          ) : (
            <>
              <button
                className={styles.btnSkip}
                onClick={() => setStep(1)}
                disabled={isSubmitting}
                type="button"
                {...{ 'data-testid': 'section-owner-back-btn' }}
              >
                ← Back
              </button>
              <button
                className={styles.btnConfirm}
                onClick={handleConfirm}
                disabled={!canConfirm}
                type="button"
                {...{ 'data-testid': 'section-owner-confirm-btn' }}
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
