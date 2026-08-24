import React, { useState, useRef, useEffect, useId } from 'react';
import {
  useFoundationSkillReleases,
  useFoundationSkillCandidates,
  useFoundationSkillRepoStatuses,
  useFoundationSkillReleaseAudit,
  useCreateFoundationSkillRelease,
  usePublishFoundationSkillRelease,
  useDeprecateFoundationSkillRelease,
  useDeleteDraftFoundationSkillRelease,
  useUpdateFoundationSkillRelease,
  useUpdateRepoWithFoundationSkills,
  useCheckFoundationSkillCompatibility,
  useFoundationSkillMatrix,
  useFoundationSkillTeams,
  useScanAllFoundationSkillRepos,
  useFoundationSkillRollbackTargets,
  useRollbackFoundationSkillRepo,
  useShippableFoundationSkills,
  FoundationSkillReleaseValidationClientError,
  type UpdateReleasePayload,
} from '../hooks/useFoundationSkillAdmin';
import { useProjects } from '../hooks/useProjects';
import type {
  FoundationSkillRelease,
  FoundationSkillRepoStatus,
  FoundationSkillCatalogEntry,
  FoundationSkillTeamRepo,
  FoundationSkillReleaseValidationIssue,
} from '../../shared/types/foundationSkills';
import {
  alwaysInstallSkillsFromCatalog,
  isAlwaysInstallCatalogSkill,
} from '../../shared/types/foundationSkills';
import {
  collectFoundationSkillValidationIssues,
  resolveFoundationSkillSelection,
} from '../../shared/foundationSkillDependencies';
import {
  resolveProjectAssignment,
  seedProjectPicksFromRelease,
} from '../../shared/foundationSkillProjectAssignment';
import {
  AGENT_SKILL_ROOT,
  LEGACY_CURSOR_SKILL_ROOT,
} from '../../shared/skillPaths';
import styles from './FoundationSkillsAdmin.module.css';

// ── Helpers ───────────────────────────────────────────────────────────────────

function lockedAlwaysInstallSkills(
  catalog: FoundationSkillCatalogEntry[]
): string[] {
  return alwaysInstallSkillsFromCatalog(catalog);
}

function withoutRemovableSkills(
  catalog: FoundationSkillCatalogEntry[],
  selected: string[],
  name: string
): string[] {
  if (selected.includes(name)) {
    if (
      isAlwaysInstallCatalogSkill({
        name,
        alwaysInstall: catalog.find((s) => s.name === name)?.alwaysInstall,
      })
    ) {
      return selected;
    }
    return selected.filter((s) => s !== name);
  }
  return [...selected, name];
}

function formatTs(ts: string | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

/** Human labels for audit action codes stored lowercase in the DB. */
function formatAuditAction(action: string): string {
  const labels: Record<string, string> = {
    created: 'Created',
    validated: 'Validated',
    validation_failed: 'Validation failed',
    published: 'Published',
    deprecated: 'Deprecated',
    rollback: 'Rollback',
  };
  return (
    labels[action] ??
    action.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function statusBadgeClass(status: string): string {
  if (status === 'published') return styles.badgePublished;
  if (status === 'deprecated') return styles.badgeDeprecated;
  return styles.badgeDraft;
}

function compatBadgeClass(status: string): string {
  if (status === 'compatible') return styles.badgePublished;
  if (status === 'incompatible') return styles.badgeDeprecated;
  return styles.badgeDraft;
}

// ── In-app confirm modal (replaces window.confirm) ────────────────────────────

interface ConfirmActionModalProps {
  title: string;
  body: React.ReactNode;
  hint?: string;
  confirmLabel: string;
  pendingLabel?: string;
  tone?: 'danger' | 'warning';
  isPending?: boolean;
  /** When set, shows an optional reason textarea passed to onConfirm. */
  reasonLabel?: string;
  reasonPlaceholder?: string;
  onConfirm: (reason?: string) => void;
  onCancel: () => void;
}

const ConfirmActionModal: React.FC<ConfirmActionModalProps> = ({
  title,
  body,
  hint,
  confirmLabel,
  pendingLabel,
  tone = 'warning',
  isPending = false,
  reasonLabel,
  reasonPlaceholder,
  onConfirm,
  onCancel,
}) => {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isPending) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, isPending]);

  return (
    <div
      className={styles.confirmOverlay}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isPending) onCancel();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="fs-confirm-title"
      {...{ 'data-testid': 'fs-confirm-modal' }}
    >
      <div className={styles.confirmCard}>
        <div
          className={`${styles.confirmIcon} ${tone === 'danger' ? styles.confirmIconDanger : styles.confirmIconWarning}`}
          aria-hidden="true"
        >
          {tone === 'danger' ? (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          )}
        </div>

        <h2 className={styles.confirmTitle} id="fs-confirm-title">
          {title}
        </h2>
        <div className={styles.confirmBody}>{body}</div>
        {hint && <p className={styles.confirmHint}>{hint}</p>}

        {reasonLabel && (
          <div>
            <label
              className={styles.confirmReasonLabel}
              htmlFor="fs-confirm-reason"
            >
              {reasonLabel}
            </label>
            <textarea
              id="fs-confirm-reason"
              className={`${styles.input} ${styles.confirmReason}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={reasonPlaceholder}
              disabled={isPending}
              {...{ 'data-testid': 'fs-confirm-reason' }}
            />
          </div>
        )}

        <div className={styles.confirmActions}>
          <button
            ref={cancelRef}
            type="button"
            className={styles.btnGhost}
            onClick={onCancel}
            disabled={isPending}
            {...{ 'data-testid': 'fs-confirm-cancel' }}
          >
            Cancel
          </button>
          <button
            type="button"
            className={
              tone === 'danger'
                ? styles.confirmBtnDanger
                : styles.confirmBtnAccent
            }
            onClick={() => onConfirm(reason.trim() || undefined)}
            disabled={isPending}
            {...{ 'data-testid': 'fs-confirm-submit' }}
          >
            {isPending ? (pendingLabel ?? `${confirmLabel}…`) : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

const FRESH_INSTALL_SKILL_ROOTS = [
  { value: AGENT_SKILL_ROOT, label: `${AGENT_SKILL_ROOT} (recommended)` },
  {
    value: LEGACY_CURSOR_SKILL_ROOT,
    label: `${LEGACY_CURSOR_SKILL_ROOT} (legacy Cursor)`,
  },
] as const;

interface OpenUpdatePrModalProps {
  repo: FoundationSkillRepoStatus;
  isPending: boolean;
  onConfirm: (skillRoot: string) => void;
  onCancel: () => void;
}

const OpenUpdatePrModal: React.FC<OpenUpdatePrModalProps> = ({
  repo,
  isPending,
  onConfirm,
  onCancel,
}) => {
  const [skillRoot, setSkillRoot] = useState<string>(AGENT_SKILL_ROOT);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isPending) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, isPending]);

  return (
    <div
      className={styles.confirmOverlay}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isPending) onCancel();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="fs-update-pr-title"
      {...{ 'data-testid': 'fs-update-pr-modal' }}
    >
      <div className={styles.confirmCard}>
        <h2 className={styles.confirmTitle} id="fs-update-pr-title">
          Install into {repo.repo}?
        </h2>
        <div className={styles.confirmBody}>
          This repo has no <code>apex-skills.lock.json</code> yet. Choose the
          canonical skill root for the first install. Later updates keep that
          root; use <code>migrate-root</code> to move it.
        </div>
        <div>
          <label
            className={styles.confirmReasonLabel}
            htmlFor="fs-update-skill-root"
          >
            Canonical skill root
          </label>
          <select
            id="fs-update-skill-root"
            className={styles.select}
            value={skillRoot}
            onChange={(e) => setSkillRoot(e.target.value)}
            disabled={isPending}
            {...{ 'data-testid': 'fs-update-skill-root' }}
          >
            {FRESH_INSTALL_SKILL_ROOTS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.confirmActions}>
          <button
            ref={cancelRef}
            type="button"
            className={styles.btnGhost}
            onClick={onCancel}
            disabled={isPending}
            {...{ 'data-testid': 'fs-update-pr-cancel' }}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.confirmBtnAccent}
            onClick={() => onConfirm(skillRoot)}
            disabled={isPending}
            {...{ 'data-testid': 'fs-update-pr-submit' }}
          >
            {isPending ? 'Opening…' : 'Open PR'}
          </button>
        </div>
      </div>
    </div>
  );
};

/** "MaxView", "MaxView, Amego", or "3 projects" for compact display. */
function summarizeProjects(projects: string[]): string {
  if (projects.length === 0) return 'All projects';
  if (projects.length <= 2) return projects.join(', ');
  return `${projects.length} projects`;
}

function formatDependencyLabel(skills: string[]): string {
  if (skills.length === 1) return skills[0];
  return skills.join(', ');
}

// ── ProjectPicker — reusable multi-select ────────────────────────────────────

/** Viewport-fit bounds for the project dropdown, in px. */
const DROPDOWN_MAX_H = 300;
const DROPDOWN_MIN_H = 160;
const DROPDOWN_GAP = 12;

const ProjectPicker: React.FC<{
  selected: string[];
  onChange: (projects: string[]) => void;
  placeholder?: string;
}> = ({ selected, onChange, placeholder = 'Select projects…' }) => {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{
    up: boolean;
    maxHeight: number;
  }>({
    up: false,
    maxHeight: DROPDOWN_MAX_H,
  });
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const { data: allProjects = [], isLoading } = useProjects();

  const term = search.trim().toLowerCase();
  const allNames = allProjects.map((p) => p.name);
  const filtered = term
    ? allNames.filter((n) => n.toLowerCase().includes(term))
    : allNames;

  // Dismiss the list on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
        setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  // The list is absolutely positioned, so it adds no page height — if it ran past
  // the viewport its own scrollbar would be unreachable. Fit it to the space that
  // actually exists, flipping above the field when there is more room up there.
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - DROPDOWN_GAP;
      const above = rect.top - DROPDOWN_GAP;
      const up = below < DROPDOWN_MIN_H && above > below;
      const space = up ? above : below;
      setPlacement({
        up,
        maxHeight: Math.max(DROPDOWN_MIN_H, Math.min(DROPDOWN_MAX_H, space)),
      });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open]);

  const toggle = (name: string) =>
    onChange(
      selected.includes(name)
        ? selected.filter((p) => p !== name)
        : [...selected, name]
    );

  return (
    <div className={styles.pickerWrap} ref={wrapRef}>
      {selected.length > 0 && (
        <div className={styles.chipRow}>
          {selected.map((p) => (
            <span key={p} className={styles.chip}>
              {p}
              <button
                type="button"
                className={styles.chipRemove}
                onClick={() => onChange(selected.filter((x) => x !== p))}
                aria-label={`Remove ${p}`}
                {...{ 'data-testid': `fs-project-chip-remove-${p}` }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        className={`${styles.input} ${styles.pickerInput}`}
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        aria-label="Projects"
        {...{ 'data-testid': 'fs-project-picker-input' }}
      />

      {open && (
        <ul
          id={listId}
          className={`${styles.dropdown} ${placement.up ? styles.dropdownUp : ''}`}
          style={{ maxHeight: placement.maxHeight }}
        >
          {isLoading ? (
            <li>
              <p className={styles.dropdownEmpty}>Loading projects…</p>
            </li>
          ) : allNames.length === 0 ? (
            <li>
              <p className={styles.dropdownEmpty}>No projects found.</p>
            </li>
          ) : filtered.length === 0 ? (
            <li>
              <p className={styles.dropdownEmpty}>
                No projects match “{search}”.
              </p>
            </li>
          ) : (
            <>
              {filtered.map((name) => {
                const isSelected = selected.includes(name);
                return (
                  <li key={name}>
                    <button
                      type="button"
                      className={`${styles.dropdownItem} ${isSelected ? styles.dropdownItemSelected : ''}`}
                      aria-pressed={isSelected}
                      onClick={() => toggle(name)}
                      {...{ 'data-testid': `fs-project-picker-option-${name}` }}
                    >
                      <span className={styles.dropdownCheck} aria-hidden="true">
                        ✓
                      </span>
                      {name}
                    </button>
                  </li>
                );
              })}
              <li className={styles.dropdownMeta}>
                {selected.length} of {allNames.length} selected
              </li>
            </>
          )}
        </ul>
      )}
    </div>
  );
};

// ── AudienceField — segmented mode switch + project picker ───────────────────

const AudienceField: React.FC<{
  mode: 'all' | 'specific';
  projects: string[];
  onModeChange: (mode: 'all' | 'specific') => void;
  onProjectsChange: (projects: string[]) => void;
  idPrefix: string;
}> = ({ mode, projects, onModeChange, onProjectsChange, idPrefix }) => (
  <>
    <div className={styles.formRow}>
      <span className={styles.label} id={`${idPrefix}-audience-label`}>
        Default audience
      </span>
      <p className={styles.fieldHint}>
        Controls which Apex projects can see and install this release. Under
        Specific projects, the next step assigns skills per project.
      </p>
      <div
        className={styles.segmented}
        role="radiogroup"
        aria-labelledby={`${idPrefix}-audience-label`}
      >
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'all'}
          className={`${styles.segmentedBtn} ${mode === 'all' ? styles.segmentedBtnActive : ''}`}
          onClick={() => onModeChange('all')}
          {...{ 'data-testid': `fs-audience-all-${idPrefix}` }}
        >
          All projects
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'specific'}
          className={`${styles.segmentedBtn} ${mode === 'specific' ? styles.segmentedBtnActive : ''}`}
          onClick={() => onModeChange('specific')}
          {...{ 'data-testid': `fs-audience-specific-${idPrefix}` }}
        >
          Specific projects
        </button>
      </div>
    </div>
    {mode === 'specific' && (
      <div className={styles.formRow}>
        <span className={styles.label}>Projects</span>
        <ProjectPicker
          selected={projects}
          onChange={onProjectsChange}
          {...{ 'data-testid': `fs-audience-project-picker-${idPrefix}` }}
        />
      </div>
    )}
  </>
);

// ── Skill checklist rows (shared by All-projects picker + per-project cards) ──

interface ReviewValidationIssue {
  key: string;
  message: string;
  remediation: string;
}

const SkillChecklistRows: React.FC<{
  catalog: FoundationSkillCatalogEntry[];
  isCatalogLoading?: boolean;
  search: string;
  explicitSelectedSkills: string[];
  effectiveSelectedSkills: string[];
  requiredBy: Record<string, string[]>;
  onSkillToggle: (name: string) => void;
  idPrefix: string;
  testIdPrefix: string;
}> = ({
  catalog,
  isCatalogLoading = false,
  search,
  explicitSelectedSkills,
  effectiveSelectedSkills,
  requiredBy,
  onSkillToggle,
  idPrefix,
  testIdPrefix,
}) => {
  const term = search.trim().toLowerCase();
  const visible = term
    ? catalog.filter(
        (s) =>
          s.name.toLowerCase().includes(term) ||
          s.summary.toLowerCase().includes(term)
      )
    : catalog;

  if (isCatalogLoading) {
    return (
      <p className={`${styles.muted} ${styles.skillEmpty}`}>
        Loading skill catalog…
      </p>
    );
  }
  if (catalog.length === 0) {
    return (
      <p className={`${styles.muted} ${styles.skillEmpty}`}>
        No releasable skills found in the catalog.
      </p>
    );
  }
  if (visible.length === 0) {
    return (
      <p className={`${styles.muted} ${styles.skillEmpty}`}>
        No skills match “{search}”.
      </p>
    );
  }

  return (
    <>
      {visible.map((skill) => {
        const checked = effectiveSelectedSkills.includes(skill.name);
        const isExplicit = explicitSelectedSkills.includes(skill.name);
        const requiredBySkills = requiredBy[skill.name] ?? [];
        const isAlwaysRequired = isAlwaysInstallCatalogSkill(skill);
        const isAutoRequired =
          checked &&
          !isExplicit &&
          requiredBySkills.length > 0 &&
          !isAlwaysRequired;
        const requiredById = isAutoRequired
          ? `${idPrefix}-required-by-${skill.name}`
          : isAlwaysRequired
            ? `${idPrefix}-always-${skill.name}`
            : undefined;
        const inputId = `${idPrefix}-${skill.name}`;

        return (
          <div
            key={skill.name}
            className={[
              styles.skillRow,
              checked ? styles.skillRowChecked : '',
              isAlwaysRequired || isAutoRequired ? styles.skillRowLocked : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <div className={styles.skillRowMain}>
              <input
                type="checkbox"
                className={styles.checkbox}
                id={inputId}
                checked={checked}
                onChange={() => onSkillToggle(skill.name)}
                disabled={isAutoRequired || isAlwaysRequired}
                aria-describedby={requiredById}
                {...{ 'data-testid': `${testIdPrefix}-${skill.name}` }}
              />
              <label htmlFor={inputId} className={styles.skillRowText}>
                <span className={styles.skillName}>
                  {skill.name}
                  {isAlwaysRequired && (
                    <span
                      className={styles.skillDependencyTag}
                      id={requiredById}
                    >
                      Always included
                    </span>
                  )}
                  {isAutoRequired && (
                    <span
                      className={styles.skillDependencyTag}
                      id={requiredById}
                    >
                      Required by {formatDependencyLabel(requiredBySkills)}
                    </span>
                  )}
                </span>
                <span className={styles.skillSummary}>{skill.summary}</span>
              </label>
            </div>
          </div>
        );
      })}
    </>
  );
};

// ── SkillPicker — plain checklist for All-projects audience ──────────────────

const SkillPicker: React.FC<{
  catalog: FoundationSkillCatalogEntry[];
  isCatalogLoading?: boolean;
  explicitSelectedSkills: string[];
  effectiveSelectedSkills: string[];
  requiredBy: Record<string, string[]>;
  onSkillToggle: (name: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
}> = ({
  catalog,
  isCatalogLoading = false,
  explicitSelectedSkills,
  effectiveSelectedSkills,
  requiredBy,
  onSkillToggle,
  onSelectAll,
  onClearAll,
}) => {
  const [search, setSearch] = useState('');

  return (
    <div className={styles.skillPickerBox}>
      <div className={styles.skillPickerHeader}>
        <span className={styles.skillPickerCount}>
          {effectiveSelectedSkills.length} of {catalog.length} selected
        </span>
        <input
          className={styles.skillSearch}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter skills…"
          aria-label="Filter skills"
          {...{ 'data-testid': 'fs-skill-search' }}
        />
        <div className={`${styles.btnRow} ${styles.pushRight}`}>
          <button
            type="button"
            className={`${styles.btnGhost} ${styles.btnSm}`}
            onClick={onSelectAll}
            {...{ 'data-testid': 'fs-skill-select-all' }}
          >
            Select all
          </button>
          <button
            type="button"
            className={`${styles.btnGhost} ${styles.btnSm}`}
            onClick={onClearAll}
            {...{ 'data-testid': 'fs-skill-clear-all' }}
          >
            Clear
          </button>
        </div>
      </div>

      <div className={styles.skillList}>
        <SkillChecklistRows
          catalog={catalog}
          isCatalogLoading={isCatalogLoading}
          search={search}
          explicitSelectedSkills={explicitSelectedSkills}
          effectiveSelectedSkills={effectiveSelectedSkills}
          requiredBy={requiredBy}
          onSkillToggle={onSkillToggle}
          idPrefix="skill"
          testIdPrefix="fs-skill-checkbox"
        />
      </div>
    </div>
  );
};

// ── ProjectSkillAssignment — per-project accordion checklists ────────────────

const ProjectSkillCard: React.FC<{
  project: string;
  catalog: FoundationSkillCatalogEntry[];
  isCatalogLoading?: boolean;
  explicit: string[];
  effective: string[];
  requiredBy: Record<string, string[]>;
  otherProjects: string[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onPicksChange: (picks: string[]) => void;
  onCopyFrom: (sourceProject: string) => void;
}> = ({
  project,
  catalog,
  isCatalogLoading = false,
  explicit,
  effective,
  requiredBy,
  otherProjects,
  expanded,
  onToggleExpanded,
  onPicksChange,
  onCopyFrom,
}) => {
  const [search, setSearch] = useState('');
  const safeId = project.replace(/[^a-zA-Z0-9_-]/g, '_');

  return (
    <div
      className={`${styles.projectSkillCard} ${expanded ? styles.projectSkillCardOpen : ''}`}
      {...{ 'data-testid': `fs-project-skill-card-${project}` }}
    >
      <button
        type="button"
        className={styles.projectSkillCardHeader}
        aria-expanded={expanded}
        onClick={onToggleExpanded}
        {...{ 'data-testid': `fs-project-skill-toggle-${project}` }}
      >
        <span className={styles.projectSkillCardChevron} aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <span className={styles.projectSkillCardTitle}>{project}</span>
        <span className={styles.projectSkillCardCount}>
          {effective.length} of {catalog.length} selected
        </span>
      </button>

      {expanded && (
        <div className={styles.projectSkillCardBody}>
          <div className={styles.projectSkillCardToolbar}>
            <input
              className={styles.skillSearch}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter skills…"
              aria-label={`Filter skills for ${project}`}
              {...{ 'data-testid': `fs-project-skill-search-${project}` }}
            />
            <div className={`${styles.btnRow} ${styles.pushRight}`}>
              {otherProjects.length > 0 && (
                <label className={styles.copyFromLabel}>
                  <span className={styles.srOnly}>Copy skills from</span>
                  <select
                    className={styles.copyFromSelect}
                    value=""
                    onChange={(e) => {
                      if (e.target.value) onCopyFrom(e.target.value);
                      e.target.value = '';
                    }}
                    aria-label={`Copy skills into ${project} from another project`}
                    {...{
                      'data-testid': `fs-project-skill-copy-from-${project}`,
                    }}
                  >
                    <option value="">Copy from…</option>
                    {otherProjects.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                type="button"
                className={`${styles.btnGhost} ${styles.btnSm}`}
                onClick={() => onPicksChange(catalog.map((s) => s.name))}
                {...{ 'data-testid': `fs-project-skill-select-all-${project}` }}
              >
                Select all
              </button>
              <button
                type="button"
                className={`${styles.btnGhost} ${styles.btnSm}`}
                onClick={() =>
                  onPicksChange(lockedAlwaysInstallSkills(catalog))
                }
                {...{ 'data-testid': `fs-project-skill-clear-${project}` }}
              >
                Clear
              </button>
            </div>
          </div>

          <div className={`${styles.skillList} ${styles.projectSkillList}`}>
            <SkillChecklistRows
              catalog={catalog}
              isCatalogLoading={isCatalogLoading}
              search={search}
              explicitSelectedSkills={explicit}
              effectiveSelectedSkills={effective}
              requiredBy={requiredBy}
              onSkillToggle={(name) =>
                onPicksChange(withoutRemovableSkills(catalog, explicit, name))
              }
              idPrefix={`skill-${safeId}`}
              testIdPrefix={`fs-project-skill-checkbox-${project}`}
            />
          </div>
        </div>
      )}
    </div>
  );
};

const ProjectSkillAssignment: React.FC<{
  catalog: FoundationSkillCatalogEntry[];
  isCatalogLoading?: boolean;
  projects: string[];
  projectSkillPicks: Record<string, string[]>;
  onProjectPicksChange: (project: string, picks: string[]) => void;
  onCopyProjectPicks: (from: string, to: string) => void;
}> = ({
  catalog,
  isCatalogLoading = false,
  projects,
  projectSkillPicks,
  onProjectPicksChange,
  onCopyProjectPicks,
}) => {
  const [expandedProject, setExpandedProject] = useState<string | null>(
    () => projects[0] ?? null
  );

  useEffect(() => {
    if (projects.length === 0) {
      setExpandedProject(null);
      return;
    }
    setExpandedProject((prev) =>
      prev && projects.includes(prev) ? prev : projects[0]
    );
  }, [projects]);

  const assignment = resolveProjectAssignment(
    catalog,
    projects,
    projectSkillPicks
  );

  if (projects.length === 0) {
    return (
      <p
        className={`${styles.muted} ${styles.skillEmpty}`}
        {...{ 'data-testid': 'fs-project-skill-empty' }}
      >
        Select at least one project in the Audience step, then assign skills
        here.
      </p>
    );
  }

  return (
    <div
      className={styles.projectSkillAssignment}
      {...{ 'data-testid': 'fs-project-skill-assignment' }}
    >
      <p className={styles.fieldHint}>
        Choose which skills each project can install. Required dependencies are
        added automatically for that project.
      </p>
      {projects.map((project) => {
        const per = assignment.perProject[project] ?? {
          explicit: projectSkillPicks[project] ?? [],
          effective: [],
          requiredBy: {},
        };
        return (
          // data-testid-exempt — ProjectSkillCard root already emits fs-project-skill-card-${project}
          <ProjectSkillCard
            key={project}
            project={project}
            catalog={catalog}
            isCatalogLoading={isCatalogLoading}
            explicit={per.explicit}
            effective={per.effective}
            requiredBy={per.requiredBy}
            otherProjects={projects.filter((p) => p !== project)}
            expanded={expandedProject === project}
            onToggleExpanded={() =>
              setExpandedProject((current) =>
                current === project ? null : project
              )
            }
            onPicksChange={(picks) => onProjectPicksChange(project, picks)}
            onCopyFrom={(source) => onCopyProjectPicks(source, project)}
          />
        );
      })}
    </div>
  );
};

// ── CreateReleaseWizard ───────────────────────────────────────────────────────

type WizardStep = 'details' | 'audience' | 'skills' | 'review';

const WIZARD_STEPS: Array<{
  id: WizardStep;
  label: string;
  title: string;
  hint: string;
}> = [
  {
    id: 'details',
    label: 'Details',
    title: 'Release details',
    hint: 'Name this release and describe what changed. Teams see these notes in their update banner before they install.',
  },
  {
    id: 'audience',
    label: 'Audience',
    title: 'Default audience',
    hint: 'Choose which Apex projects this release is offered to. Under Specific projects, the next step assigns skills per project.',
  },
  {
    id: 'skills',
    label: 'Skills',
    title: 'Select skills',
    hint: 'Pick the foundation skills bundled in this release. Required dependencies are selected automatically.',
  },
  {
    id: 'review',
    label: 'Review',
    title: 'Review and create',
    hint: 'Confirm everything below. The release is created as a draft — nothing reaches teams until you publish it.',
  },
];

const SKILLS_STEP_SPECIFIC = {
  title: 'Assign skills to projects',
  hint: 'For each project, choose which skills it can install. Required dependencies are added automatically for that project.',
};

const CreateReleaseWizard: React.FC<{ onCreated: () => void }> = ({
  onCreated,
}) => {
  const [step, setStep] = useState<WizardStep>('details');
  const [version, setVersion] = useState('');
  const [artifactVersion, setArtifact] = useState('');
  const [releaseNotes, setNotes] = useState('');
  const [breakingChanges, setBreaking] = useState('');
  const [audienceMode, setAudienceMode] = useState<'all' | 'specific'>('all');
  const [selectedProjects, setSelected] = useState<string[]>([]);
  const [explicitSelectedSkills, setExplicitSelectedSkills] = useState<
    string[]
  >([]);
  const [projectSkillPicks, setProjectSkillPicks] = useState<
    Record<string, string[]>
  >({});
  const [error, setError] = useState<string | null>(null);

  const seededRef = useRef(false);
  const versionSeededRef = useRef(false);

  const { skills: catalog, isLoading: catalogLoading } =
    useShippableFoundationSkills();
  const { data: candidates = [], isLoading: candidatesLoading } =
    useFoundationSkillCandidates();
  const create = useCreateFoundationSkillRelease();

  // A new release includes everything by default; seed once the catalog arrives.
  useEffect(() => {
    if (seededRef.current || catalog.length === 0) return;
    seededRef.current = true;
    setExplicitSelectedSkills(catalog.map((s) => s.name));
  }, [catalog]);

  // Keep per-project pick maps aligned with the selected project list.
  // Wait for the catalog so a late-loading catalog does not leave empty defaults.
  useEffect(() => {
    if (audienceMode !== 'specific' || catalog.length === 0) return;
    const allNames = catalog.map((s) => s.name);
    setProjectSkillPicks((prev) => {
      const next: Record<string, string[]> = {};
      let changed = Object.keys(prev).some(
        (key) => !selectedProjects.includes(key)
      );
      for (const project of selectedProjects) {
        if (project in prev) {
          next[project] = prev[project];
        } else {
          next[project] = allNames;
          changed = true;
        }
      }
      return changed || Object.keys(next).length !== Object.keys(prev).length
        ? next
        : prev;
    });
  }, [audienceMode, selectedProjects, catalog]);

  // Prefill suite + artifact from the newest Azure Artifacts candidate so Publish
  // cannot target a version that was never published to the feed.
  useEffect(() => {
    if (
      versionSeededRef.current ||
      candidatesLoading ||
      candidates.length === 0
    )
      return;
    versionSeededRef.current = true;
    const latestCandidate = candidates[0].version;
    setVersion(latestCandidate);
    setArtifact(latestCandidate);
  }, [candidates, candidatesLoading]);

  const applyCandidateVersion = (next: string) => {
    setArtifact(next);
    // Keep suite in lockstep when the admin hasn't customized it away from the artifact.
    setVersion((current) =>
      !current.trim() || current.trim() === artifactVersion.trim()
        ? next
        : current
    );
  };

  const stepIndex = WIZARD_STEPS.findIndex((s) => s.id === step);
  const currentMeta =
    step === 'skills' && audienceMode === 'specific'
      ? { ...WIZARD_STEPS[stepIndex], ...SKILLS_STEP_SPECIFIC }
      : WIZARD_STEPS[stepIndex];
  const isLastStep = step === 'review';

  const releaseAudienceLabel =
    audienceMode === 'all'
      ? 'All projects'
      : selectedProjects.length > 0
        ? summarizeProjects(selectedProjects)
        : 'none selected';

  const allModeSelection = resolveFoundationSkillSelection(
    catalog,
    explicitSelectedSkills
  );
  const projectAssignment = resolveProjectAssignment(
    catalog,
    selectedProjects,
    projectSkillPicks
  );
  const selectionState =
    audienceMode === 'specific'
      ? {
          explicitSelectedSkills: [
            ...new Set(
              selectedProjects.flatMap((p) => projectSkillPicks[p] ?? [])
            ),
          ],
          effectiveSelectedSkills: projectAssignment.effectiveSelectedSkills,
          dependencyOrder: projectAssignment.dependencyOrder,
          requiredBy: {},
        }
      : allModeSelection;
  const selectedSkillTargets =
    audienceMode === 'specific' ? projectAssignment.skillTargets : {};
  const reviewIssues: ReviewValidationIssue[] =
    collectFoundationSkillValidationIssues({
      skills: catalog,
      selectedSkills: selectionState.effectiveSelectedSkills,
      targetProjects: audienceMode === 'specific' ? selectedProjects : [],
      skillTargets: selectedSkillTargets,
    }).map((issue) => ({
      key: `${issue.type}-${issue.dependentSkill}-${issue.dependency}`,
      message: issue.message,
      remediation: issue.remediation,
    }));

  const overrideCount = Object.keys(selectedSkillTargets).length;

  /** Returns an error message when the given step is incomplete, else null. */
  const validateStep = (target: WizardStep): string | null => {
    if (target === 'details' && !version.trim()) {
      return 'Suite version is required.';
    }
    if (
      target === 'audience' &&
      audienceMode === 'specific' &&
      selectedProjects.length === 0
    ) {
      return 'Select at least one project or switch to "All projects".';
    }
    if (
      target === 'skills' &&
      selectionState.effectiveSelectedSkills.length === 0
    ) {
      return 'Select at least one skill to include in this release.';
    }
    if (target === 'review' && reviewIssues.length > 0) {
      return 'Resolve dependency coverage issues before creating the draft.';
    }
    return null;
  };

  /** First blocking error across every step up to (not including) target. */
  const firstErrorBefore = (target: WizardStep): string | null => {
    const targetIdx = WIZARD_STEPS.findIndex((s) => s.id === target);
    for (let i = 0; i < targetIdx; i++) {
      const err = validateStep(WIZARD_STEPS[i].id);
      if (err) return err;
    }
    return null;
  };

  const goTo = (target: WizardStep) => {
    const blocking = firstErrorBefore(target);
    if (blocking) {
      setError(blocking);
      return;
    }
    setError(null);
    setStep(target);
  };

  const handleBack = () => {
    setError(null);
    if (stepIndex > 0) setStep(WIZARD_STEPS[stepIndex - 1].id);
  };

  const submitRelease = async () => {
    const blocking = firstErrorBefore('review') ?? validateStep('review');
    if (blocking) {
      setError(blocking);
      return;
    }
    try {
      await create.mutateAsync({
        version: version.trim(),
        artifactVersion: artifactVersion.trim() || version.trim(),
        selectedSkills: selectionState.dependencyOrder,
        targetProjects: audienceMode === 'specific' ? selectedProjects : [],
        skillTargets: selectedSkillTargets,
        releaseNotes: releaseNotes.trim() || null,
        breakingChanges: breakingChanges.trim() || null,
      });
      const nextCandidate = candidates[0]?.version ?? '';
      setVersion(nextCandidate);
      setArtifact(nextCandidate);
      versionSeededRef.current = candidates.length > 0;
      setNotes('');
      setBreaking('');
      setAudienceMode('all');
      setSelected([]);
      setExplicitSelectedSkills(catalog.map((s) => s.name));
      setProjectSkillPicks({});
      setStep('details');
      onCreated();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  /** Enter key and the footer button both route through here. */
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isLastStep) {
      void submitRelease();
      return;
    }
    const err = validateStep(step);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setStep(WIZARD_STEPS[stepIndex + 1].id);
  };

  return (
    // noValidate: native constraint validation can't see fields on inactive
    // steps, so validateStep is the single source of truth for the whole wizard.
    <form
      className={styles.wizard}
      onSubmit={handleSubmit}
      noValidate
      {...{ 'data-testid': 'fs-create-wizard-form' }}
    >
      {/* ── Stepper ── */}
      <div className={styles.wizardSteps}>
        {WIZARD_STEPS.map((s, i) => {
          const state =
            i === stepIndex
              ? styles.wizardStepActive
              : i < stepIndex
                ? styles.wizardStepDone
                : '';
          return (
            <React.Fragment key={s.id}>
              {i > 0 && (
                <div
                  className={`${styles.wizardConnector} ${i <= stepIndex ? styles.wizardConnectorDone : ''}`}
                />
              )}
              <button
                type="button"
                className={`${styles.wizardStep} ${state}`}
                onClick={() => goTo(s.id)}
                aria-current={i === stepIndex ? 'step' : undefined}
                {...{ 'data-testid': `fs-wizard-step-${s.id}` }}
              >
                <span className={styles.wizardStepNum}>
                  {i < stepIndex ? '✓' : i + 1}
                </span>
                <span className={styles.wizardStepLabel}>{s.label}</span>
              </button>
            </React.Fragment>
          );
        })}
      </div>

      {/* ── Step body ── */}
      <div className={styles.wizardBody}>
        <h3 className={styles.wizardStepTitle}>{currentMeta.title}</h3>
        <p className={styles.wizardStepHint}>{currentMeta.hint}</p>

        {step === 'details' && (
          <div className={styles.stepNarrow}>
            {!candidatesLoading && candidates.length === 0 && (
              <div
                className={styles.feedWarning}
                role="status"
                {...{ 'data-testid': 'fs-wizard-feed-unreachable' }}
              >
                <span className={styles.feedWarningIcon} aria-hidden="true">
                  ⚠
                </span>
                <div>
                  <p className={styles.feedWarningTitle}>
                    Azure Artifacts feed unreachable
                  </p>
                  <p>
                    The artifact version below is free text and will not be
                    checked against the feed — on publish or afterwards. A
                    version that was never published will be accepted here, and
                    installs are pinned to whatever you enter.
                  </p>
                  <p>
                    Set <code>AZURE_ARTIFACTS_ORG</code>,{' '}
                    <code>AZURE_ARTIFACTS_FEED</code> and{' '}
                    <code>AZURE_ARTIFACTS_PAT</code> on the APEX App Service to
                    restore the version picker and publish-time verification.
                  </p>
                </div>
              </div>
            )}
            <div className={styles.fieldGrid}>
              <div className={styles.formRow}>
                <label className={styles.label} htmlFor="fs-version">
                  Suite version
                </label>
                <input
                  id="fs-version"
                  className={`${styles.input} ${styles.inputMono}`}
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  placeholder="1.0.0"
                  aria-required="true"
                  {...{ 'data-testid': 'fs-wizard-version' }}
                />
                <p className={styles.fieldHint}>
                  Label teams see in APEX. Defaults to the newest feed
                  candidate; you can rename it.
                </p>
              </div>
              <div className={styles.formRow}>
                <label className={styles.label} htmlFor="fs-artifact">
                  Artifact version
                </label>
                {candidates.length > 0 ? (
                  <select
                    id="fs-artifact"
                    className={`${styles.select} ${styles.inputMono}`}
                    value={artifactVersion}
                    onChange={(e) => applyCandidateVersion(e.target.value)}
                    aria-required="true"
                    {...{ 'data-testid': 'fs-wizard-artifact-select' }}
                  >
                    {candidates.map((c) => (
                      <option key={c.version} value={c.version}>
                        {c.version}
                        {c === candidates[0] ? ' (latest in feed)' : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="fs-artifact"
                    className={`${styles.input} ${styles.inputMono}`}
                    value={artifactVersion}
                    onChange={(e) => setArtifact(e.target.value)}
                    placeholder={
                      candidatesLoading ? 'Loading feed…' : 'e.g. 1.0.0'
                    }
                    disabled={candidatesLoading}
                    {...{ 'data-testid': 'fs-wizard-artifact-input' }}
                  />
                )}
                <p className={styles.fieldHint}>
                  {candidates.length > 0
                    ? 'Must be a version already published to Azure Artifacts (auto-filled from the feed).'
                    : candidatesLoading
                      ? 'Loading candidates from Azure Artifacts…'
                      : 'No feed candidates found yet. Run the publish-apex-skills workflow, then refresh.'}
                </p>
              </div>
            </div>
            <div className={styles.formRow}>
              <label className={styles.label} htmlFor="fs-notes">
                Release notes
              </label>
              <textarea
                id="fs-notes"
                className={styles.textarea}
                value={releaseNotes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                placeholder="What changed in this release?"
                {...{ 'data-testid': 'fs-wizard-notes' }}
              />
            </div>
            <div className={styles.formRow}>
              <label className={styles.label} htmlFor="fs-breaking">
                Breaking changes
              </label>
              <textarea
                id="fs-breaking"
                className={styles.textarea}
                value={breakingChanges}
                onChange={(e) => setBreaking(e.target.value)}
                rows={2}
                placeholder="Anything that requires manual work from consuming teams"
                {...{ 'data-testid': 'fs-wizard-breaking' }}
              />
              <p className={styles.fieldHint}>
                Filling this in flags the release as breaking in every
                team&apos;s update banner.
              </p>
            </div>
          </div>
        )}

        {step === 'audience' && (
          <div className={styles.stepNarrow}>
            <AudienceField
              mode={audienceMode}
              projects={selectedProjects}
              onModeChange={(mode) => {
                setAudienceMode(mode);
                setSelected([]);
                if (mode === 'all') setProjectSkillPicks({});
              }}
              onProjectsChange={setSelected}
              idPrefix="fs"
              {...{ 'data-testid': 'fs-wizard-audience-field' }}
            />
          </div>
        )}

        {step === 'skills' &&
          (audienceMode === 'specific' ? (
            <ProjectSkillAssignment
              catalog={catalog}
              isCatalogLoading={catalogLoading}
              projects={selectedProjects}
              projectSkillPicks={projectSkillPicks}
              onProjectPicksChange={(project, picks) =>
                setProjectSkillPicks((prev) => ({ ...prev, [project]: picks }))
              }
              onCopyProjectPicks={(from, to) =>
                setProjectSkillPicks((prev) => ({
                  ...prev,
                  [to]: [...(prev[from] ?? [])],
                }))
              }
            />
          ) : (
            <SkillPicker
              catalog={catalog}
              isCatalogLoading={catalogLoading}
              explicitSelectedSkills={allModeSelection.explicitSelectedSkills}
              effectiveSelectedSkills={allModeSelection.effectiveSelectedSkills}
              requiredBy={allModeSelection.requiredBy}
              onSkillToggle={(name) =>
                setExplicitSelectedSkills((prev) =>
                  withoutRemovableSkills(catalog, prev, name)
                )
              }
              onSelectAll={() =>
                setExplicitSelectedSkills(catalog.map((s) => s.name))
              }
              onClearAll={() =>
                setExplicitSelectedSkills(lockedAlwaysInstallSkills(catalog))
              }
            />
          ))}

        {step === 'review' && (
          <>
            <div className={styles.reviewGrid}>
              <div className={styles.reviewItem}>
                <span className={styles.reviewKey}>Suite version</span>
                <span className={styles.reviewVal}>
                  {version.trim() || (
                    <em className={styles.reviewValMuted}>not set</em>
                  )}
                </span>
              </div>
              <div className={styles.reviewItem}>
                <span className={styles.reviewKey}>Artifact version</span>
                <span className={styles.reviewVal}>
                  {artifactVersion.trim() || version.trim()}
                </span>
              </div>
              <div className={styles.reviewItem}>
                <span className={styles.reviewKey}>Default audience</span>
                <span className={styles.reviewVal}>
                  {audienceMode === 'all' ? (
                    <span className={`${styles.badge} ${styles.badgeDraft}`}>
                      All projects
                    </span>
                  ) : (
                    <span className={styles.audienceChips}>
                      {selectedProjects.map((p) => (
                        <span key={p} className={styles.chip}>
                          {p}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </div>
              <div className={styles.reviewItem}>
                <span className={styles.reviewKey}>
                  Skills ({selectionState.effectiveSelectedSkills.length})
                </span>
                <span className={styles.reviewVal}>
                  <span className={styles.skillPillsRow}>
                    {selectionState.effectiveSelectedSkills
                      .slice(0, 12)
                      .map((name) => {
                        const isOv = Boolean(selectedSkillTargets[name]);
                        return (
                          <span
                            key={name}
                            className={`${styles.skillPill} ${isOv ? styles.skillPillOverride : ''}`}
                          >
                            {name}
                          </span>
                        );
                      })}
                    {selectionState.effectiveSelectedSkills.length > 12 && (
                      <span className={styles.skillPill}>
                        +{selectionState.effectiveSelectedSkills.length - 12}{' '}
                        more
                      </span>
                    )}
                  </span>
                </span>
              </div>
              {audienceMode === 'specific' && selectedProjects.length > 0 && (
                <div className={styles.reviewItem}>
                  <span className={styles.reviewKey}>Per-project skills</span>
                  <span className={styles.reviewVal}>
                    {selectedProjects.map((project) => {
                      const count =
                        projectAssignment.perProject[project]?.effective
                          .length ?? 0;
                      return (
                        <div
                          key={project}
                          {...{ 'data-testid': `fs-review-project-${project}` }}
                        >
                          <strong>{project}</strong> — {count} skill
                          {count === 1 ? '' : 's'}
                        </div>
                      );
                    })}
                  </span>
                </div>
              )}
              {overrideCount > 0 && (
                <div className={styles.reviewItem}>
                  <span className={styles.reviewKey}>
                    Skill audience overrides
                  </span>
                  <span className={styles.reviewVal}>
                    {Object.entries(selectedSkillTargets).map(
                      ([name, projects]) => (
                        <div key={name}>
                          <code>{name}</code> →{' '}
                          {projects.length > 0
                            ? projects.join(', ')
                            : 'all projects'}
                        </div>
                      )
                    )}
                  </span>
                </div>
              )}
              <div className={styles.reviewItem}>
                <span className={styles.reviewKey}>Release notes</span>
                <span className={styles.reviewVal}>
                  {releaseNotes.trim() || (
                    <em className={styles.reviewValMuted}>none</em>
                  )}
                </span>
              </div>
              <div className={styles.reviewItem}>
                <span className={styles.reviewKey}>Breaking changes</span>
                <span className={styles.reviewVal}>
                  {breakingChanges.trim() || (
                    <em className={styles.reviewValMuted}>none</em>
                  )}
                </span>
              </div>
            </div>
            <p className={styles.inlineNote}>
              Creating this release saves it as a <strong>draft</strong>. Teams
              only see it once you publish.
            </p>
            {reviewIssues.length > 0 && (
              <div
                className={styles.reviewValidationBox}
                role="alert"
                aria-live="assertive"
                aria-label="Review validation issues"
              >
                <h4 className={styles.reviewValidationTitle}>
                  Resolve dependency coverage
                </h4>
                <ul className={styles.reviewValidationList}>
                  {reviewIssues.map((issue) => (
                    <li key={issue.key}>
                      <strong>{issue.message}</strong>
                      <span>{issue.remediation}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>

      {/* ── Footer ── */}
      <div className={styles.wizardFooter}>
        <span className={styles.wizardSummary}>
          <span className={styles.wizardSummaryStrong}>
            {selectionState.effectiveSelectedSkills.length} skills
          </span>
          <span className={styles.wizardSep}>·</span>
          <span className={styles.wizardSummaryStrong}>
            {releaseAudienceLabel}
          </span>
          {overrideCount > 0 && (
            <>
              <span className={styles.wizardSep}>·</span>
              <span className={styles.overrideBadge}>
                {overrideCount} override{overrideCount > 1 ? 's' : ''}
              </span>
            </>
          )}
        </span>
        {stepIndex > 0 && (
          <button
            type="button"
            className={styles.btnGhost}
            onClick={handleBack}
            {...{ 'data-testid': 'fs-wizard-back' }}
          >
            Back
          </button>
        )}
        {isLastStep ? (
          <button
            type="submit"
            className={styles.btnPrimary}
            disabled={create.isPending || reviewIssues.length > 0}
            {...{ 'data-testid': 'fs-wizard-create-draft' }}
          >
            {create.isPending ? 'Creating…' : 'Create draft'}
          </button>
        ) : (
          <button
            type="submit"
            className={styles.btnPrimary}
            {...{ 'data-testid': 'fs-wizard-continue' }}
          >
            Continue
          </button>
        )}
      </div>
    </form>
  );
};

// ── CompatCheckForm ───────────────────────────────────────────────────────────

const CompatCheckForm: React.FC = () => {
  const [project, setProject] = useState('');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [apexProj, setApexProj] = useState('');
  const [provider, setProvider] = useState<'ado' | 'github'>('ado');
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const checkCompat = useCheckFoundationSkillCompatibility();

  const handleCheck = async (e: React.FormEvent) => {
    e.preventDefault();
    setResult(null);
    setErr(null);
    try {
      const res = await checkCompat.mutateAsync({
        project,
        repo,
        provider,
        branch: branch || 'main',
        apexProject: apexProj || undefined,
      });
      const r = res.report;
      setResult(
        `Status: ${r.status}${r.errors.length ? ` | Errors: ${r.errors.join('; ')}` : ''}${r.warnings.length ? ` | Warnings: ${r.warnings.join('; ')}` : ''}`
      );
    } catch (e2: unknown) {
      setErr((e2 as Error).message);
    }
  };

  return (
    <form
      className={styles.card}
      onSubmit={handleCheck}
      {...{ 'data-testid': 'fs-compat-check-form' }}
    >
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>Run compatibility check</h3>
        <p className={styles.cardHint}>
          Inspects a consumer repo&apos;s installed skills and lockfile, then
          records its status below.
        </p>
      </div>
      <div className={styles.cardBody}>
        <div className={styles.fieldGrid}>
          <div className={styles.formRow}>
            <label className={styles.label} htmlFor="cc-apex">
              Apex project name
            </label>
            <input
              id="cc-apex"
              className={styles.input}
              value={apexProj}
              onChange={(e) => setApexProj(e.target.value)}
              placeholder="e.g. MaxView"
              {...{ 'data-testid': 'fs-compat-apex-project' }}
            />
            <p className={styles.fieldHint}>
              Used to resolve which release this repo is entitled to.
            </p>
          </div>
          <div className={styles.formRow}>
            <label className={styles.label} htmlFor="cc-provider">
              Provider
            </label>
            <select
              id="cc-provider"
              className={styles.select}
              value={provider}
              onChange={(e) => setProvider(e.target.value as 'ado' | 'github')}
              {...{ 'data-testid': 'fs-compat-provider' }}
            >
              <option value="ado">Azure DevOps</option>
              <option value="github">GitHub</option>
            </select>
          </div>
          <div className={styles.formRow}>
            <label className={styles.label} htmlFor="cc-project">
              ADO project / GitHub org
            </label>
            <input
              id="cc-project"
              className={styles.input}
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="e.g. MaxView"
              required
              {...{ 'data-testid': 'fs-compat-project' }}
            />
          </div>
          <div className={styles.formRow}>
            <label className={styles.label} htmlFor="cc-repo">
              Skill repo name
            </label>
            <input
              id="cc-repo"
              className={styles.input}
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="e.g. MaxView"
              required
              {...{ 'data-testid': 'fs-compat-repo' }}
            />
          </div>
          <div className={styles.formRow}>
            <label className={styles.label} htmlFor="cc-branch">
              Skill branch
            </label>
            <input
              id="cc-branch"
              className={`${styles.input} ${styles.inputMono}`}
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              {...{ 'data-testid': 'fs-compat-branch' }}
            />
          </div>
        </div>
        {err && (
          <p className={styles.error} role="alert">
            {err}
          </p>
        )}
        {result && <p className={styles.inlineNote}>{result}</p>}
        <div className={styles.btnRow}>
          <button
            type="submit"
            className={styles.btnSecondary}
            disabled={checkCompat.isPending}
            {...{ 'data-testid': 'fs-compat-check-submit' }}
          >
            {checkCompat.isPending ? 'Checking…' : 'Check compatibility'}
          </button>
        </div>
      </div>
    </form>
  );
};

// ── EditReleasePanel ──────────────────────────────────────────────────────────

const EditReleasePanel: React.FC<{
  release: FoundationSkillRelease;
  onSave: (payload: Omit<UpdateReleasePayload, 'id'>) => Promise<void>;
  onCancel: () => void;
  isSaving: boolean;
}> = ({ release, onSave, onCancel, isSaving }) => {
  const isDraft = release.status === 'draft';

  const [version, setVersion] = useState(release.version);
  const [artifactVersion, setArtifact] = useState(release.artifactVersion);
  const [notes, setNotes] = useState(release.releaseNotes ?? '');
  const [breaking, setBreaking] = useState(release.breakingChanges ?? '');
  const [audienceMode, setAudienceMode] = useState<'all' | 'specific'>(
    release.targetProjects?.length ? 'specific' : 'all'
  );
  const [selectedProjects, setSelected] = useState<string[]>(
    release.targetProjects ?? []
  );
  const [localErr, setLocalErr] = useState<string | null>(null);

  const [explicitSelectedSkills, setExplicitSelectedSkills] = useState<
    string[]
  >(release.selectedSkills ?? []);
  const [projectSkillPicks, setProjectSkillPicks] = useState<
    Record<string, string[]>
  >(() => seedProjectPicksFromRelease(release));

  const seededRef = useRef(false);

  const { skills: catalog, isLoading: catalogLoading } =
    useShippableFoundationSkills();

  // Older releases predate per-skill selection; fall back to "everything".
  useEffect(() => {
    if (seededRef.current || catalog.length === 0) return;
    seededRef.current = true;
    if (!release.selectedSkills?.length)
      setExplicitSelectedSkills(catalog.map((s) => s.name));
  }, [catalog, release.selectedSkills]);

  // Keep per-project pick maps aligned when the project list changes while editing.
  useEffect(() => {
    if (audienceMode !== 'specific' || catalog.length === 0) return;
    const allNames = catalog.map((s) => s.name);
    setProjectSkillPicks((prev) => {
      const next: Record<string, string[]> = {};
      let changed = Object.keys(prev).some(
        (key) => !selectedProjects.includes(key)
      );
      for (const project of selectedProjects) {
        if (project in prev) {
          next[project] = prev[project];
        } else {
          next[project] = allNames;
          changed = true;
        }
      }
      return changed || Object.keys(next).length !== Object.keys(prev).length
        ? next
        : prev;
    });
  }, [audienceMode, selectedProjects, catalog]);

  const allModeSelection = resolveFoundationSkillSelection(
    catalog,
    explicitSelectedSkills
  );
  const projectAssignment = resolveProjectAssignment(
    catalog,
    selectedProjects,
    projectSkillPicks
  );
  const selectionState =
    audienceMode === 'specific'
      ? {
          explicitSelectedSkills: [
            ...new Set(
              selectedProjects.flatMap((p) => projectSkillPicks[p] ?? [])
            ),
          ],
          effectiveSelectedSkills: projectAssignment.effectiveSelectedSkills,
          dependencyOrder: projectAssignment.dependencyOrder,
          requiredBy: {},
        }
      : allModeSelection;
  const selectedSkillTargets =
    audienceMode === 'specific' ? projectAssignment.skillTargets : {};

  const handleSave = async () => {
    setLocalErr(null);
    if (
      isDraft &&
      audienceMode === 'specific' &&
      selectedProjects.length === 0
    ) {
      setLocalErr('Select at least one project or switch to "All projects".');
      return;
    }
    if (isDraft && selectionState.effectiveSelectedSkills.length === 0) {
      setLocalErr('At least one skill must be selected.');
      return;
    }
    await onSave({
      ...(isDraft && {
        version: version.trim(),
        artifactVersion: artifactVersion.trim() || version.trim(),
        targetProjects: audienceMode === 'specific' ? selectedProjects : [],
        selectedSkills: selectionState.dependencyOrder,
        skillTargets: selectedSkillTargets,
      }),
      releaseNotes: notes.trim() || null,
      breakingChanges: breaking.trim() || null,
    });
  };

  return (
    <div
      className={styles.editNotesPanel}
      {...{ 'data-testid': `fs-edit-release-panel-${release.id}` }}
    >
      <h4 className={styles.editPanelTitle}>Edit release</h4>

      {isDraft && (
        <div className={styles.fieldGrid}>
          <div className={styles.formRow}>
            <label
              className={styles.label}
              htmlFor={`er-version-${release.id}`}
            >
              Suite version
            </label>
            <input
              id={`er-version-${release.id}`}
              className={`${styles.input} ${styles.inputMono}`}
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              {...{ 'data-testid': `fs-edit-version-${release.id}` }}
            />
          </div>
          <div className={styles.formRow}>
            <label
              className={styles.label}
              htmlFor={`er-artifact-${release.id}`}
            >
              Artifact version
            </label>
            <input
              id={`er-artifact-${release.id}`}
              className={`${styles.input} ${styles.inputMono}`}
              value={artifactVersion}
              onChange={(e) => setArtifact(e.target.value)}
              {...{ 'data-testid': `fs-edit-artifact-${release.id}` }}
            />
          </div>
        </div>
      )}

      {isDraft && (
        <>
          <AudienceField
            mode={audienceMode}
            projects={selectedProjects}
            onModeChange={(mode) => {
              setAudienceMode(mode);
              setSelected([]);
              if (mode === 'all') setProjectSkillPicks({});
            }}
            onProjectsChange={setSelected}
            idPrefix={`er-${release.id}`}
            {...{ 'data-testid': `fs-edit-audience-field-${release.id}` }}
          />

          <div className={styles.formRow}>
            <span className={styles.label}>
              {audienceMode === 'specific'
                ? 'Assign skills to projects'
                : 'Skills'}
            </span>
            {audienceMode === 'specific' ? (
              <ProjectSkillAssignment
                catalog={catalog}
                isCatalogLoading={catalogLoading}
                projects={selectedProjects}
                projectSkillPicks={projectSkillPicks}
                onProjectPicksChange={(project, picks) =>
                  setProjectSkillPicks((prev) => ({
                    ...prev,
                    [project]: picks,
                  }))
                }
                onCopyProjectPicks={(from, to) =>
                  setProjectSkillPicks((prev) => ({
                    ...prev,
                    [to]: [...(prev[from] ?? [])],
                  }))
                }
              />
            ) : (
              <SkillPicker
                catalog={catalog}
                isCatalogLoading={catalogLoading}
                explicitSelectedSkills={allModeSelection.explicitSelectedSkills}
                effectiveSelectedSkills={
                  allModeSelection.effectiveSelectedSkills
                }
                requiredBy={allModeSelection.requiredBy}
                onSkillToggle={(name) =>
                  setExplicitSelectedSkills((prev) =>
                    withoutRemovableSkills(catalog, prev, name)
                  )
                }
                onSelectAll={() =>
                  setExplicitSelectedSkills(catalog.map((s) => s.name))
                }
                onClearAll={() =>
                  setExplicitSelectedSkills(lockedAlwaysInstallSkills(catalog))
                }
              />
            )}
          </div>
        </>
      )}

      <div className={styles.formRow}>
        <label className={styles.label} htmlFor={`er-notes-${release.id}`}>
          Release notes
        </label>
        <textarea
          id={`er-notes-${release.id}`}
          className={styles.textarea}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={5}
          placeholder="What changed in this release?"
          {...{ 'data-testid': `fs-edit-notes-${release.id}` }}
        />
      </div>
      <div className={styles.formRow}>
        <label className={styles.label} htmlFor={`er-breaking-${release.id}`}>
          Breaking changes
        </label>
        <textarea
          id={`er-breaking-${release.id}`}
          className={styles.textarea}
          value={breaking}
          onChange={(e) => setBreaking(e.target.value)}
          rows={2}
          {...{ 'data-testid': `fs-edit-breaking-${release.id}` }}
        />
      </div>

      {localErr && (
        <p className={styles.error} role="alert">
          {localErr}
        </p>
      )}
      <div className={styles.editNotesBtns}>
        <button
          className={styles.btnPrimary}
          type="button"
          disabled={isSaving}
          onClick={() => void handleSave()}
          {...{ 'data-testid': `fs-edit-save-${release.id}` }}
        >
          {isSaving ? 'Saving…' : 'Save changes'}
        </button>
        <button
          className={styles.btnGhost}
          type="button"
          onClick={onCancel}
          {...{ 'data-testid': `fs-edit-cancel-${release.id}` }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

// ── AuditDrawer ───────────────────────────────────────────────────────────────

const AuditDrawer: React.FC<{ releaseId: string; onClose: () => void }> = ({
  releaseId,
  onClose,
}) => {
  const { data: entries = [], isLoading } =
    useFoundationSkillReleaseAudit(releaseId);
  return (
    <div
      className={styles.drawer}
      {...{ 'data-testid': `fs-audit-drawer-${releaseId}` }}
    >
      <div className={styles.drawerHeader}>
        <h3 className={styles.drawerTitle}>Audit log</h3>
        <button
          className={styles.closeBtn}
          onClick={onClose}
          type="button"
          aria-label="Close"
          {...{ 'data-testid': 'fs-audit-close' }}
        >
          ✕
        </button>
      </div>
      {isLoading ? (
        <p className={styles.muted}>Loading…</p>
      ) : entries.length === 0 ? (
        <p className={styles.muted}>No audit entries.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Action</th>
              <th>Actor</th>
              <th>When</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>
                  <span className={styles.auditAction}>
                    {formatAuditAction(e.action)}
                  </span>
                </td>
                <td>{e.actorEmail ?? e.actorId ?? '—'}</td>
                <td>{formatTs(e.createdAt)}</td>
                <td className={styles.detailsCell}>
                  {e.details ? JSON.stringify(e.details).slice(0, 80) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

// ── SkillsMatrixTab ───────────────────────────────────────────────────────────

const SkillsMatrixTab: React.FC = () => {
  const { data: skills = [], isLoading } = useFoundationSkillMatrix();
  const [search, setSearch] = useState('');
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);

  const term = search.trim().toLowerCase();
  const filtered = term
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(term) ||
          s.summary.toLowerCase().includes(term)
      )
    : skills;

  if (isLoading) return <p className={styles.muted}>Loading skills matrix…</p>;

  return (
    <div {...{ 'data-testid': 'fs-skills-matrix-tab' }}>
      <div className={styles.matrixToolbar}>
        <input
          className={`${styles.input} ${styles.matrixSearch}`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search skills…"
          aria-label="Search skills"
          {...{ 'data-testid': 'fs-matrix-search' }}
        />
        <span className={`${styles.muted} ${styles.pushRight}`}>
          {filtered.length} of {skills.length} skills
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className={styles.emptyState}>
          <p className={styles.emptyStateTitle}>No matching skills</p>
          <p className={styles.emptyStateText}>
            Nothing matches “{search}”. Try a shorter search term.
          </p>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Skill</th>
                <th>In releases</th>
                <th>Effective audience</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((skill) => {
                const isExpanded = expandedSkill === skill.name;
                const publishedReleases = skill.releases.filter(
                  (r) => r.status === 'published'
                );
                const allProjects = publishedReleases.every(
                  (r) => r.effectiveTargetProjects.length === 0
                );
                const uniqueProjects = Array.from(
                  new Set(
                    publishedReleases.flatMap((r) => r.effectiveTargetProjects)
                  )
                );

                return (
                  <React.Fragment key={skill.name}>
                    <tr
                      className={styles.matrixRow}
                      onClick={() =>
                        setExpandedSkill(isExpanded ? null : skill.name)
                      }
                      {...{ 'data-testid': `fs-matrix-row-${skill.name}` }}
                    >
                      <td>
                        <div className={styles.matrixSkillName}>
                          <span
                            className={`${styles.matrixCaret} ${isExpanded ? styles.matrixCaretOpen : ''}`}
                          >
                            ▶
                          </span>
                          {skill.name}
                        </div>
                        <div className={styles.matrixSkillSummary}>
                          {skill.summary}
                        </div>
                      </td>
                      <td>
                        {skill.releases.length === 0 ? (
                          <span className={styles.muted}>—</span>
                        ) : (
                          <span className={styles.audienceChips}>
                            {skill.releases.map((r) => (
                              <span
                                key={r.releaseId}
                                className={`${styles.badge} ${statusBadgeClass(r.status)}`}
                                title={`Audience: ${r.effectiveTargetProjects.length === 0 ? 'All projects' : r.effectiveTargetProjects.join(', ')}`}
                              >
                                v{r.version}
                              </span>
                            ))}
                          </span>
                        )}
                      </td>
                      <td>
                        {publishedReleases.length === 0 ? (
                          <span className={styles.muted}>
                            Not in any published release
                          </span>
                        ) : allProjects ? (
                          <span
                            className={`${styles.badge} ${styles.badgeDraft}`}
                          >
                            All projects
                          </span>
                        ) : (
                          <span className={styles.audienceChips}>
                            {uniqueProjects.slice(0, 4).map((p) => (
                              <span key={p} className={styles.chip}>
                                {p}
                              </span>
                            ))}
                            {uniqueProjects.length > 4 && (
                              <span className={styles.chip}>
                                +{uniqueProjects.length - 4}
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={3} className={styles.matrixExpanded}>
                          {skill.releases.length === 0 ? (
                            <p className={styles.muted}>
                              This skill has not been included in any release
                              yet.
                            </p>
                          ) : (
                            <table className={styles.matrixNested}>
                              <thead>
                                <tr>
                                  <th>Release</th>
                                  <th>Status</th>
                                  <th>Audience</th>
                                </tr>
                              </thead>
                              <tbody>
                                {skill.releases.map((r) => (
                                  <tr key={r.releaseId}>
                                    <td>
                                      <code>v{r.version}</code>
                                    </td>
                                    <td>
                                      <span
                                        className={`${styles.badge} ${statusBadgeClass(r.status)}`}
                                      >
                                        {r.status}
                                      </span>
                                    </td>
                                    <td>
                                      {r.effectiveTargetProjects.length ===
                                      0 ? (
                                        <span
                                          className={`${styles.badge} ${styles.badgeDraft}`}
                                        >
                                          All projects
                                        </span>
                                      ) : (
                                        <span
                                          title={r.effectiveTargetProjects.join(
                                            ', '
                                          )}
                                        >
                                          {r.effectiveTargetProjects
                                            .slice(0, 3)
                                            .join(', ')}
                                          {r.effectiveTargetProjects.length >
                                            3 &&
                                            ` +${r.effectiveTargetProjects.length - 3}`}
                                        </span>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ── Active teams ──────────────────────────────────────────────────────────────

const TeamsTab: React.FC = () => {
  const { data: teams = [], isLoading } = useFoundationSkillTeams();
  const scanAll = useScanAllFoundationSkillRepos();
  const [search, setSearch] = useState('');
  const [expandedRepo, setExpandedRepo] = useState<string | null>(null);
  const [scanMsg, setScanMsg] = useState<string | null>(null);

  const term = search.trim().toLowerCase();
  const filtered = term
    ? teams
        .map((t) => ({
          ...t,
          repos: t.repos.filter(
            (r) =>
              t.apexProject.toLowerCase().includes(term) ||
              r.repo.toLowerCase().includes(term) ||
              r.friendlyName.toLowerCase().includes(term) ||
              (r.installedVersion ?? '').toLowerCase().includes(term)
          ),
        }))
        .filter((t) => t.repos.length > 0)
    : teams;

  const totalRepos = teams.reduce((n, t) => n + t.repos.length, 0);
  const shownRepos = filtered.reduce((n, t) => n + t.repos.length, 0);

  const handleScanAll = async () => {
    setScanMsg(null);
    try {
      const result = await scanAll.mutateAsync();
      setScanMsg(
        `Scanned ${result.scanned} repo(s)${result.failed > 0 ? `, ${result.failed} failed` : ''}.`
      );
    } catch (err: unknown) {
      setScanMsg(`Scan failed: ${(err as Error).message}`);
    }
  };

  if (isLoading) return <p className={styles.muted}>Loading teams…</p>;

  if (teams.length === 0) {
    return (
      <div className={styles.emptyState}>
        <p className={styles.emptyStateTitle}>No teams registered</p>
        <p className={styles.emptyStateText}>
          Teams appear here once a project has a skills repo configured in
          Project Settings.
        </p>
      </div>
    );
  }

  return (
    <div {...{ 'data-testid': 'fs-teams-tab' }}>
      <div className={styles.matrixToolbar}>
        <input
          className={`${styles.input} ${styles.matrixSearch}`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search team, repo, or version…"
          aria-label="Search teams"
          {...{ 'data-testid': 'fs-teams-search' }}
        />
        <button
          className={styles.btnSecondary}
          type="button"
          disabled={scanAll.isPending}
          onClick={handleScanAll}
          {...{ 'data-testid': 'fs-teams-scan-all' }}
        >
          {scanAll.isPending ? 'Scanning…' : 'Refresh all'}
        </button>
        <span className={`${styles.muted} ${styles.pushRight}`}>
          {shownRepos} of {totalRepos} repos · {filtered.length} teams
        </span>
      </div>

      {scanMsg && (
        <p className={styles.successMsg} role="status">
          {scanMsg}
        </p>
      )}

      {shownRepos === 0 ? (
        <div className={styles.emptyState}>
          <p className={styles.emptyStateTitle}>No matching teams</p>
          <p className={styles.emptyStateText}>
            Nothing matches “{search}”. Try a shorter search term.
          </p>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Repo</th>
                <th>Installed</th>
                <th>Release</th>
                <th>Skills received</th>
                <th>Compatibility</th>
                <th>Last checked</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((team) => (
                <React.Fragment key={team.apexProject}>
                  <tr className={styles.teamGroupRow}>
                    <td colSpan={6}>
                      <span className={styles.teamGroupName}>
                        {team.apexProject}
                      </span>
                      <span className={styles.muted}>
                        {' '}
                        · {team.repos.length} repo
                        {team.repos.length === 1 ? '' : 's'}
                      </span>
                    </td>
                  </tr>
                  {team.repos.map((repo) => {
                    const key = `${team.apexProject}|${repo.provider}|${repo.repo}|${repo.branch}`;
                    const isExpanded = expandedRepo === key;
                    return (
                      <React.Fragment key={key}>
                        <tr
                          className={styles.matrixRow}
                          onClick={() =>
                            setExpandedRepo(isExpanded ? null : key)
                          }
                          {...{ 'data-testid': `fs-teams-row-${key}` }}
                        >
                          <td>
                            <div className={styles.matrixSkillName}>
                              <span
                                className={`${styles.matrixCaret} ${isExpanded ? styles.matrixCaretOpen : ''}`}
                              >
                                ▶
                              </span>
                              {repo.repo}
                            </div>
                            <div className={styles.matrixSkillSummary}>
                              {repo.friendlyName} · {repo.provider} ·{' '}
                              {repo.branch}
                            </div>
                          </td>
                          <td>
                            {repo.installedVersion ? (
                              <>
                                v{repo.installedVersion}
                                {repo.updateAvailable && (
                                  <span
                                    className={styles.updateDot}
                                    title={`Update available: v${repo.availableVersion}`}
                                  />
                                )}
                              </>
                            ) : (
                              <span className={styles.muted}>—</span>
                            )}
                          </td>
                          <td>
                            {repo.installedReleaseStatus ? (
                              <span
                                className={`${styles.badge} ${statusBadgeClass(repo.installedReleaseStatus)}`}
                              >
                                {repo.installedReleaseStatus}
                              </span>
                            ) : (
                              <span className={styles.muted}>unmatched</span>
                            )}
                          </td>
                          <td>
                            {repo.releasedSkills.length > 0 ? (
                              <span title={repo.releasedSkills.join(', ')}>
                                {repo.releasedSkills.length}
                              </span>
                            ) : (
                              <span className={styles.muted}>—</span>
                            )}
                          </td>
                          <td>
                            {repo.observed ? (
                              <span
                                className={`${styles.badge} ${compatBadgeClass(repo.compatibilityStatus)}`}
                              >
                                {repo.compatibilityStatus}
                              </span>
                            ) : (
                              <span
                                className={styles.muted}
                                title="Registered but never scanned"
                              >
                                not scanned
                              </span>
                            )}
                          </td>
                          <td>{formatTs(repo.compatibilityCheckedAt)}</td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={6} className={styles.matrixExpanded}>
                              <TeamRepoDetail
                                apexProject={team.apexProject}
                                repo={repo}
                              />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

/** Expanded detail for one repo: skills + per-repo rollback action. */
const TeamRepoDetail: React.FC<{
  apexProject: string;
  repo: FoundationSkillTeamRepo;
}> = ({ apexProject, repo }) => {
  const [targetId, setTargetId] = useState('');
  const [rollbackMsg, setRollbackMsg] = useState<string | null>(null);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const { data: targets = [], isLoading: targetsLoading } =
    useFoundationSkillRollbackTargets(apexProject, repo.installedVersion);
  const rollback = useRollbackFoundationSkillRepo();
  const pendingTarget = targets.find((t) => t.id === targetId) ?? null;

  if (!repo.observed) {
    return (
      <p className={styles.muted}>
        This repo is registered in Project Settings but has never been scanned.
        Use “Refresh all” to pull its install state.
      </p>
    );
  }

  // Skills the lockfile records that the installed release did not ship to this
  // project — usually a stale install or a hand-edited lockfile.
  const releasedSet = new Set(repo.releasedSkills);
  const extraneous = repo.installedSkills.filter((s) => !releasedSet.has(s));

  const requestRollback = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!targetId || !pendingTarget) return;
    setConfirmRollback(true);
  };

  const executeRollback = async () => {
    if (!pendingTarget) return;
    setRollbackMsg(null);
    try {
      const result = await rollback.mutateAsync({
        project: apexProject,
        repo: repo.repo,
        provider: repo.provider,
        defaultBranch: repo.branch,
        apexProject,
        releaseId: pendingTarget.id,
        fromVersion: repo.installedVersion,
      });
      setConfirmRollback(false);
      if (result.prUrl) {
        setRollbackMsg(`Rollback PR opened: ${result.prUrl}`);
      } else if (result.status === 'no_changes') {
        setRollbackMsg(`Already at v${result.toVersion} — no PR needed.`);
      } else if (result.status === 'drift') {
        setRollbackMsg(
          `Blocked by foundation drift. ${result.errors.join(' ')}`
        );
      } else {
        setRollbackMsg(`${result.status}: ${result.report}`);
      }
    } catch (err: unknown) {
      setConfirmRollback(false);
      setRollbackMsg(`Rollback failed: ${(err as Error).message}`);
    }
  };

  return (
    <>
      {/* data-testid-exempt */}
      <div onClick={(e) => e.stopPropagation()}>
        <h4 className={styles.subHeading}>
          Released to this team (v{repo.installedVersion ?? '—'})
        </h4>
        {repo.releasedSkills.length === 0 ? (
          <p className={styles.muted}>
            No release matched v{repo.installedVersion ?? '—'}, so the shipped
            skill list is unknown.
          </p>
        ) : (
          <span className={styles.audienceChips}>
            {repo.releasedSkills.map((s) => (
              <span key={s} className={styles.chip}>
                {s}
              </span>
            ))}
          </span>
        )}

        <h4 className={styles.subHeading}>Installed per lockfile</h4>
        {repo.installedSkills.length === 0 ? (
          <p className={styles.muted}>No skills recorded in the lockfile.</p>
        ) : (
          <span className={styles.audienceChips}>
            {repo.installedSkills.map((s) => (
              <span key={s} className={styles.chip}>
                {s}
              </span>
            ))}
          </span>
        )}

        {extraneous.length > 0 && (
          <p className={styles.muted}>
            Installed but not shipped by this release: {extraneous.join(', ')}
          </p>
        )}

        <h4 className={styles.subHeading}>Rollback</h4>
        {!repo.installedVersion ? (
          <p className={styles.muted}>
            Installed version unknown — cannot rollback yet.
          </p>
        ) : targetsLoading ? (
          <p className={styles.muted}>Loading rollback targets…</p>
        ) : targets.length === 0 ? (
          <p className={styles.muted}>
            No older published release is available for {apexProject} from v
            {repo.installedVersion}.
          </p>
        ) : (
          <div className={styles.btnRow}>
            <select
              className={styles.input}
              aria-label="Rollback target version"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              disabled={rollback.isPending}
              {...{ 'data-testid': `fs-rollback-target-${repo.repo}` }}
            >
              <option value="">Select older published version…</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  v{t.version}
                  {t.releaseNotes ? ` — ${t.releaseNotes.slice(0, 60)}` : ''}
                </option>
              ))}
            </select>
            <button
              className={styles.btnSecondary}
              type="button"
              disabled={!targetId || rollback.isPending}
              onClick={requestRollback}
              {...{ 'data-testid': `fs-rollback-open-pr-${repo.repo}` }}
            >
              Open rollback PR
            </button>
          </div>
        )}
        {rollbackMsg && (
          <p className={styles.successMsg} role="status">
            {rollbackMsg}
          </p>
        )}

        {confirmRollback && pendingTarget && (
          <ConfirmActionModal
            title={`Rollback ${repo.repo}?`}
            body={
              <>
                Open a PR to roll <strong>{repo.repo}</strong> back from{' '}
                <strong>v{repo.installedVersion}</strong> to{' '}
                <strong>v{pendingTarget.version}</strong>.
              </>
            }
            hint="Only the fenced managed region inside the configured skill root and apex-skills.lock.json change. Project notes below the APEX:END managed fence are preserved."
            confirmLabel="Open rollback PR"
            pendingLabel="Opening PR…"
            tone="warning"
            isPending={rollback.isPending}
            onConfirm={() => {
              void executeRollback();
            }}
            onCancel={() => setConfirmRollback(false)}
            {...{ 'data-testid': `fs-rollback-confirm-modal-${repo.repo}` }}
          />
        )}
      </div>
    </>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

type Section = 'releases' | 'skills' | 'teams' | 'repos' | 'create';

const SECTION_LABELS: Record<Section, string> = {
  releases: 'Releases',
  skills: 'Skills',
  teams: 'Teams',
  repos: 'Consumer Repos',
  create: 'Create Draft',
};

type PendingConfirm =
  | { kind: 'deprecate'; release: FoundationSkillRelease }
  | { kind: 'delete'; release: FoundationSkillRelease }
  | null;

export const FoundationSkillsAdmin: React.FC = () => {
  const [activeSection, setActiveSection] = useState<Section>('releases');
  const [auditReleaseId, setAuditReleaseId] = useState<string | null>(null);
  const [editReleaseId, setEditReleaseId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionValidationIssues, setActionValidationIssues] = useState<
    FoundationSkillReleaseValidationIssue[]
  >([]);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  /** Which consumer-repo row is running Check / Open PR (provider|project|repo|branch). */
  const [busyRepoKey, setBusyRepoKey] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm>(null);
  const [pendingUpdateRepo, setPendingUpdateRepo] =
    useState<FoundationSkillRepoStatus | null>(null);

  const { data: releases = [], isLoading: relLoading } =
    useFoundationSkillReleases();
  const { data: candidates = [], isLoading: candLoading } =
    useFoundationSkillCandidates();
  const { data: repoStatuses = [], isLoading: repoLoading } =
    useFoundationSkillRepoStatuses();

  const publish = usePublishFoundationSkillRelease();
  const deprecate = useDeprecateFoundationSkillRelease();
  const deleteDraft = useDeleteDraftFoundationSkillRelease();
  const updateRelease = useUpdateFoundationSkillRelease();
  const updateRepo = useUpdateRepoWithFoundationSkills();
  const checkCompat = useCheckFoundationSkillCompatibility();
  const scanAllRepos = useScanAllFoundationSkillRepos();

  const clearMessages = () => {
    setActionError(null);
    setActionValidationIssues([]);
    setActionMsg(null);
  };

  const handleScanAllRepos = async () => {
    clearMessages();
    try {
      const result = await scanAllRepos.mutateAsync();
      setActionMsg(
        `Scanned ${result.scanned} repo(s)${result.failed > 0 ? `, ${result.failed} failed` : ''}.`
      );
    } catch (err: unknown) {
      setActionError(`Scan failed: ${(err as Error).message}`);
    }
  };

  const handlePublish = async (release: FoundationSkillRelease) => {
    clearMessages();
    try {
      await publish.mutateAsync(release.id);
      setActionMsg(`v${release.version} published.`);
    } catch (err: unknown) {
      if (err instanceof FoundationSkillReleaseValidationClientError) {
        setActionError(err.message);
        setActionValidationIssues(err.issues);
        return;
      }
      setActionError((err as Error).message);
    }
  };

  const handleDeprecate = (release: FoundationSkillRelease) => {
    setPendingConfirm({ kind: 'deprecate', release });
  };

  const handleDelete = (release: FoundationSkillRelease) => {
    setPendingConfirm({ kind: 'delete', release });
  };

  const executePendingConfirm = async (reason?: string) => {
    if (!pendingConfirm) return;
    clearMessages();
    try {
      if (pendingConfirm.kind === 'deprecate') {
        await deprecate.mutateAsync({ id: pendingConfirm.release.id, reason });
        setActionMsg(`v${pendingConfirm.release.version} deprecated.`);
      } else {
        await deleteDraft.mutateAsync(pendingConfirm.release.id);
        setActionMsg(`Draft v${pendingConfirm.release.version} deleted.`);
      }
      setPendingConfirm(null);
    } catch (err: unknown) {
      setPendingConfirm(null);
      setActionError((err as Error).message);
    }
  };

  const repoRowKey = (
    s: Pick<
      FoundationSkillRepoStatus,
      'provider' | 'project' | 'repo' | 'branch'
    >
  ) => `${s.provider}|${s.project}|${s.repo}|${s.branch}`;

  const executeUpdateRepo = async (
    s: FoundationSkillRepoStatus,
    skillRoot?: string
  ) => {
    clearMessages();
    if (!s.apexProject) {
      setActionError(
        'This repo has no Apex project identity. Run compatibility refresh before opening an update PR.'
      );
      return;
    }
    setBusyRepoKey(repoRowKey(s));
    try {
      const result = await updateRepo.mutateAsync({
        project: s.project,
        repo: s.repo,
        provider: s.provider,
        // Must match the observed row — defaulting to main creates a wrong-branch PR
        // (and MaxView / similar teams use development).
        defaultBranch: s.branch || 'main',
        apexProject: s.apexProject,
        ...(skillRoot ? { skillRoot } : {}),
      });
      if (result.prUrl) {
        setActionMsg(`PR opened: ${result.prUrl}`);
      } else if (result.status === 'no_changes') {
        setActionMsg('Already up to date — no PR needed.');
      } else {
        setActionError(
          `Update ${result.status}: ${result.errors.join(' ') || result.report || 'unknown error'}`
        );
      }
    } catch (err: unknown) {
      setActionError((err as Error).message);
    } finally {
      setBusyRepoKey(null);
    }
  };

  const handleUpdateRepo = (s: FoundationSkillRepoStatus) => {
    if (!s.installedVersion) {
      setPendingUpdateRepo(s);
      return;
    }
    void executeUpdateRepo(s);
  };

  const handleCheckCompat = async (s: FoundationSkillRepoStatus) => {
    clearMessages();
    if (!s.apexProject) {
      setActionError(
        'This repo has no Apex project identity. Re-register it before checking compatibility.'
      );
      return;
    }
    setBusyRepoKey(repoRowKey(s));
    try {
      const result = await checkCompat.mutateAsync({
        project: s.project,
        repo: s.repo,
        provider: s.provider,
        // Upsert key includes branch — omitting it defaults to main and inserts a duplicate row.
        branch: s.branch || 'main',
        apexProject: s.apexProject,
      });
      setActionMsg(
        `Compatibility (${s.repo}@${s.branch}): ${result.report.status}. ` +
          `${result.report.errors.join(' ') || result.report.warnings.join(' ') || 'OK'}`
      );
    } catch (err: unknown) {
      setActionError((err as Error).message);
    } finally {
      setBusyRepoKey(null);
    }
  };

  return (
    <section
      className={styles.section}
      aria-labelledby="foundation-skills-title"
    >
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="foundation-skills-title" className={styles.sectionTitle}>
            APEX Foundation Skills
          </h2>
          <p className={styles.sectionHint}>
            Manage versioned foundation skill releases, per-skill audience
            targeting, and consumer repo delivery.
          </p>
        </div>
        <span className={styles.countBadge}>
          {releases.filter((r) => r.status === 'published').length} published
        </span>
      </div>

      {/* Repos tab renders these inline next to the table so they stay in view. */}
      {actionError && activeSection !== 'repos' && (
        <div className={styles.errorMsg} role="alert">
          <div>
            <div>{actionError}</div>
            {actionValidationIssues.length > 0 && (
              <ul className={styles.validationIssueList}>
                {actionValidationIssues.map((issue, index) => (
                  <li
                    key={`${issue.type}-${issue.dependentSkill}-${issue.dependency}-${index}`}
                  >
                    <strong>{issue.message}</strong>
                    <span>{issue.remediation}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {actionMsg && activeSection !== 'repos' && (
        <p className={styles.successMsg} role="status">
          {actionMsg}
        </p>
      )}

      {/* Tab nav */}
      <div className={styles.subNav} role="tablist">
        {(['releases', 'skills', 'teams', 'repos', 'create'] as const).map(
          (s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={activeSection === s}
              className={`${styles.subNavBtn} ${activeSection === s ? styles.subNavBtnActive : ''}`}
              onClick={() => {
                clearMessages();
                setActiveSection(s);
              }}
              {...{ 'data-testid': `fs-tab-${s}` }}
            >
              {SECTION_LABELS[s]}
            </button>
          )
        )}
      </div>

      {/* ── Releases ── */}
      {activeSection === 'releases' && (
        <>
          {relLoading ? (
            <p className={styles.muted}>Loading releases…</p>
          ) : releases.length === 0 ? (
            <div className={styles.emptyState}>
              <p className={styles.emptyStateTitle}>No releases yet</p>
              <p className={styles.emptyStateText}>
                Create your first draft release to bundle foundation skills and
                target them at specific projects.
              </p>
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={() => {
                  clearMessages();
                  setActiveSection('create');
                }}
                {...{ 'data-testid': 'fs-empty-create-draft' }}
              >
                Create draft release
              </button>
            </div>
          ) : (
            <div className={styles.releaseList}>
              {releases.map((r) => {
                const overrideKeys = Object.keys(r.skillTargets ?? {});
                return (
                  <div key={r.id} className={styles.releaseCard}>
                    <div className={styles.releaseCardHeader}>
                      <span className={styles.releaseVersion}>
                        v{r.version}
                      </span>
                      <span
                        className={`${styles.badge} ${statusBadgeClass(r.status)}`}
                      >
                        {r.status}
                      </span>
                      {r.status !== 'draft' && !r.integritySha256 && (
                        <span
                          className={`${styles.badge} ${styles.badgeUnverified}`}
                          title={
                            `Published without Azure Artifacts configured, so @apex/skills@${r.artifactVersion} ` +
                            'was never confirmed to exist on the feed. The CLI warns on a version ' +
                            'mismatch for this release instead of blocking.'
                          }
                          {...{
                            'data-testid': `fs-release-unverified-${r.id}`,
                          }}
                        >
                          unverified
                        </span>
                      )}
                      {r.targetProjects && r.targetProjects.length > 0 ? (
                        <span
                          className={styles.audienceChips}
                          title={r.targetProjects.join(', ')}
                        >
                          {r.targetProjects.slice(0, 3).map((p) => (
                            <span key={p} className={styles.chip}>
                              {p}
                            </span>
                          ))}
                          {r.targetProjects.length > 3 && (
                            <span className={styles.chip}>
                              +{r.targetProjects.length - 3}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span
                          className={`${styles.badge} ${styles.badgeDraft}`}
                        >
                          All projects
                        </span>
                      )}
                      {overrideKeys.length > 0 && (
                        <span
                          className={styles.overrideBadge}
                          title={`Skills with a narrower audience: ${overrideKeys.join(', ')}`}
                        >
                          {overrideKeys.length} override
                          {overrideKeys.length > 1 ? 's' : ''}
                        </span>
                      )}
                      <span className={styles.releaseDate}>
                        {formatTs(r.createdAt)}
                      </span>
                    </div>

                    {r.selectedSkills && r.selectedSkills.length > 0 && (
                      <div className={styles.skillPillsRow}>
                        {r.selectedSkills.slice(0, 8).map((name) => {
                          const override = r.skillTargets?.[name];
                          return (
                            <span
                              key={name}
                              className={`${styles.skillPill} ${override ? styles.skillPillOverride : ''}`}
                              title={
                                override
                                  ? `Audience: ${override.length > 0 ? override.join(', ') : 'all projects'}`
                                  : undefined
                              }
                            >
                              {name}
                            </span>
                          );
                        })}
                        {r.selectedSkills.length > 8 && (
                          <span className={styles.skillPill}>
                            +{r.selectedSkills.length - 8} more
                          </span>
                        )}
                      </div>
                    )}

                    {r.releaseNotes && (
                      <p className={styles.releaseNotes}>
                        {r.releaseNotes.slice(0, 160)}
                      </p>
                    )}
                    {r.breakingChanges && (
                      <p className={styles.breakingChanges}>
                        Breaking: {r.breakingChanges.slice(0, 140)}
                      </p>
                    )}
                    <div className={styles.releaseActions}>
                      {r.status === 'draft' && (
                        <>
                          <button
                            className={styles.btnSuccess}
                            type="button"
                            disabled={publish.isPending}
                            onClick={() => handlePublish(r)}
                            {...{ 'data-testid': `fs-release-publish-${r.id}` }}
                          >
                            Publish
                          </button>
                          <button
                            className={styles.btnDanger}
                            type="button"
                            disabled={deleteDraft.isPending}
                            onClick={() => handleDelete(r)}
                            {...{ 'data-testid': `fs-release-delete-${r.id}` }}
                          >
                            Delete draft
                          </button>
                        </>
                      )}
                      {r.status === 'published' && (
                        <button
                          className={styles.btnSecondary}
                          type="button"
                          disabled={deprecate.isPending}
                          onClick={() => handleDeprecate(r)}
                          {...{ 'data-testid': `fs-release-deprecate-${r.id}` }}
                        >
                          Deprecate
                        </button>
                      )}
                      {r.status !== 'publishing' && (
                        <button
                          className={styles.btnGhost}
                          type="button"
                          onClick={() => {
                            setEditReleaseId(
                              editReleaseId === r.id ? null : r.id
                            );
                            setAuditReleaseId(null);
                          }}
                          {...{ 'data-testid': `fs-release-edit-${r.id}` }}
                        >
                          {editReleaseId === r.id ? 'Cancel' : 'Edit'}
                        </button>
                      )}
                      <button
                        className={styles.btnGhost}
                        type="button"
                        onClick={() => {
                          setAuditReleaseId(
                            auditReleaseId === r.id ? null : r.id
                          );
                          setEditReleaseId(null);
                        }}
                        {...{ 'data-testid': `fs-release-audit-${r.id}` }}
                      >
                        {auditReleaseId === r.id ? 'Hide audit' : 'Audit log'}
                      </button>
                    </div>
                    {editReleaseId === r.id && (
                      <EditReleasePanel
                        release={r}
                        onSave={async (payload) => {
                          clearMessages();
                          try {
                            await updateRelease.mutateAsync({
                              id: r.id,
                              ...payload,
                            });
                            setActionMsg(`v${r.version} updated.`);
                            setEditReleaseId(null);
                          } catch (err: unknown) {
                            setActionError((err as Error).message);
                          }
                        }}
                        onCancel={() => setEditReleaseId(null)}
                        isSaving={updateRelease.isPending}
                        {...{
                          'data-testid': `fs-edit-release-panel-mount-${r.id}`,
                        }}
                      />
                    )}
                    {auditReleaseId === r.id && (
                      <AuditDrawer
                        releaseId={r.id}
                        onClose={() => setAuditReleaseId(null)}
                        {...{ 'data-testid': `fs-audit-drawer-mount-${r.id}` }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {!candLoading && candidates.length > 0 && (
            <div className={styles.candidatesBox}>
              <h3 className={styles.subHeading}>Azure Artifacts candidates</h3>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Published</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.slice(0, 10).map((c) => (
                    <tr key={c.version}>
                      <td>
                        <code>{c.version}</code>
                      </td>
                      <td>{formatTs(c.publishedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── Skills matrix ── */}
      {activeSection === 'skills' && (
        <SkillsMatrixTab {...{ 'data-testid': 'fs-skills-matrix-tab-mount' }} />
      )}

      {/* ── Active teams ── */}
      {activeSection === 'teams' && (
        <TeamsTab {...{ 'data-testid': 'fs-teams-tab-mount' }} />
      )}

      {/* ── Consumer repos ── */}
      {activeSection === 'repos' && (
        <>
          <CompatCheckForm
            {...{ 'data-testid': 'fs-compat-check-form-mount' }}
          />
          <div className={styles.candidatesBox}>
            <div className={styles.matrixToolbar}>
              <h3 className={`${styles.subHeading} ${styles.toolbarHeading}`}>
                Observed consumer repos
              </h3>
              <button
                className={styles.btnSecondary}
                type="button"
                disabled={scanAllRepos.isPending}
                onClick={() => {
                  void handleScanAllRepos();
                }}
                {...{ 'data-testid': 'fs-repos-scan-all' }}
              >
                {scanAllRepos.isPending ? 'Scanning…' : 'Refresh all'}
              </button>
              <span className={`${styles.muted} ${styles.pushRight}`}>
                Re-checks every registered skills repo (same as Teams). Open PR
                is optional — teams normally update via CLI / slash commands.
              </span>
            </div>
            {actionError && activeSection === 'repos' && (
              <p className={styles.errorMsg} role="alert">
                {actionError}
              </p>
            )}
            {actionMsg && activeSection === 'repos' && (
              <p className={styles.successMsg} role="status">
                {actionMsg}
              </p>
            )}
            {repoLoading ? (
              <p className={styles.muted}>Loading repo statuses…</p>
            ) : repoStatuses.length === 0 ? (
              <p className={styles.muted}>
                No consumer repos observed yet. Use Refresh all (registered
                Project Settings repos) or run a compatibility check above.
              </p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Repo</th>
                      <th>Installed</th>
                      <th>Available</th>
                      <th>Compatibility</th>
                      <th>Checked</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {repoStatuses.map((s) => {
                      const rowKey = repoRowKey(s);
                      const isBusy = busyRepoKey === rowKey;
                      return (
                        <tr key={s.id}>
                          <td>
                            <strong>{s.repo}</strong>
                            <br />
                            <small className={styles.muted}>
                              {s.project} · {s.branch}
                            </small>
                          </td>
                          <td>{s.installedVersion ?? '—'}</td>
                          <td>
                            {s.availableVersion ?? '—'}
                            {s.updateAvailable && (
                              <span
                                className={styles.updateDot}
                                title="Update available"
                              />
                            )}
                          </td>
                          <td>
                            <span
                              className={`${styles.badge} ${compatBadgeClass(s.compatibilityStatus ?? 'unknown')}`}
                            >
                              {s.compatibilityStatus ?? 'unknown'}
                            </span>
                          </td>
                          <td>{formatTs(s.compatibilityCheckedAt)}</td>
                          <td>
                            <div className={styles.btnRow}>
                              <button
                                className={`${styles.btnGhost} ${styles.btnSm}`}
                                type="button"
                                disabled={
                                  checkCompat.isPending || updateRepo.isPending
                                }
                                onClick={() => {
                                  void handleCheckCompat(s);
                                }}
                                {...{ 'data-testid': `fs-repo-check-${s.id}` }}
                              >
                                {isBusy && checkCompat.isPending
                                  ? 'Checking…'
                                  : 'Check'}
                              </button>
                              {s.updateAvailable && (
                                <button
                                  className={`${styles.btnSuccess} ${styles.btnSm}`}
                                  type="button"
                                  disabled={
                                    checkCompat.isPending ||
                                    updateRepo.isPending
                                  }
                                  onClick={() => {
                                    void handleUpdateRepo(s);
                                  }}
                                  {...{
                                    'data-testid': `fs-repo-open-pr-${s.id}`,
                                  }}
                                >
                                  {isBusy && updateRepo.isPending
                                    ? 'Opening…'
                                    : 'Open PR'}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Create draft ── */}
      {activeSection === 'create' && (
        <CreateReleaseWizard onCreated={() => setActiveSection('releases')} />
      )}

      {pendingConfirm?.kind === 'deprecate' && (
        <ConfirmActionModal
          title={`Deprecate v${pendingConfirm.release.version}?`}
          body={
            <>
              Mark <strong>v{pendingConfirm.release.version}</strong> as
              deprecated. Teams already on this version can keep using it; new
              installs and updates will no longer offer it.
            </>
          }
          hint="This does not uninstall the package from any consumer repo."
          confirmLabel="Deprecate"
          pendingLabel="Deprecating…"
          tone="warning"
          isPending={deprecate.isPending}
          reasonLabel="Reason (optional)"
          reasonPlaceholder="e.g. superseded by v1.1.0 — broken bootstrap for MaxView"
          onConfirm={(reason) => {
            void executePendingConfirm(reason);
          }}
          onCancel={() => setPendingConfirm(null)}
          {...{ 'data-testid': 'fs-deprecate-modal' }}
        />
      )}

      {pendingConfirm?.kind === 'delete' && (
        <ConfirmActionModal
          title={`Delete draft v${pendingConfirm.release.version}?`}
          body={
            <>
              Permanently delete draft{' '}
              <strong>v{pendingConfirm.release.version}</strong>. This only
              removes the unpublished draft record.
            </>
          }
          hint="This action cannot be undone."
          confirmLabel="Delete draft"
          pendingLabel="Deleting…"
          tone="danger"
          isPending={deleteDraft.isPending}
          onConfirm={() => {
            void executePendingConfirm();
          }}
          onCancel={() => setPendingConfirm(null)}
          {...{ 'data-testid': 'fs-delete-draft-modal' }}
        />
      )}

      {pendingUpdateRepo && (
        <OpenUpdatePrModal
          repo={pendingUpdateRepo}
          isPending={updateRepo.isPending}
          onConfirm={(skillRoot) => {
            const repo = pendingUpdateRepo;
            setPendingUpdateRepo(null);
            void executeUpdateRepo(repo, skillRoot);
          }}
          onCancel={() => setPendingUpdateRepo(null)}
          {...{ 'data-testid': 'fs-update-pr-modal' }}
        />
      )}
    </section>
  );
};
