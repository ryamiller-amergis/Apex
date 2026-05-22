import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  useAllProjectSkillConfigs,
  useUpsertProjectSkillConfig,
  useDeleteProjectSkillConfig,
  useGlobalDefaultModel,
  useSetGlobalDefaultModel,
  useAvailableModels,
} from '../hooks/useProjectSkillConfig';
import { useSkillProjects, useSkillRepos, useSkillBranches, useSkillList } from '../hooks/useChatThreads';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';
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

  // Scroll active item into view on keyboard nav
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, open]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 0);
      // Scroll selected item into view
      const selectedIdx = branches.indexOf(value);
      if (selectedIdx >= 0) setActiveIdx(selectedIdx);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on outside click
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
      {/* Trigger button — clearly distinct from search */}
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
          {/* Search row inside the dropdown */}
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

          {/* Result count hint */}
          <div className={styles.branchComboMeta}>
            {query.trim()
              ? `${filtered.length} match${filtered.length !== 1 ? 'es' : ''} of ${branches.length}`
              : `${branches.length} branch${branches.length !== 1 ? 'es' : ''}`}
          </div>

          {/* List */}
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
  interviewModel: string;
  prdModel: string;
  designDocModel: string;
  designDocQaModel: string;
  designDocAssistantModel: string;
  isNew: boolean;
}

export const AdminProjectSettings: React.FC<AdminProjectSettingsProps> = ({
  availableProjects = [],
}) => {
  const { data: configs = [], isLoading, isError } = useAllProjectSkillConfigs();
  const upsert = useUpsertProjectSkillConfig();
  const remove = useDeleteProjectSkillConfig();
  const { data: globalModelData } = useGlobalDefaultModel();
  const setGlobalModel = useSetGlobalDefaultModel();
  const { data: availableModels = [], isLoading: isLoadingModels } = useAvailableModels();
  const [globalModelInput, setGlobalModelInput] = useState('');
  const [globalModelSaved, setGlobalModelSaved] = useState(false);

  useEffect(() => {
    if (globalModelData?.value !== undefined) {
      setGlobalModelInput(globalModelData.value);
    }
  }, [globalModelData?.value]);

  const [edit, setEdit] = useState<EditState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingProject, setDeletingProject] = useState<string | null>(null);

  const { data: skillProjects = [], isLoading: isLoadingProjects } = useSkillProjects();

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

  // When repo selection changes, auto-populate defaultBranch
  useEffect(() => {
    if (!edit?.skillRepo || !repos.length) return;
    const repo = repos.find((r) => r.name === edit.skillRepo);
    if (repo && !edit.skillBranch) {
      setEdit((prev) => prev ? { ...prev, skillBranch: repo.defaultBranch } : prev);
    }
  }, [edit?.skillRepo, repos]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAddNew = () => {
    setEdit({ project: '', skillRepo: '', skillBranch: '', interviewSkillPath: '', prdSkillPath: '', designDocSkillPath: '', designDocQaSkillPath: '', designDocAssistantSkillPath: '', interviewModel: '', prdModel: '', designDocModel: '', designDocQaModel: '', designDocAssistantModel: '', isNew: true });
    setFormError(null);
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
      interviewModel: config.interviewModel ?? '',
      prdModel: config.prdModel ?? '',
      designDocModel: config.designDocModel ?? '',
      designDocQaModel: config.designDocQaModel ?? '',
      designDocAssistantModel: config.designDocAssistantModel ?? '',
      isNew: false,
    });
    setFormError(null);
  };

  const handleProjectChange = (project: string) => {
    setEdit((prev) => prev ? { ...prev, project, skillRepo: '', skillBranch: '', interviewSkillPath: '', prdSkillPath: '', designDocSkillPath: '', designDocQaSkillPath: '', designDocAssistantSkillPath: '', interviewModel: '', prdModel: '', designDocModel: '', designDocQaModel: '', designDocAssistantModel: '' } : prev);
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
          interviewModel: edit.interviewModel || null,
          prdModel: edit.prdModel || null,
          designDocModel: edit.designDocModel || null,
          designDocQaModel: edit.designDocQaModel || null,
          designDocAssistantModel: edit.designDocAssistantModel || null,
        },
      });
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

  if (isLoading) return <div className={styles.loading}>Loading project settings…</div>;
  if (isError) return <div className={styles.error}>Failed to load project settings.</div>;

  // Prefer the full live ADO project list; fall back to the env-configured list, then the current edit value
  const projectOptions = skillProjects.length > 0
    ? skillProjects.map((p) => p.name)
    : availableProjects.length > 0
      ? availableProjects
      : (edit ? [edit.project] : []);

  const handleSaveGlobalModel = async () => {
    if (!globalModelInput.trim()) return;
    try {
      await setGlobalModel.mutateAsync(globalModelInput.trim());
      setGlobalModelSaved(true);
      setTimeout(() => setGlobalModelSaved(false), 2000);
    } catch {
      // error is surfaced via setGlobalModel.isError
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.pageHeader}>
          <div>
            <h1 className={styles.pageTitle}>Project Skill Settings</h1>
            <p className={styles.pageSubtitle}>Configure per-project skill repository and branch for AI agent sessions.</p>
          </div>
          {!edit && (
            <button className={styles.btnPrimary} onClick={handleAddNew} type="button">
              + Add Config
            </button>
          )}
        </div>

        <div className={styles.formCard}>
          <p className={styles.formTitle}>Global Default Model</p>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
            Used when a project skill has no per-skill model set. Falls back to <code>composer-2</code> if left blank.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <select
              className={styles.select}
              style={{ maxWidth: '24rem' }}
              value={globalModelInput}
              onChange={(e) => setGlobalModelInput(e.target.value)}
              disabled={setGlobalModel.isPending || isLoadingModels}
            >
              <option value="">{isLoadingModels ? 'Loading models…' : '— select a model —'}</option>
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>{m.displayName}</option>
              ))}
            </select>
            <button
              className={styles.btnPrimary}
              type="button"
              onClick={() => void handleSaveGlobalModel()}
              disabled={setGlobalModel.isPending || !globalModelInput.trim()}
            >
              {setGlobalModel.isPending ? 'Saving…' : globalModelSaved ? 'Saved!' : 'Save'}
            </button>
          </div>
          {setGlobalModel.isError && (
            <p className={styles.formError}>Failed to save global default model.</p>
          )}
        </div>

        {edit && (
          <div className={styles.formCard}>
            <p className={styles.formTitle}>{edit.isNew ? 'Add Project Skill Config' : `Edit: ${edit.project}`}</p>
            <div className={styles.formGrid}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="ps-project">Project</label>
                {edit.isNew ? (
                  <select
                    id="ps-project"
                    className={styles.select}
                    value={edit.project}
                    onChange={(e) => handleProjectChange(e.target.value)}
                    disabled={upsert.isPending || isLoadingProjects}
                  >
                    <option value="">{isLoadingProjects ? 'Loading projects…' : '— select a project —'}</option>
                    {projectOptions.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="ps-project"
                    className={styles.input}
                    value={edit.project}
                    disabled
                    readOnly
                  />
                )}
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

            <p className={styles.formTitle} style={{ marginTop: '1.25rem' }}>Process Skill Assignments</p>
            <div className={styles.formGrid}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="ps-interview-skill">Interview Skill</label>
                <select
                  id="ps-interview-skill"
                  className={styles.select}
                  value={edit.interviewSkillPath}
                  onChange={(e) => setEdit((prev) => prev ? { ...prev, interviewSkillPath: e.target.value } : prev)}
                  disabled={upsert.isPending || isLoadingSkills || !edit.skillRepo}
                >
                  <option value="">None (use default)</option>
                  {skillList.map((s) => (
                    <option key={s.id} value={s.path}>{s.name}</option>
                  ))}
                </select>
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="ps-prd-skill">PRD Skill</label>
                <select
                  id="ps-prd-skill"
                  className={styles.select}
                  value={edit.prdSkillPath}
                  onChange={(e) => setEdit((prev) => prev ? { ...prev, prdSkillPath: e.target.value } : prev)}
                  disabled={upsert.isPending || isLoadingSkills || !edit.skillRepo}
                >
                  <option value="">None (use default)</option>
                  {skillList.map((s) => (
                    <option key={s.id} value={s.path}>{s.name}</option>
                  ))}
                </select>
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="ps-design-doc-skill">Design Doc Skill</label>
                <select
                  id="ps-design-doc-skill"
                  className={styles.select}
                  value={edit.designDocSkillPath}
                  onChange={(e) => setEdit((prev) => prev ? { ...prev, designDocSkillPath: e.target.value } : prev)}
                  disabled={upsert.isPending || isLoadingSkills || !edit.skillRepo}
                >
                  <option value="">None (use default)</option>
                  {skillList.map((s) => (
                    <option key={s.id} value={s.path}>{s.name}</option>
                  ))}
                </select>
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="ps-design-doc-qa-skill">Design Doc Q&amp;A Skill</label>
                <select
                  id="ps-design-doc-qa-skill"
                  className={styles.select}
                  value={edit.designDocQaSkillPath}
                  onChange={(e) => setEdit((prev) => prev ? { ...prev, designDocQaSkillPath: e.target.value } : prev)}
                  disabled={upsert.isPending || isLoadingSkills || !edit.skillRepo}
                >
                  <option value="">None (skip Q&amp;A phase)</option>
                  {skillList.map((s) => (
                    <option key={s.id} value={s.path}>{s.name}</option>
                  ))}
                </select>
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="ps-design-doc-assistant-skill">Design Doc Assistant Skill</label>
                <select
                  id="ps-design-doc-assistant-skill"
                  className={styles.select}
                  value={edit.designDocAssistantSkillPath}
                  onChange={(e) => setEdit((prev) => prev ? { ...prev, designDocAssistantSkillPath: e.target.value } : prev)}
                  disabled={upsert.isPending || isLoadingSkills || !edit.skillRepo}
                >
                  <option value="">None (use default model, no skill)</option>
                  {skillList.map((s) => (
                    <option key={s.id} value={s.path}>{s.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <p className={styles.formTitle} style={{ marginTop: '1.25rem' }}>Model Config</p>
            <div className={styles.formGrid}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="ps-interview-model">Interview Model</label>
                <select
                  id="ps-interview-model"
                  className={styles.select}
                  value={edit.interviewModel}
                  onChange={(e) => setEdit((prev) => prev ? { ...prev, interviewModel: e.target.value } : prev)}
                  disabled={upsert.isPending || isLoadingModels}
                >
                  <option value="">Use global default</option>
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.displayName}</option>
                  ))}
                </select>
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="ps-prd-model">PRD Model</label>
                <select
                  id="ps-prd-model"
                  className={styles.select}
                  value={edit.prdModel}
                  onChange={(e) => setEdit((prev) => prev ? { ...prev, prdModel: e.target.value } : prev)}
                  disabled={upsert.isPending || isLoadingModels}
                >
                  <option value="">Use global default</option>
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.displayName}</option>
                  ))}
                </select>
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="ps-design-doc-model">Design Doc Model</label>
                <select
                  id="ps-design-doc-model"
                  className={styles.select}
                  value={edit.designDocModel}
                  onChange={(e) => setEdit((prev) => prev ? { ...prev, designDocModel: e.target.value } : prev)}
                  disabled={upsert.isPending || isLoadingModels}
                >
                  <option value="">Use global default</option>
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.displayName}</option>
                  ))}
                </select>
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="ps-design-doc-qa-model">Design Doc Q&amp;A Model</label>
                <select
                  id="ps-design-doc-qa-model"
                  className={styles.select}
                  value={edit.designDocQaModel}
                  onChange={(e) => setEdit((prev) => prev ? { ...prev, designDocQaModel: e.target.value } : prev)}
                  disabled={upsert.isPending || isLoadingModels}
                >
                  <option value="">Use global default</option>
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.displayName}</option>
                  ))}
                </select>
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="ps-design-doc-assistant-model">Design Doc Assistant Model</label>
                <select
                  id="ps-design-doc-assistant-model"
                  className={styles.select}
                  value={edit.designDocAssistantModel}
                  onChange={(e) => setEdit((prev) => prev ? { ...prev, designDocAssistantModel: e.target.value } : prev)}
                  disabled={upsert.isPending || isLoadingModels}
                >
                  <option value="">Use global default</option>
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.displayName}</option>
                  ))}
                </select>
              </div>
            </div>
            {formError && <p className={styles.formError}>{formError}</p>}
            <div className={styles.formActions}>
              <button className={styles.btnCancel} onClick={handleCancel} type="button" disabled={upsert.isPending}>
                Cancel
              </button>
              <button className={styles.btnPrimary} onClick={() => void handleSave()} type="button" disabled={upsert.isPending}>
                {upsert.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}

        {configs.length === 0 && !edit ? (
          <div className={styles.empty}>
            <p>No project skill settings configured yet. Click <strong>+ Add Config</strong> to get started.</p>
          </div>
        ) : (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>Project</th>
                  <th className={styles.th}>Skill Repo</th>
                  <th className={styles.th}>Skill Branch</th>
                  <th className={styles.th}>Interview Model</th>
                  <th className={styles.th}>PRD Model</th>
                  <th className={styles.th}>Design Doc Model</th>
                  <th className={styles.th}>Last Updated By</th>
                  <th className={styles.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {configs.map((config) => (
                  <tr key={config.project} className={styles.tr}>
                    <td className={styles.td}>{config.project}</td>
                    <td className={styles.td}>
                      <span className={styles.repoText}>{config.skillRepo}</span>
                    </td>
                    <td className={styles.td}>
                      <span className={styles.branchText}>{config.skillBranch}</span>
                    </td>
                    <td className={styles.td}>
                      <span className={styles.metaText}>{config.interviewModel ?? '—'}</span>
                    </td>
                    <td className={styles.td}>
                      <span className={styles.metaText}>{config.prdModel ?? '—'}</span>
                    </td>
                    <td className={styles.td}>
                      <span className={styles.metaText}>{config.designDocModel ?? '—'}</span>
                    </td>
                    <td className={styles.td}>
                      <span className={styles.metaText}>{config.updatedBy ?? '—'}</span>
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
        )}
      </div>
    </div>
  );
};
