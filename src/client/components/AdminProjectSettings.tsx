import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  useAllProjectSkillConfigs,
  useUpsertProjectSkillConfig,
  useDeleteProjectSkillConfig,
  useAvailableModels,
  useProjectApprovers,
  useSetProjectApprovers,
} from '../hooks/useProjectSkillConfig';
import { useSkillRepos, useSkillBranches, useSkillList } from '../hooks/useChatThreads';
import { useUsers } from '../hooks/useRbac';
import type { ProjectSkillConfig, QuickSkillPill } from '../../shared/types/projectSettings';
import type { UserWithRoles } from '../../shared/types/rbac';
import styles from './AdminProjectSettings.module.css';

// ── BranchCombobox ─────────────────────────────────────────────────────────────

interface BranchComboboxProps {
  value: string;
  branches: string[];
  isLoading: boolean;
  disabled: boolean;
  onChange: (branch: string) => void;
}

const BranchCombobox: React.FC<BranchComboboxProps> = ({ value, branches, isLoading, disabled, onChange }) => {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!query.trim()) return branches;
    const q = query.toLowerCase();
    return branches.filter((b) => b.toLowerCase().includes(q));
  }, [query, branches]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, open]);

  useEffect(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 0);
      const selectedIdx = branches.indexOf(value);
      if (selectedIdx >= 0) setActiveIdx(selectedIdx);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleToggle = useCallback(() => {
    if (disabled || isLoading) return;
    if (!open) {
      setQuery('');
      setOpen(true);
    } else {
      setOpen(false);
      setQuery('');
    }
  }, [disabled, isLoading, open]);

  const handleSelect = useCallback((branch: string) => {
    onChange(branch);
    setQuery('');
    setOpen(false);
  }, [onChange]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[activeIdx]) handleSelect(filtered[activeIdx]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
    }
  };

  const triggerLabel = isLoading
    ? 'Loading branches…'
    : value || '— select a branch —';

  const hasValue = Boolean(value);

  return (
    <div className={styles.branchComboWrap} ref={wrapRef}>
      <button
        type="button"
        className={`${styles.branchComboTrigger} ${open ? styles.branchComboTriggerOpen : ''} ${hasValue ? styles.branchComboTriggerHasValue : ''}`}
        onClick={handleToggle}
        disabled={disabled || isLoading}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={styles.branchComboTriggerIcon} aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="5" cy="3.5" r="1.5" />
            <circle cx="5" cy="12.5" r="1.5" />
            <circle cx="11" cy="8" r="1.5" />
            <path d="M5 5v6M5 5C5 5 11 5 11 8" />
          </svg>
        </span>
        <span className={`${styles.branchComboTriggerLabel} ${!hasValue ? styles.branchComboTriggerPlaceholder : ''}`}>
          {triggerLabel}
        </span>
        <svg
          className={`${styles.branchComboChevron} ${open ? styles.branchComboChevronOpen : ''}`}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="2 4 6 8 10 4" />
        </svg>
      </button>

      {open && (
        <div className={styles.branchComboDropdown} role="dialog" aria-label="Select branch">
          <div className={styles.branchComboSearchRow}>
            <svg className={styles.branchComboSearchIcon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="6.5" cy="6.5" r="4" />
              <line x1="10" y1="10" x2="14" y2="14" />
            </svg>
            <input
              ref={searchRef}
              className={styles.branchComboSearch}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search branches…"
              autoComplete="off"
              spellCheck={false}
              aria-label="Search branches"
            />
            {query && (
              <button
                type="button"
                className={styles.branchComboClear}
                onMouseDown={(e) => { e.preventDefault(); setQuery(''); setActiveIdx(0); searchRef.current?.focus(); }}
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>

          <div className={styles.branchComboMeta}>
            {query.trim()
              ? `${filtered.length} match${filtered.length !== 1 ? 'es' : ''} of ${branches.length}`
              : `${branches.length} branch${branches.length !== 1 ? 'es' : ''}`}
          </div>

          <div className={styles.branchComboList} ref={listRef} role="listbox">
            {filtered.length === 0 ? (
              <div className={styles.branchComboEmpty}>
                No branches match &ldquo;{query}&rdquo;
              </div>
            ) : (
              filtered.map((b, idx) => {
                const isSelected = b === value;
                const isActive = idx === activeIdx;
                return (
                  <button
                    key={b}
                    data-active={isActive ? 'true' : undefined}
                    role="option"
                    aria-selected={isSelected}
                    className={`${styles.branchComboItem} ${isActive ? styles.branchComboItemActive : ''} ${isSelected ? styles.branchComboItemSelected : ''}`}
                    onMouseDown={(e) => { e.preventDefault(); handleSelect(b); }}
                    onMouseEnter={() => setActiveIdx(idx)}
                    type="button"
                  >
                    <span className={styles.branchComboItemLabel}>{b}</span>
                    {isSelected && (
                      <svg className={styles.branchComboCheck} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="2 6 5 9 10 3" />
                      </svg>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// ── UserPicker ─────────────────────────────────────────────────────────────────

interface UserPickerProps {
  users: UserWithRoles[];
  selectedIds: string[];
  onAdd: (userId: string) => void;
  disabled?: boolean;
}

const UserPicker: React.FC<UserPickerProps> = ({ users, selectedIds, onAdd, disabled }) => {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const available = useMemo(() => {
    const selected = new Set(selectedIds);
    return users
      .filter((u) => !selected.has(u.oid))
      .filter((u) => {
        if (!query.trim()) return true;
        const q = query.toLowerCase();
        return (
          (u.displayName?.toLowerCase().includes(q)) ||
          (u.email?.toLowerCase().includes(q))
        );
      });
  }, [users, selectedIds, query]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className={styles.userPicker} ref={wrapRef}>
      <input
        ref={inputRef}
        className={styles.userPickerInput}
        placeholder="Search users to add…"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
      />
      {open && (
        <div className={styles.userPickerDropdown}>
          {available.length === 0 ? (
            <div className={styles.userPickerEmpty}>
              {query.trim() ? 'No matching users' : 'No more users to add'}
            </div>
          ) : (
            available.map((u) => (
              <button
                key={u.oid}
                type="button"
                className={styles.userPickerOption}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onAdd(u.oid);
                  setQuery('');
                  setOpen(false);
                }}
              >
                <span>{u.displayName || u.email || u.oid}</span>
                {u.email && u.displayName && (
                  <span className={styles.userPickerOptionEmail}>{u.email}</span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};

// ── AccordionSection ───────────────────────────────────────────────────────────

interface AccordionSectionProps {
  title: string;
  hint?: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

const AccordionSection: React.FC<AccordionSectionProps> = ({ title, hint, expanded, onToggle, children }) => (
  <div className={styles.accordionSection}>
    <button type="button" className={styles.accordionHeader} onClick={onToggle} aria-expanded={expanded}>
      <svg
        className={`${styles.accordionChevron} ${expanded ? styles.accordionChevronOpen : ''}`}
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="4 2 8 6 4 10" />
      </svg>
      <span className={styles.accordionTitle}>{title}</span>
      {hint && <span className={styles.accordionHint}>{hint}</span>}
    </button>
    <div className={`${styles.accordionBody} ${expanded ? styles.accordionBodyOpen : ''}`}>
      {children}
    </div>
  </div>
);

// ── Skill field descriptions ───────────────────────────────────────────────────

const SKILL_FIELDS = [
  { key: 'interviewSkillPath' as const, label: 'Interview Skill', desc: 'Guides the stakeholder interview process', emptyLabel: 'None (use default)' },
  { key: 'prdSkillPath' as const, label: 'PRD Skill', desc: 'Generates the product requirements document', emptyLabel: 'None (use default)' },
  { key: 'designDocSkillPath' as const, label: 'Design Doc Skill', desc: 'Produces the technical design document', emptyLabel: 'None (use default)' },
  { key: 'designDocQaSkillPath' as const, label: 'Design Doc Q&A Skill', desc: 'Runs the Q&A review phase on design docs', emptyLabel: 'None (skip Q&A phase)' },
  { key: 'designDocAssistantSkillPath' as const, label: 'Design Doc Assistant Skill', desc: 'Provides AI assistance during design doc editing', emptyLabel: 'None (use default model, no skill)' },
  { key: 'designDocValidationSkillPath' as const, label: 'Design Doc Validation Skill', desc: 'Validates completed design documents', emptyLabel: 'None (skip validation phase)' },
] as const;

const MODEL_FIELDS = [
  { key: 'interviewModel' as const, label: 'Interview Model' },
  { key: 'prdModel' as const, label: 'PRD Model' },
  { key: 'designDocModel' as const, label: 'Design Doc Model' },
  { key: 'designDocQaModel' as const, label: 'Design Doc Q&A Model' },
  { key: 'designDocAssistantModel' as const, label: 'Design Doc Assistant Model' },
  { key: 'designDocValidationModel' as const, label: 'Design Doc Validation Model' },
] as const;

// ── Main component ─────────────────────────────────────────────────────────────

interface AdminProjectSettingsProps {
  selectedProject?: string;
  availableProjects?: string[];
}

interface EditState {
  project: string;
  skillRepo: string;
  skillBranch: string;
  interviewSkillPath: string;
  prdSkillPath: string;
  designDocSkillPath: string;
  designDocQaSkillPath: string;
  designDocAssistantSkillPath: string;
  designDocValidationSkillPath: string;
  interviewModel: string;
  prdModel: string;
  designDocModel: string;
  designDocQaModel: string;
  designDocAssistantModel: string;
  designDocValidationModel: string;
  defaultModel: string;
  quickSkillPills: QuickSkillPill[];
  isNew: boolean;
}

const emptyEdit = (): EditState => ({
  project: '', skillRepo: '', skillBranch: '',
  interviewSkillPath: '', prdSkillPath: '', designDocSkillPath: '',
  designDocQaSkillPath: '', designDocAssistantSkillPath: '', designDocValidationSkillPath: '',
  interviewModel: '', prdModel: '', designDocModel: '',
  designDocQaModel: '', designDocAssistantModel: '', designDocValidationModel: '',
  defaultModel: '',
  quickSkillPills: [], isNew: true,
});

export const AdminProjectSettings: React.FC<AdminProjectSettingsProps> = ({
  selectedProject = '',
}) => {
  // ── Data hooks ─────────────────────────────────────────────────────────
  const { data: configs = [], isLoading, isError } = useAllProjectSkillConfigs();
  const upsert = useUpsertProjectSkillConfig();
  const remove = useDeleteProjectSkillConfig();
  const { data: availableModels = [], isLoading: isLoadingModels } = useAvailableModels();
  const { data: allUsers = [] } = useUsers();

  // ── Derived: filter to current project ────────────────────────────────
  const projectConfigs = configs.filter((c) => c.project === selectedProject);
  const currentConfig = projectConfigs[0] ?? null;

  // ── Local state ────────────────────────────────────────────────────────
  const [edit, setEdit] = useState<EditState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingProject, setDeletingProject] = useState<string | null>(null);

  // Accordion expanded state
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    repo: true,
    skills: false,
    models: false,
    approvers: false,
    pills: false,
  });

  // Approver local state
  const [designDocApproverIds, setDesignDocApproverIds] = useState<string[]>([]);
  const [prdApproverIds, setPrdApproverIds] = useState<string[]>([]);

  // ── Data queries dependent on edit state ───────────────────────────────
  const { data: repos = [], isLoading: isLoadingRepos } = useSkillRepos(edit?.project || null);
  const { data: branches = [], isLoading: isLoadingBranches } = useSkillBranches(
    edit?.project || null,
    edit?.skillRepo || null,
  );
  const { data: skillList = [], isLoading: isLoadingSkills } = useSkillList(
    edit?.project || null,
    edit?.skillRepo || null,
    edit?.skillBranch || undefined,
  );
  const { data: approvers = [] } = useProjectApprovers(edit?.project || null);
  const setApprovers = useSetProjectApprovers();

  // ── Effects ────────────────────────────────────────────────────────────

  // Auto-populate branch when repo changes
  useEffect(() => {
    if (!edit?.skillRepo || !repos.length) return;
    const repo = repos.find((r) => r.name === edit.skillRepo);
    if (repo && !edit.skillBranch) {
      setEdit((prev) => prev ? { ...prev, skillBranch: repo.defaultBranch } : prev);
    }
  }, [edit?.skillRepo, repos]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync approver local state when remote data arrives
  useEffect(() => {
    if (approvers.length > 0) {
      setDesignDocApproverIds(
        approvers.filter((a) => a.documentType === 'design_doc').map((a) => a.userId),
      );
      setPrdApproverIds(
        approvers.filter((a) => a.documentType === 'prd').map((a) => a.userId),
      );
    }
  }, [approvers]);

  // ── Computed ───────────────────────────────────────────────────────────

  const userMap = useMemo(() => {
    const map = new Map<string, UserWithRoles>();
    for (const u of allUsers) map.set(u.oid, u);
    return map;
  }, [allUsers]);

  // ── Handlers ───────────────────────────────────────────────────────────

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleAddNew = () => {
    setEdit({ ...emptyEdit(), project: selectedProject });
    setFormError(null);
    setDesignDocApproverIds([]);
    setPrdApproverIds([]);
    setExpandedSections({ repo: true, skills: false, models: false, approvers: false, pills: false });
  };

  const handleEditRow = (config: ProjectSkillConfig) => {
    setEdit({
      project: config.project,
      skillRepo: config.skillRepo,
      skillBranch: config.skillBranch,
      interviewSkillPath: config.interviewSkillPath ?? '',
      prdSkillPath: config.prdSkillPath ?? '',
      designDocSkillPath: config.designDocSkillPath ?? '',
      designDocQaSkillPath: config.designDocQaSkillPath ?? '',
      designDocAssistantSkillPath: config.designDocAssistantSkillPath ?? '',
      designDocValidationSkillPath: config.designDocValidationSkillPath ?? '',
      interviewModel: config.interviewModel ?? '',
      prdModel: config.prdModel ?? '',
      designDocModel: config.designDocModel ?? '',
      designDocQaModel: config.designDocQaModel ?? '',
      designDocAssistantModel: config.designDocAssistantModel ?? '',
      designDocValidationModel: config.designDocValidationModel ?? '',
      defaultModel: config.defaultModel ?? '',
      quickSkillPills: config.quickSkillPills ?? [],
      isNew: false,
    });
    setFormError(null);
    setDesignDocApproverIds([]);
    setPrdApproverIds([]);
    setExpandedSections({ repo: true, skills: false, models: false, approvers: false, pills: false });
  };

  const handleRepoChange = (repoName: string) => {
    const repo = repos.find((r) => r.name === repoName);
    setEdit((prev) => prev
      ? { ...prev, skillRepo: repoName, skillBranch: repo?.defaultBranch ?? '' }
      : prev);
  };

  const handleCancel = () => {
    setEdit(null);
    setFormError(null);
  };

  const handleSave = async () => {
    if (!edit) return;
    if (!edit.project.trim()) { setFormError('Project is required.'); return; }
    if (!edit.skillRepo.trim()) { setFormError('Skill Repo is required.'); return; }
    if (!edit.skillBranch.trim()) { setFormError('Skill Branch is required.'); return; }
    setFormError(null);
    try {
      await upsert.mutateAsync({
        project: edit.project.trim(),
        body: {
          skillRepo: edit.skillRepo.trim(),
          skillBranch: edit.skillBranch.trim(),
          interviewSkillPath: edit.interviewSkillPath || null,
          prdSkillPath: edit.prdSkillPath || null,
          designDocSkillPath: edit.designDocSkillPath || null,
          designDocQaSkillPath: edit.designDocQaSkillPath || null,
          designDocAssistantSkillPath: edit.designDocAssistantSkillPath || null,
          designDocValidationSkillPath: edit.designDocValidationSkillPath || null,
          interviewModel: edit.interviewModel || null,
          prdModel: edit.prdModel || null,
          designDocModel: edit.designDocModel || null,
          designDocQaModel: edit.designDocQaModel || null,
          designDocAssistantModel: edit.designDocAssistantModel || null,
          designDocValidationModel: edit.designDocValidationModel || null,
          defaultModel: edit.defaultModel || null,
          quickSkillPills: edit.quickSkillPills.length > 0 ? edit.quickSkillPills : null,
        },
      });

      // Save approvers if any were configured
      if (designDocApproverIds.length > 0 || prdApproverIds.length > 0 || approvers.length > 0) {
        await setApprovers.mutateAsync({
          project: edit.project.trim(),
          designDocApprovers: designDocApproverIds,
          prdApprovers: prdApproverIds,
        });
      }

      setEdit(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save.');
    }
  };

  const handleDelete = async (project: string) => {
    if (!window.confirm(`Delete skill config for "${project}"? This cannot be undone.`)) return;
    setDeletingProject(project);
    try {
      await remove.mutateAsync(project);
    } finally {
      setDeletingProject(null);
    }
  };

  const getUserLabel = (userId: string) => {
    const u = userMap.get(userId);
    return u?.displayName || u?.email || userId;
  };

  // ── Render helpers ─────────────────────────────────────────────────────

  const renderApproverBadge = (config: ProjectSkillConfig) => {
    const ddCount = config.designDocApproverCount ?? 0;
    const prdCount = config.prdApproverCount ?? 0;
    if (ddCount === 0 && prdCount === 0) {
      return <span className={`${styles.approverBadge} ${styles.approverBadgeEmpty}`}>No approvers</span>;
    }
    const parts: string[] = [];
    if (ddCount > 0) parts.push(`${ddCount} design doc`);
    if (prdCount > 0) parts.push(`${prdCount} PRD`);
    return <span className={styles.approverBadge}>{parts.join(' · ')}</span>;
  };

  const renderApproverSection = (
    title: string,
    ids: string[],
    setIds: React.Dispatch<React.SetStateAction<string[]>>,
  ) => (
    <div className={styles.approverSubSection}>
      <p className={styles.approverSubTitle}>{title}</p>
      <div className={styles.userChipList}>
        {ids.length === 0 && <span className={styles.noApprovers}>No approvers assigned</span>}
        {ids.map((uid) => (
          <span key={uid} className={styles.userChip}>
            {getUserLabel(uid)}
            <button
              type="button"
              className={styles.userChipRemove}
              onClick={() => setIds((prev) => prev.filter((id) => id !== uid))}
              aria-label={`Remove ${getUserLabel(uid)}`}
              disabled={upsert.isPending}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <UserPicker
        users={allUsers}
        selectedIds={ids}
        onAdd={(uid) => setIds((prev) => [...prev, uid])}
        disabled={upsert.isPending}
      />
    </div>
  );

  // ── Early returns ──────────────────────────────────────────────────────

  if (isLoading) return <div className={styles.loading}>Loading project settings…</div>;
  if (isError) return <div className={styles.error}>Failed to load project settings.</div>;

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        {/* ── Page header ─────────────────────────────────────────────── */}
        <div className={styles.pageHeader}>
          <div>
            <h1 className={styles.pageTitle}>Project Skill Settings</h1>
            <p className={styles.pageSubtitle}>Configure skill repository, pipeline settings, and document approvers for <strong>{selectedProject}</strong>.</p>
          </div>
          {!edit && !currentConfig && (
            <button className={styles.btnPrimary} onClick={handleAddNew} type="button">
              + Add Config
            </button>
          )}
        </div>

        {/* ── Edit form (accordion layout) ────────────────────────────── */}
        {edit && (
          <div className={styles.formCard}>
            <p className={styles.formTitle}>{edit.isNew ? 'Add Project Skill Config' : `Edit: ${edit.project}`}</p>

            {/* Section 1: Repository & Branch */}
            <AccordionSection
              title="Repository & Branch"
              expanded={expandedSections.repo}
              onToggle={() => toggleSection('repo')}
            >
              <p className={styles.accordionHelp}>
                Select the Azure DevOps repository and branch containing your agent skills.
              </p>
              <div className={styles.formGridThreeCol}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-project">Project</label>
                  <input
                    id="ps-project"
                    className={styles.input}
                    value={edit.project}
                    disabled
                    readOnly
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-repo">Skill Repo</label>
                  <select
                    id="ps-repo"
                    className={styles.select}
                    value={edit.skillRepo}
                    onChange={(e) => handleRepoChange(e.target.value)}
                    disabled={upsert.isPending || isLoadingRepos || !edit.project}
                  >
                    <option value="">{isLoadingRepos ? 'Loading repos…' : '— select a repo —'}</option>
                    {repos.map((r) => (
                      <option key={r.id} value={r.name}>{r.name}</option>
                    ))}
                  </select>
                </div>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-branch">Skill Branch</label>
                  <BranchCombobox
                    value={edit.skillBranch}
                    branches={branches}
                    isLoading={isLoadingBranches}
                    disabled={upsert.isPending || !edit.skillRepo}
                    onChange={(branch) => setEdit((prev) => prev ? { ...prev, skillBranch: branch } : prev)}
                  />
                </div>
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="ps-defaultModel">Default Model</label>
                <select
                  id="ps-defaultModel"
                  className={styles.select}
                  value={edit.defaultModel}
                  onChange={(e) => setEdit((prev) => prev ? { ...prev, defaultModel: e.target.value } : prev)}
                  disabled={upsert.isPending || isLoadingModels}
                >
                  <option value="">Use system default (composer-2)</option>
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.displayName}</option>
                  ))}
                </select>
                <span className={styles.modelDefault}>Fallback model for all pipeline stages without a specific override</span>
              </div>
            </AccordionSection>

            {/* Section 2: Process Skills */}
            <AccordionSection
              title="Process Skills"
              hint={edit.skillRepo ? `${skillList.length} available` : undefined}
              expanded={expandedSections.skills}
              onToggle={() => toggleSection('skills')}
            >
              <p className={styles.accordionHelp}>
                Assign skills from the selected repo to each stage of the document pipeline.
              </p>
              <div className={styles.formGrid}>
                {SKILL_FIELDS.map((sf) => (
                  <div key={sf.key} className={styles.field}>
                    <label className={styles.label} htmlFor={`ps-${sf.key}`}>{sf.label}</label>
                    <select
                      id={`ps-${sf.key}`}
                      className={styles.select}
                      value={edit[sf.key]}
                      onChange={(e) => setEdit((prev) => prev ? { ...prev, [sf.key]: e.target.value } : prev)}
                      disabled={upsert.isPending || isLoadingSkills || !edit.skillRepo}
                    >
                      <option value="">{sf.emptyLabel}</option>
                      {skillList.map((s) => (
                        <option key={s.id} value={s.path}>{s.name}</option>
                      ))}
                    </select>
                    <span className={styles.skillDescription}>{sf.desc}</span>
                  </div>
                ))}
              </div>
            </AccordionSection>

            {/* Section 3: Model Overrides */}
            <AccordionSection
              title="Model Overrides"
              expanded={expandedSections.models}
              onToggle={() => toggleSection('models')}
            >
              <p className={styles.accordionHelp}>
                Override the AI model for specific pipeline stages. Unset fields use the project default model.
              </p>
              <div className={styles.formGrid}>
                {MODEL_FIELDS.map((mf) => (
                  <div key={mf.key} className={styles.field}>
                    <label className={styles.label} htmlFor={`ps-${mf.key}`}>{mf.label}</label>
                    <select
                      id={`ps-${mf.key}`}
                      className={styles.select}
                      value={edit[mf.key]}
                      onChange={(e) => setEdit((prev) => prev ? { ...prev, [mf.key]: e.target.value } : prev)}
                      disabled={upsert.isPending || isLoadingModels}
                    >
                      <option value="">Use project default</option>
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id}>{m.displayName}</option>
                      ))}
                    </select>
                    {!edit[mf.key] && (
                      <span className={styles.modelDefault}>
                        Using: {edit.defaultModel
                          ? availableModels.find((m) => m.id === edit.defaultModel)?.displayName ?? edit.defaultModel
                          : 'system default (composer-2)'}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </AccordionSection>

            {/* Section 4: Approvers */}
            <AccordionSection
              title="Approvers"
              hint={
                (designDocApproverIds.length + prdApproverIds.length) > 0
                  ? `${designDocApproverIds.length + prdApproverIds.length} assigned`
                  : undefined
              }
              expanded={expandedSections.approvers}
              onToggle={() => toggleSection('approvers')}
            >
              <p className={styles.accordionHelp}>
                Designate who can approve documents for this project. Users must also have the appropriate review permission.
              </p>
              {renderApproverSection('Design Doc Approvers', designDocApproverIds, setDesignDocApproverIds)}
              {renderApproverSection('PRD Approvers', prdApproverIds, setPrdApproverIds)}
            </AccordionSection>

            {/* Section 5: Quick Skill Pills */}
            <AccordionSection
              title="Quick Skill Pills"
              hint={edit.quickSkillPills.length > 0 ? `${edit.quickSkillPills.length} configured` : undefined}
              expanded={expandedSections.pills}
              onToggle={() => toggleSection('pills')}
            >
              <p className={styles.accordionHelp}>
                Shortcut pills displayed on the home page for quick skill access.
              </p>

              {edit.quickSkillPills.length > 0 && (
                <div className={styles.pillList}>
                  {edit.quickSkillPills.map((pill, idx) => (
                    <div key={idx} className={styles.pillItem}>
                      <div className={styles.pillItemRow}>
                        <span className={styles.pillLabel}>{pill.label}</span>
                        <span className={styles.pillPath}>{pill.skillPath}</span>
                        <select
                          className={styles.select}
                          style={{ flex: '0 0 10rem', height: '28px', padding: '4px 8px', fontSize: '12px' }}
                          value={pill.model ?? ''}
                          onChange={(e) => {
                            const pills = [...edit.quickSkillPills];
                            pills[idx] = { ...pills[idx], model: e.target.value || null };
                            setEdit((prev) => prev ? { ...prev, quickSkillPills: pills } : prev);
                          }}
                          disabled={upsert.isPending || isLoadingModels}
                        >
                          <option value="">Default model</option>
                          {availableModels.map((m) => (
                            <option key={m.id} value={m.id}>{m.displayName}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className={styles.btnAction}
                          disabled={idx === 0}
                          onClick={() => {
                            const pills = [...edit.quickSkillPills];
                            [pills[idx - 1], pills[idx]] = [pills[idx], pills[idx - 1]];
                            setEdit((prev) => prev ? { ...prev, quickSkillPills: pills } : prev);
                          }}
                          title="Move up"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className={styles.btnAction}
                          disabled={idx === edit.quickSkillPills.length - 1}
                          onClick={() => {
                            const pills = [...edit.quickSkillPills];
                            [pills[idx], pills[idx + 1]] = [pills[idx + 1], pills[idx]];
                            setEdit((prev) => prev ? { ...prev, quickSkillPills: pills } : prev);
                          }}
                          title="Move down"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className={`${styles.btnAction} ${styles.btnActionDanger}`}
                          onClick={() => {
                            const pills = edit.quickSkillPills.filter((_, i) => i !== idx);
                            setEdit((prev) => prev ? { ...prev, quickSkillPills: pills } : prev);
                          }}
                          title="Remove pill"
                        >
                          Remove
                        </button>
                      </div>
                      <input
                        className={styles.input}
                        style={{ fontSize: '0.8rem', padding: '4px 8px' }}
                        placeholder="User-facing description (e.g. Get help troubleshooting production issues)"
                        value={pill.description ?? ''}
                        onChange={(e) => {
                          const pills = [...edit.quickSkillPills];
                          pills[idx] = { ...pills[idx], description: e.target.value || null };
                          setEdit((prev) => prev ? { ...prev, quickSkillPills: pills } : prev);
                        }}
                        disabled={upsert.isPending}
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className={styles.pillAddRow}>
                <div className={styles.field} style={{ flex: '0 0 10rem' }}>
                  <label className={styles.label} htmlFor="ps-pill-label">Label</label>
                  <input
                    id="ps-pill-label"
                    className={styles.input}
                    placeholder="e.g. Production Support"
                    disabled={upsert.isPending || isLoadingSkills || !edit.skillRepo}
                  />
                </div>
                <div className={styles.field} style={{ flex: 1 }}>
                  <label className={styles.label} htmlFor="ps-pill-skill">Skill</label>
                  <select
                    id="ps-pill-skill"
                    className={styles.select}
                    disabled={upsert.isPending || isLoadingSkills || !edit.skillRepo}
                  >
                    <option value="">— select a skill —</option>
                    {skillList.map((s) => (
                      <option key={s.id} value={s.path}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div className={styles.field} style={{ flex: '0 0 10rem' }}>
                  <label className={styles.label} htmlFor="ps-pill-model">Model</label>
                  <select
                    id="ps-pill-model"
                    className={styles.select}
                    disabled={upsert.isPending || isLoadingModels || !edit.skillRepo}
                  >
                    <option value="">Use default</option>
                    {availableModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.displayName}</option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  className={styles.btnAction}
                  disabled={upsert.isPending || isLoadingSkills || !edit.skillRepo}
                  onClick={() => {
                    const labelEl = document.getElementById('ps-pill-label') as HTMLInputElement | null;
                    const skillEl = document.getElementById('ps-pill-skill') as HTMLSelectElement | null;
                    const modelEl = document.getElementById('ps-pill-model') as HTMLSelectElement | null;
                    if (!labelEl || !skillEl) return;
                    const label = labelEl.value.trim();
                    const skillPath = skillEl.value;
                    if (!label || !skillPath) return;
                    const pillModel = modelEl?.value || null;
                    setEdit((prev) => prev ? { ...prev, quickSkillPills: [...prev.quickSkillPills, { label, skillPath, model: pillModel }] } : prev);
                    labelEl.value = '';
                    skillEl.value = '';
                    if (modelEl) modelEl.value = '';
                  }}
                >
                  Add
                </button>
              </div>
            </AccordionSection>

            {formError && <p className={styles.formError}>{formError}</p>}
            <div className={styles.formActions} style={{ marginTop: '12px' }}>
              <button className={styles.btnCancel} onClick={handleCancel} type="button" disabled={upsert.isPending}>
                Cancel
              </button>
              <button className={styles.btnPrimary} onClick={() => void handleSave()} type="button" disabled={upsert.isPending}>
                {upsert.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}

        {/* ── Project config list ─────────────────────────────────────── */}
        {projectConfigs.length === 0 && !edit ? (
          <div className={styles.empty}>
            <p>No skill settings configured for <strong>{selectedProject}</strong>. Click <strong>+ Add Config</strong> to get started.</p>
          </div>
        ) : (
          !edit && (
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.th}>Project</th>
                    <th className={styles.th}>Skill Repo / Branch</th>
                    <th className={styles.th}>Approvers</th>
                    <th className={styles.th}>Last Updated</th>
                    <th className={styles.th}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {projectConfigs.map((config) => (
                    <tr key={config.project} className={styles.tr}>
                      <td className={styles.td}>
                        <span className={styles.projectName}>{config.project}</span>
                      </td>
                      <td className={styles.td}>
                        <span className={styles.repoText}>{config.skillRepo}</span>
                        <span className={styles.approverBadgeSeparator}> / </span>
                        <span className={styles.branchText}>{config.skillBranch}</span>
                      </td>
                      <td className={styles.td}>
                        {renderApproverBadge(config)}
                      </td>
                      <td className={styles.td}>
                        <span className={styles.metaText}>
                          {config.updatedBy ?? '—'}
                          {config.updatedAt && (
                            <> · {new Date(config.updatedAt).toLocaleDateString()}</>
                          )}
                        </span>
                      </td>
                      <td className={styles.td}>
                        <div className={styles.actions}>
                          <button
                            className={styles.btnAction}
                            onClick={() => handleEditRow(config)}
                            type="button"
                            disabled={!!edit || remove.isPending}
                          >
                            Edit
                          </button>
                          <button
                            className={`${styles.btnAction} ${styles.btnActionDanger}`}
                            onClick={() => void handleDelete(config.project)}
                            type="button"
                            disabled={deletingProject === config.project || remove.isPending}
                          >
                            {deletingProject === config.project ? 'Deleting…' : 'Delete'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </div>
  );
};
