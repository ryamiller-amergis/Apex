import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  useAllProjectSkillConfigs,
  useUpsertProjectSkillConfig,
  useDeleteProjectSkillConfig,
  useAvailableModels,
  useAvailableBedrockModels,
  useProjectApprovers,
  useSetProjectApprovers,
} from '../hooks/useProjectSkillConfig';
import type { ProjectSkillConfig, UpsertProjectSkillConfigRequest, QuickSkillPill, QuickMcpPill, QuickMcpPillHttp, QuickMcpPillStdio, SkillProvider, InterviewSkillOption, PrototypeEngine, ProjectRepositoryReadiness } from '../../shared/types/projectSettings';
import type { ApprovalMode, ModuleApprovalModes, ReviewerDocumentType } from '../../shared/types/approvals';
import { useSkillRepos, useSkillBranches, useSkillList } from '../hooks/useChatThreads';
import { useUsers } from '../hooks/useRbac';
import { useGroupsWithMembers } from '../hooks/useGroups';
import { GroupAwarePeoplePicker } from './GroupAwarePeoplePicker';
import { useProjectAvailableSkills } from '../hooks/useFoundationSkillAdmin';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import {
  formatRepositoryCheckoutStatusLabel,
  useAdminProjectRepositoryReadiness,
  useCloneProjectRepository,
} from '../hooks/useProjectRepositoryReadiness';
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
       {...{ 'data-testid': 'ps-branch-combo-trigger' }}>
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
        <div className={styles.branchComboDropdown} role="dialog" aria-label="Select branch" {...{ 'data-testid': 'ps-branch-combo-dropdown' }}>
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
              aria-label="Search branches" {...{ 'data-testid': 'ps-branch-combo-search' }} />
            {query && (
              <button
                type="button"
                className={styles.branchComboClear}
                onMouseDown={(e) => { e.preventDefault(); setQuery(''); setActiveIdx(0); searchRef.current?.focus(); }}
                aria-label="Clear search"
               {...{ 'data-testid': 'ps-branch-combo-clear' }}>
                ✕
              </button>
            )}
          </div>

          <div className={styles.branchComboMeta}>
            {query.trim()
              ? `${filtered.length} match${filtered.length !== 1 ? 'es' : ''} of ${branches.length}`
              : `${branches.length} branch${branches.length !== 1 ? 'es' : ''}`}
          </div>

          <div className={styles.branchComboList} ref={listRef} role="listbox" {...{ 'data-testid': 'ps-branch-combo-listbox' }}>
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
                   {...{ 'data-testid': `ps-branch-option-${b}` }}>
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
    <button type="button" className={styles.accordionHeader} onClick={onToggle} aria-expanded={expanded} {...{ 'data-testid': `ps-accordion-toggle-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` }}>
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

// ── Pipeline stage definitions (skill + model co-located) ─────────────────────

type SkillPathKey =
  | 'interviewSkillPath'
  | 'prdSkillPath'
  | 'adrInterviewSkillPath'
  | 'adrFinalizeSkillPath'
  | 'adrAssistantSkillPath'
  | 'designDocSkillPath'
  | 'designDocAssistantSkillPath'
  | 'testCaseSkillPath'
  | 'designDocValidationSkillPath'
  | 'prdValidationSkillPath'
  | 'developmentSkillPath'
  | 'standupSkillPath'
  | 'featureRequestSkillPath'
  | 'technicalSkillPath'
  | 'issueSkillPath'
  | 'loadTestGenerationSkillPath'
  | 'designModuleSkillPath'
  | 'designModuleScopingSkillPath';

type ModelKey =
  | 'interviewModel'
  | 'prdModel'
  | 'adrModel'
  | 'designDocModel'
  | 'designDocAssistantModel'
  | 'testCaseModel'
  | 'designDocValidationModel'
  | 'prdValidationModel'
  | 'developmentModel'
  | 'standupModel'
  | 'featureRequestModel'
  | 'technicalModel'
  | 'issueModel'
  | 'loadTestGenerationModel'
  | 'designModuleModel'
  | 'designModuleScopingModel';

interface PipelineStageDef {
  id: string;
  label: string;
  desc: string;
  skillKey: SkillPathKey;
  emptyLabel: string;
  /** When set, stage card shows a model override next to the skill. */
  modelKey?: ModelKey;
  optional?: boolean;
  /** Nest the interview skill-options editor under this stage. */
  interviewOptions?: boolean;
  /** Nest the PRD validation score threshold under this stage. */
  prdValidationThreshold?: boolean;
  /** Nest the design-doc validation score threshold under this stage. */
  designDocValidationThreshold?: boolean;
}

const FEATURE_PIPELINE_STAGES: PipelineStageDef[] = [
  {
    id: 'interview',
    label: 'Interview',
    desc: 'Guides the stakeholder interview process',
    skillKey: 'interviewSkillPath',
    emptyLabel: 'None (use default)',
    modelKey: 'interviewModel',
    interviewOptions: true,
  },
  {
    id: 'prd',
    label: 'PRD',
    desc: 'Generates the product requirements document',
    skillKey: 'prdSkillPath',
    emptyLabel: 'None (use default)',
    modelKey: 'prdModel',
  },
  {
    id: 'prd-validation',
    label: 'PRD Validation',
    desc: 'Validates PRD spec after all artifacts are ready',
    skillKey: 'prdValidationSkillPath',
    emptyLabel: 'None (skip PRD validation)',
    modelKey: 'prdValidationModel',
    optional: true,
    prdValidationThreshold: true,
  },
  {
    id: 'design-doc',
    label: 'Design Doc',
    desc: 'Produces the technical design document',
    skillKey: 'designDocSkillPath',
    emptyLabel: 'None (use default)',
    modelKey: 'designDocModel',
  },
  {
    id: 'design-assistant',
    label: 'Design Assistant',
    desc: 'Provides AI assistance during design doc editing',
    skillKey: 'designDocAssistantSkillPath',
    emptyLabel: 'None (use default model, no skill)',
    modelKey: 'designDocAssistantModel',
    optional: true,
  },
  {
    id: 'design-validation',
    label: 'Design Validation',
    desc: 'Validates completed design documents',
    skillKey: 'designDocValidationSkillPath',
    emptyLabel: 'None (skip validation phase)',
    modelKey: 'designDocValidationModel',
    optional: true,
    designDocValidationThreshold: true,
  },
  {
    id: 'test-cases',
    label: 'Test Cases',
    desc: 'Generates QA test cases after PRD generation',
    skillKey: 'testCaseSkillPath',
    emptyLabel: 'None (skip test-case generation)',
    modelKey: 'testCaseModel',
    optional: true,
  },
  {
    id: 'development',
    label: 'Development',
    desc: 'Guides the AI coding agent during development sessions',
    skillKey: 'developmentSkillPath',
    emptyLabel: 'None (use default behavior)',
    modelKey: 'developmentModel',
    optional: true,
  },
];

const ADR_PIPELINE_STAGES: PipelineStageDef[] = [
  {
    id: 'adr-interview',
    label: 'ADR Interview',
    desc: 'Guides repository-grounded architecture decision interviews',
    skillKey: 'adrInterviewSkillPath',
    emptyLabel: 'None (use adr-interview default)',
  },
  {
    id: 'adr-finalize',
    label: 'ADR Finalize',
    desc: 'Generates the final MADR document',
    skillKey: 'adrFinalizeSkillPath',
    emptyLabel: 'None (use adr-finalize default)',
  },
  {
    id: 'adr-assistant',
    label: 'ADR Assistant',
    desc: 'Guides repository-grounded refinement of proposed ADRs',
    skillKey: 'adrAssistantSkillPath',
    emptyLabel: 'Default (.agents/skills/adr-assistant/SKILL.md)',
    optional: true,
  },
];

const SIDECAR_STAGES: PipelineStageDef[] = [
  {
    id: 'standup',
    label: 'Standup',
    desc: 'Custom standup procedure for participant conversations',
    skillKey: 'standupSkillPath',
    emptyLabel: 'None (use built-in default)',
    modelKey: 'standupModel',
  },
  {
    id: 'feature-request',
    label: 'Feature Request Analysis',
    desc: 'Analyzes feature requests for feasibility and impact',
    skillKey: 'featureRequestSkillPath',
    emptyLabel: 'None (use default)',
    modelKey: 'featureRequestModel',
  },
  {
    id: 'technical',
    label: 'Technical Analysis',
    desc: 'Analyzes technical backlog items for approach and engineering risk',
    skillKey: 'technicalSkillPath',
    emptyLabel: 'None (analysis unavailable)',
    modelKey: 'technicalModel',
  },
  {
    id: 'issue',
    label: 'Issue Analysis',
    desc: 'Analyzes reported issues for impact, severity, and urgency',
    skillKey: 'issueSkillPath',
    emptyLabel: 'None (analysis unavailable)',
    modelKey: 'issueModel',
  },
  {
    id: 'load-test',
    label: 'Load Test Generation',
    desc: 'Generates k6 load-test scripts and suggested thresholds from a requirement',
    skillKey: 'loadTestGenerationSkillPath',
    emptyLabel: 'Default (.cursor/skills/k6-load-test-generation/SKILL.md)',
    modelKey: 'loadTestGenerationModel',
  },
  {
    id: 'design-module',
    label: 'Design Module',
    desc: 'Generates Architecture Explorer module documents from curated source globs',
    skillKey: 'designModuleSkillPath',
    emptyLabel: 'Default (.agents/skills/design-module-doc/SKILL.md)',
    modelKey: 'designModuleModel',
  },
  {
    id: 'design-module-scoping',
    label: 'Design Module Scoping',
    desc: 'Proposes repository sourceGlobs for a Design Module from name and description',
    skillKey: 'designModuleScopingSkillPath',
    emptyLabel: 'Default (.cursor/skills/design-module-scoping/SKILL.md)',
    modelKey: 'designModuleScopingModel',
  },
];

function countConfiguredStages(
  stages: PipelineStageDef[],
  edit: Record<SkillPathKey, string>,
): number {
  return stages.filter((s) => Boolean(edit[s.skillKey])).length;
}

function skillDisplayName(
  path: string,
  skillList: { path: string; name: string }[],
): string {
  if (!path) return 'None';
  return skillList.find((s) => s.path === path)?.name ?? path;
}

// ── Pipeline flow strip ───────────────────────────────────────────────────────

interface PipelineFlowProps {
  stages: PipelineStageDef[];
}

const PipelineFlow: React.FC<PipelineFlowProps> = ({ stages }) => {
  const core = stages.filter((s) => !s.optional);
  return (
    <div className={styles.pipelineFlow} aria-hidden="true">
      {core.map((stage, index) => (
        <React.Fragment key={stage.id}>
          <span className={styles.pipelineFlowStep}>{stage.label}</span>
          {index < core.length - 1 && <span className={styles.pipelineFlowArrow}>→</span>}
        </React.Fragment>
      ))}
      {stages.some((s) => s.optional) && (
        <span className={styles.pipelineFlowHint}>+ optional stages below</span>
      )}
    </div>
  );
};

interface InterviewOptionsEditorProps {
  options: InterviewSkillOption[];
  skillList: { id: string; path: string; name: string }[];
  availableModels: { id: string; displayName: string }[];
  disabled: boolean;
  skillsDisabled: boolean;
  onChange: (options: InterviewSkillOption[]) => void;
}

const InterviewOptionsEditor: React.FC<InterviewOptionsEditorProps> = ({
  options,
  skillList,
  availableModels,
  disabled,
  skillsDisabled,
  onChange,
}) => (
  <div className={styles.interviewOptions}>
    <div className={styles.interviewOptionsHeader}>
      <div>
        <div className={styles.interviewOptionsTitle}>Interview skill options</div>
        <span className={styles.skillDescription}>
          Define the interview skills available to users when starting an interview.
        </span>
      </div>
      <button
        type="button"
        className={styles.btnAction}
        onClick={() => onChange([...options, {
          path: '',
          friendlyName: '',
          wantsDesignPrototype: true,
          wantsTestCases: true,
        }])}
        disabled={disabled || skillsDisabled}
       {...{ 'data-testid': 'ps-interview-option-add' }}>
        + Add option
      </button>
    </div>
    {options.map((opt, idx) => (
      <div key={idx} className={styles.interviewOptionBlock}>
        <div className={styles.interviewOptionRow}>
          <select
            className={styles.select}
            value={opt.path}
            onChange={(e) => {
              const next = [...options];
              next[idx] = { ...next[idx], path: e.target.value };
              onChange(next);
            }}
            disabled={disabled || skillsDisabled}
           {...{ 'data-testid': `ps-interview-option-skill-${idx}` }}>
            <option value="">— select a skill —</option>
            {skillList.map((s) => (
              <option key={s.id} value={s.path}>{s.name}</option>
            ))}
          </select>
          <input
            className={styles.input}
            placeholder="Friendly name (shown to users)"
            value={opt.friendlyName}
            onChange={(e) => {
              const next = [...options];
              next[idx] = { ...next[idx], friendlyName: e.target.value };
              onChange(next);
            }}
            disabled={disabled} {...{ 'data-testid': `ps-interview-option-name-${idx}` }} />
          <button
            type="button"
            className={`${styles.btnAction} ${styles.btnActionDanger}`}
            onClick={() => onChange(options.filter((_, i) => i !== idx))}
            disabled={disabled}
            title="Remove"
           {...{ 'data-testid': `ps-interview-option-remove-${idx}` }}>
            Remove
          </button>
        </div>
        <div className={styles.interviewOptionRow}>
          <select
            className={styles.select}
            value={opt.model ?? ''}
            onChange={(e) => {
              const next = [...options];
              next[idx] = { ...next[idx], model: e.target.value || null };
              onChange(next);
            }}
            disabled={disabled}
           {...{ 'data-testid': `ps-interview-option-model-${idx}` }}>
            <option value="">Model: use project default</option>
            {availableModels.map((m) => (
              <option key={m.id} value={m.id}>{m.displayName}</option>
            ))}
          </select>
        </div>
        <div className={styles.interviewOptionFlags}>
          <label className={styles.interviewOptionFlag} htmlFor={`iso-proto-${idx}`}>
            <input
              id={`iso-proto-${idx}`}
              type="checkbox"
              checked={opt.wantsDesignPrototype !== false}
              onChange={(e) => {
                const next = [...options];
                next[idx] = { ...next[idx], wantsDesignPrototype: e.target.checked };
                onChange(next);
              }}
              disabled={disabled} {...{ 'data-testid': `ps-interview-option-prototype-${idx}` }} />
            Generate design prototype
          </label>
          <label className={styles.interviewOptionFlag} htmlFor={`iso-tc-${idx}`}>
            <input
              id={`iso-tc-${idx}`}
              type="checkbox"
              checked={opt.wantsTestCases !== false}
              onChange={(e) => {
                const next = [...options];
                next[idx] = { ...next[idx], wantsTestCases: e.target.checked };
                onChange(next);
              }}
              disabled={disabled} {...{ 'data-testid': `ps-interview-option-testcases-${idx}` }} />
            Generate test cases
          </label>
        </div>
      </div>
    ))}
  </div>
);

// ── McpPillAddForm ─────────────────────────────────────────────────────────────

interface McpPillAddFormProps {
  availableModels: { id: string; displayName: string }[];
  isLoadingModels: boolean;
  isPending: boolean;
  onAdd: (pill: QuickMcpPill) => void;
}

const McpPillAddForm: React.FC<McpPillAddFormProps> = ({ availableModels, isLoadingModels, isPending, onAdd }) => {
  const [transport, setTransport] = useState<'http' | 'stdio'>('stdio');
  const [label, setLabel] = useState('');
  const [mcpServerName, setMcpServerName] = useState('');
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('npx');
  const [args, setArgs] = useState('-y sendgrid-mcp');
  const [envStr, setEnvStr] = useState('SENDGRID_API_KEY=${SENDGRID_API_KEY}');
  const [model, setModel] = useState('');
  const [systemPromptHint, setSystemPromptHint] = useState('');
  const [description, setDescription] = useState('');

  const handleAdd = () => {
    const trimmedLabel = label.trim();
    const trimmedName = mcpServerName.trim();
    if (!trimmedLabel || !trimmedName) return;

    const base = {
      label: trimmedLabel,
      mcpServerName: trimmedName,
      model: model || null,
      systemPromptHint: systemPromptHint.trim() || null,
      description: description.trim() || null,
    };

    if (transport === 'http') {
      if (!url.trim()) return;
      const pill: QuickMcpPillHttp = { ...base, transport: 'http', url: url.trim() };
      onAdd(pill);
    } else {
      if (!command.trim()) return;
      const parsedArgs = args.trim() ? args.trim().split(/\s+/) : [];
      const parsedEnv: Record<string, string> = {};
      for (const pair of envStr.split(',')) {
        const eq = pair.indexOf('=');
        if (eq > 0) parsedEnv[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      }
      const pill: QuickMcpPillStdio = {
        ...base,
        transport: 'stdio',
        command: command.trim(),
        args: parsedArgs.length ? parsedArgs : null,
        env: Object.keys(parsedEnv).length ? parsedEnv : null,
      };
      onAdd(pill);
    }

    setLabel('');
    setMcpServerName('');
    setUrl('');
    setCommand('npx');
    setArgs('-y sendgrid-mcp');
    setEnvStr('SENDGRID_API_KEY=${SENDGRID_API_KEY}');
    setModel('');
    setSystemPromptHint('');
    setDescription('');
  };

  return (
    <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {/* Transport toggle */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 500 }}>Transport:</span>
        {(['stdio', 'http'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={`${styles.btnAction} ${transport === t ? styles.transportActive : ''}`}
            style={{ padding: '2px 10px', fontSize: '0.78rem' }}
            onClick={() => setTransport(t)}
            disabled={isPending}
           {...{ 'data-testid': `ps-mcp-add-transport-${t}` }}>
            {t === 'stdio' ? 'stdio (npx / command)' : 'HTTP (hosted URL)'}
          </button>
        ))}
      </div>

      {/* Common fields */}
      <div className={styles.pillAddRow}>
        <div className={styles.field} style={{ flex: '0 0 10rem' }}>
          <label className={styles.label}>Label</label>
          <input className={styles.input} placeholder="e.g. SendGrid" value={label} onChange={(e) => setLabel(e.target.value)} disabled={isPending} {...{ 'data-testid': 'ps-mcp-add-label' }} />
        </div>
        <div className={styles.field} style={{ flex: '0 0 10rem' }}>
          <label className={styles.label}>Server Name</label>
          <input className={styles.input} placeholder="e.g. sendgrid" value={mcpServerName} onChange={(e) => setMcpServerName(e.target.value)} disabled={isPending} {...{ 'data-testid': 'ps-mcp-add-server-name' }} />
        </div>
        <div className={styles.field} style={{ flex: '0 0 10rem' }}>
          <label className={styles.label}>Model override</label>
          <select className={styles.select} value={model} onChange={(e) => setModel(e.target.value)} disabled={isPending || isLoadingModels} {...{ 'data-testid': 'ps-mcp-add-model' }}>
            <option value="">Default model</option>
            {availableModels.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
          </select>
        </div>
      </div>

      {/* Transport-specific fields */}
      {transport === 'http' ? (
        <input className={styles.input} placeholder="HTTP URL (e.g. https://mcp.twilio.com/docs)" value={url} onChange={(e) => setUrl(e.target.value)} disabled={isPending} {...{ 'data-testid': 'ps-mcp-add-url' }} />
      ) : (
        <>
          <div className={styles.pillAddRow}>
            <div className={styles.field} style={{ flex: '0 0 8rem' }}>
              <label className={styles.label}>Command</label>
              <input className={styles.input} placeholder="npx" value={command} onChange={(e) => setCommand(e.target.value)} disabled={isPending} {...{ 'data-testid': 'ps-mcp-add-command' }} />
            </div>
            <div className={styles.field} style={{ flex: 1 }}>
              <label className={styles.label}>Args (space-separated)</label>
              <input className={styles.input} placeholder="-y sendgrid-mcp" value={args} onChange={(e) => setArgs(e.target.value)} disabled={isPending} {...{ 'data-testid': 'ps-mcp-add-args' }} />
            </div>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Env vars (KEY=$&#123;ENV_VAR&#125;, comma-separated)</label>
            <input className={styles.input} placeholder="SENDGRID_API_KEY=${SENDGRID_API_KEY}" value={envStr} onChange={(e) => setEnvStr(e.target.value)} disabled={isPending} {...{ 'data-testid': 'ps-mcp-add-env' }} />
            <span className={styles.skillDescription}>Values like {'${SENDGRID_API_KEY}'} are resolved from the server&apos;s environment at runtime — secrets stay out of the database.</span>
          </div>
        </>
      )}

      {/* Optional metadata */}
      <input className={styles.input} style={{ fontSize: '0.8rem' }} placeholder="System prompt hint (e.g. You have access to SendGrid email analytics tools for querying email activity, bounces, and stats)" value={systemPromptHint} onChange={(e) => setSystemPromptHint(e.target.value)} disabled={isPending} {...{ 'data-testid': 'ps-mcp-add-system-prompt' }} />
      <input className={styles.input} style={{ fontSize: '0.8rem' }} placeholder="Description shown to users when pill is selected" value={description} onChange={(e) => setDescription(e.target.value)} disabled={isPending} {...{ 'data-testid': 'ps-mcp-add-description' }} />

      <div>
        <button type="button" className={styles.btnAction} onClick={handleAdd} disabled={isPending} {...{ 'data-testid': 'ps-mcp-pill-add-submit' }}>
          Add MCP Pill
        </button>
      </div>
    </div>
  );
};

// ── InterviewWebMcpEditor ──────────────────────────────────────────────────────
// Compact editor for a single web-search MCP server wired into interview threads
// when live web research is enabled. Mount with a `key` tied to the config id so
// local draft state re-seeds when switching between rows.

interface InterviewWebMcpEditorProps {
  value: QuickMcpPill | null;
  isPending: boolean;
  onChange: (pill: QuickMcpPill | null) => void;
}

const parseKvPairs = (s: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const pair of s.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
};

const InterviewWebMcpEditor: React.FC<InterviewWebMcpEditorProps> = ({ value, isPending, onChange }) => {
  const [transport, setTransport] = useState<'http' | 'stdio'>(value?.transport ?? 'stdio');
  const [mcpServerName, setMcpServerName] = useState(value?.mcpServerName ?? 'web');
  const [url, setUrl] = useState(value?.transport === 'http' ? value.url : 'https://mcp.tavily.com/mcp/');
  const [headersStr, setHeadersStr] = useState(
    value?.transport === 'http'
      ? Object.entries(value.headers ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')
      : 'Authorization=Bearer ${TAVILY_API_KEY}',
  );
  const [command, setCommand] = useState(value?.transport === 'stdio' ? value.command : 'npx');
  const [args, setArgs] = useState(value?.transport === 'stdio' ? (value.args ?? []).join(' ') : '-y tavily-mcp');
  const [envStr, setEnvStr] = useState(
    value?.transport === 'stdio'
      ? Object.entries(value.env ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')
      : 'TAVILY_API_KEY=${TAVILY_API_KEY}',
  );
  const [systemPromptHint, setSystemPromptHint] = useState(
    value?.systemPromptHint ?? 'Use the web-search tools for live product, market, competitor, and UX research to sharpen requirements during this interview.',
  );

  useEffect(() => {
    const name = mcpServerName.trim();
    if (!name) { onChange(null); return; }
    const base = {
      label: 'Web Research',
      mcpServerName: name,
      systemPromptHint: systemPromptHint.trim() || null,
    };
    if (transport === 'http') {
      if (!url.trim()) { onChange(null); return; }
      const headers = parseKvPairs(headersStr);
      onChange({ ...base, transport: 'http', url: url.trim(), headers: Object.keys(headers).length ? headers : null });
    } else {
      if (!command.trim()) { onChange(null); return; }
      const parsedArgs = args.trim() ? args.trim().split(/\s+/) : [];
      const env = parseKvPairs(envStr);
      onChange({ ...base, transport: 'stdio', command: command.trim(), args: parsedArgs.length ? parsedArgs : null, env: Object.keys(env).length ? env : null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, mcpServerName, url, headersStr, command, args, envStr, systemPromptHint]);

  return (
    <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 500 }}>Transport:</span>
        {(['stdio', 'http'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={`${styles.btnAction} ${transport === t ? styles.transportActive : ''}`}
            style={{ padding: '2px 10px', fontSize: '0.78rem' }}
            onClick={() => setTransport(t)}
            disabled={isPending}
           {...{ 'data-testid': `ps-web-mcp-transport-${t}` }}>
            {t === 'stdio' ? 'stdio (npx / command)' : 'HTTP (hosted URL)'}
          </button>
        ))}
      </div>

      <div className={styles.field} style={{ flex: '0 0 10rem' }}>
        <label className={styles.label}>Server Name</label>
        <input className={styles.input} placeholder="e.g. web" value={mcpServerName} onChange={(e) => setMcpServerName(e.target.value)} disabled={isPending} {...{ 'data-testid': 'ps-web-mcp-server-name' }} />
      </div>

      {transport === 'http' ? (
        <>
          <div className={styles.field}>
            <label className={styles.label}>HTTP URL</label>
            <input className={styles.input} placeholder="https://mcp.tavily.com/mcp/" value={url} onChange={(e) => setUrl(e.target.value)} disabled={isPending} {...{ 'data-testid': 'ps-web-mcp-url' }} />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Headers (KEY=$&#123;ENV_VAR&#125;, comma-separated)</label>
            <input className={styles.input} placeholder="Authorization=Bearer ${TAVILY_API_KEY}" value={headersStr} onChange={(e) => setHeadersStr(e.target.value)} disabled={isPending} {...{ 'data-testid': 'ps-web-mcp-headers' }} />
            <span className={styles.skillDescription}>Values like {'${TAVILY_API_KEY}'} are resolved from the server&apos;s environment at runtime — secrets stay out of the database.</span>
          </div>
        </>
      ) : (
        <>
          <div className={styles.pillAddRow}>
            <div className={styles.field} style={{ flex: '0 0 8rem' }}>
              <label className={styles.label}>Command</label>
              <input className={styles.input} placeholder="npx" value={command} onChange={(e) => setCommand(e.target.value)} disabled={isPending} {...{ 'data-testid': 'ps-web-mcp-command' }} />
            </div>
            <div className={styles.field} style={{ flex: 1 }}>
              <label className={styles.label}>Args (space-separated)</label>
              <input className={styles.input} placeholder="-y tavily-mcp" value={args} onChange={(e) => setArgs(e.target.value)} disabled={isPending} {...{ 'data-testid': 'ps-web-mcp-args' }} />
            </div>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Env vars (KEY=$&#123;ENV_VAR&#125;, comma-separated)</label>
            <input className={styles.input} placeholder="TAVILY_API_KEY=${TAVILY_API_KEY}" value={envStr} onChange={(e) => setEnvStr(e.target.value)} disabled={isPending} {...{ 'data-testid': 'ps-web-mcp-env' }} />
            <span className={styles.skillDescription}>Values like {'${TAVILY_API_KEY}'} are resolved from the server&apos;s environment at runtime — secrets stay out of the database.</span>
          </div>
        </>
      )}

      <div className={styles.field}>
        <label className={styles.label}>System prompt hint</label>
        <input className={styles.input} style={{ fontSize: '0.8rem' }} placeholder="Describe what the web MCP is for" value={systemPromptHint} onChange={(e) => setSystemPromptHint(e.target.value)} disabled={isPending} {...{ 'data-testid': 'ps-web-mcp-system-prompt' }} />
      </div>
    </div>
  );
};

// ── Main component ─────────────────────────────────────────────────────────────

interface AdminProjectSettingsProps {
  selectedProject?: string;
  availableProjects?: string[];
}

interface EditState {
  id: string | null;
  project: string;
  friendlyName: string;
  isDefault: boolean;
  skillProvider: SkillProvider;
  skillRepo: string;
  skillBranch: string;
  interviewSkillPath: string;
  prdSkillPath: string;
  adrInterviewSkillPath: string;
  adrFinalizeSkillPath: string;
  adrAssistantSkillPath: string;
  designDocSkillPath: string;
  designDocAssistantSkillPath: string;
  designPrototypeSkillPath: string;
  testCaseSkillPath: string;
  designDocValidationSkillPath: string;
  prdValidationSkillPath: string;
  developmentSkillPath: string;
  standupSkillPath: string;
  featureRequestSkillPath: string;
  technicalSkillPath: string;
  issueSkillPath: string;
  loadTestGenerationSkillPath: string;
  designModuleSkillPath: string;
  designModuleScopingSkillPath: string;
  interviewModel: string;
  prdModel: string;
  adrModel: string;
  designDocModel: string;
  designDocAssistantModel: string;
  designPrototypeModel: string;
  testCaseModel: string;
  designDocValidationModel: string;
  prdValidationModel: string;
  developmentModel: string;
  standupModel: string;
  featureRequestModel: string;
  technicalModel: string;
  issueModel: string;
  loadTestGenerationModel: string;
  designModuleModel: string;
  designModuleScopingModel: string;
  defaultModel: string;
  prdReviewBedrockModelId: string;
  prdReviewBedrockMaxTokens: number;
  designPrototypeBedrockModelId: string;
  designPrototypeBedrockMaxTokens: number;
  designPrototypeBedrockTimeoutMs: number;
  designPrototypeRegenBedrockModelId: string;
  designPrototypeRegenBedrockMaxTokens: number;
  designPlanBedrockModelId: string;
  designPlanBedrockMaxTokens: number;
  prdValidationScoreThreshold: number;
  designDocValidationScoreThreshold: number;
  uiLabBedrockModelId: string;
  uiLabBedrockMaxTokens: number;
  uiLabBedrockTimeoutMs: number;
  uiLabRegenBedrockModelId: string;
  uiLabRegenBedrockMaxTokens: number;
  uiLabBedrockTemperature: number;
  interviewSkillOptions: InterviewSkillOption[];
  prototypeStageEnabled: boolean;
  interviewWebResearchEnabled: boolean;
  interviewWebMcp: QuickMcpPill | null;
  prototypeEngine: PrototypeEngine;
  prototypeDesignSystemPath: string;
  screenInventoryPath: string;
  prototypeWebReferencesEnabled: boolean;
  quickSkillPills: QuickSkillPill[];
  quickMcpPills: QuickMcpPill[];
  approvalMode: ApprovalMode;
  approvalModes: ModuleApprovalModes;
  isNew: boolean;
}

const emptyEdit = (): EditState => ({
  id: null, project: '', friendlyName: '', isDefault: false,
  skillProvider: 'ado', skillRepo: '', skillBranch: '',
  interviewSkillPath: '', prdSkillPath: '', designDocSkillPath: '',
  adrInterviewSkillPath: '', adrFinalizeSkillPath: '', adrAssistantSkillPath: '',
  designDocAssistantSkillPath: '', designPrototypeSkillPath: '', testCaseSkillPath: '', designDocValidationSkillPath: '', prdValidationSkillPath: '',
  developmentSkillPath: '', standupSkillPath: '', featureRequestSkillPath: '',
  technicalSkillPath: '', issueSkillPath: '', loadTestGenerationSkillPath: '', designModuleSkillPath: '',
  designModuleScopingSkillPath: '',
  interviewModel: '', prdModel: '', designDocModel: '',
  adrModel: '',
  designDocAssistantModel: '', designPrototypeModel: '', testCaseModel: '', designDocValidationModel: '', prdValidationModel: '',
  developmentModel: '', standupModel: '', featureRequestModel: '',
  technicalModel: '', issueModel: '', loadTestGenerationModel: '', designModuleModel: '',
  designModuleScopingModel: '',
  defaultModel: '',
  prdReviewBedrockModelId: '',
  prdReviewBedrockMaxTokens: 16000,
  designPrototypeBedrockModelId: '',
  designPrototypeBedrockMaxTokens: 16000,
  designPrototypeBedrockTimeoutMs: 720000,
  designPrototypeRegenBedrockModelId: '',
  designPrototypeRegenBedrockMaxTokens: 16000,
  designPlanBedrockModelId: '',
  designPlanBedrockMaxTokens: 4000,
  prdValidationScoreThreshold: 90,
  designDocValidationScoreThreshold: 90,
  uiLabBedrockModelId: '',
  uiLabBedrockMaxTokens: 16000,
  uiLabBedrockTimeoutMs: 600000,
  uiLabRegenBedrockModelId: '',
  uiLabRegenBedrockMaxTokens: 16000,
  uiLabBedrockTemperature: 0,
  quickSkillPills: [], quickMcpPills: [], approvalMode: 'any_one',
  approvalModes: {
    prd: 'any_one',
    design_doc: 'any_one',
    design_prototype: 'any_one',
    test_case: 'any_one',
    adr: 'any_one',
  },
  isNew: true,
  interviewSkillOptions: [], prototypeStageEnabled: true,
  interviewWebResearchEnabled: false, interviewWebMcp: null, prototypeEngine: 'bedrock',
  prototypeDesignSystemPath: '', screenInventoryPath: '', prototypeWebReferencesEnabled: false,
});

// ── Pipeline stage card ───────────────────────────────────────────────────────

interface PipelineStageCardProps {
  stage: PipelineStageDef;
  edit: EditState;
  skillList: { id: string; path: string; name: string }[];
  availableModels: { id: string; displayName: string }[];
  expanded: boolean;
  onToggle: () => void;
  onEditChange: (patch: Partial<EditState>) => void;
  disabled: boolean;
  skillsDisabled: boolean;
  modelsDisabled: boolean;
}

const PipelineStageCard: React.FC<PipelineStageCardProps> = ({
  stage,
  edit,
  skillList,
  availableModels,
  expanded,
  onToggle,
  onEditChange,
  disabled,
  skillsDisabled,
  modelsDisabled,
}) => {
  const skillValue = edit[stage.skillKey];
  const modelValue = stage.modelKey ? edit[stage.modelKey] : '';
  const defaultModelLabel = edit.defaultModel
    ? availableModels.find((m) => m.id === edit.defaultModel)?.displayName ?? edit.defaultModel
    : 'system default (composer-2)';

  return (
    <div className={styles.stageCard} {...{ 'data-testid': `ps-stage-${stage.skillKey}` }}>
      <button
        type="button"
        className={styles.stageCardHeader}
        onClick={onToggle}
        aria-expanded={expanded}
       {...{ 'data-testid': `ps-stage-toggle-${stage.skillKey}` }}>
        <svg
          className={`${styles.stageCardChevron} ${expanded ? styles.stageCardChevronOpen : ''}`}
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
        <span className={styles.stageCardTitle}>
          {stage.label}
          {stage.optional ? <span className={styles.stageCardOptional}>optional</span> : null}
        </span>
        <span className={styles.stageCardHint}>
          {skillDisplayName(skillValue, skillList)}
        </span>
      </button>
      {expanded && (
        <div className={styles.stageCardBody}>
          <p className={styles.skillDescription}>{stage.desc}</p>
          {!stage.interviewOptions && (
            <div className={stage.modelKey ? styles.stageFieldGrid : styles.stageFieldSingle}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor={`ps-${stage.skillKey}`}>Skill</label>
                <select
                  id={`ps-${stage.skillKey}`}
                  className={styles.select}
                  value={skillValue}
                  onChange={(e) => onEditChange({ [stage.skillKey]: e.target.value })}
                  disabled={disabled || skillsDisabled}
                 {...{ 'data-testid': `ps-stage-skill-${stage.skillKey}` }}>
                  <option value="">{stage.emptyLabel}</option>
                  {skillList.map((s) => (
                    <option key={s.id} value={s.path}>{s.name}</option>
                  ))}
                </select>
              </div>
              {stage.modelKey && (
                <div className={styles.field}>
                  <label className={styles.label} htmlFor={`ps-${stage.modelKey}`}>Model override</label>
                  <select
                    id={`ps-${stage.modelKey}`}
                    className={styles.select}
                    value={modelValue}
                    onChange={(e) => onEditChange({ [stage.modelKey!]: e.target.value })}
                    disabled={disabled || modelsDisabled}
                   {...{ 'data-testid': `ps-stage-model-${stage.modelKey}` }}>
                    <option value="">Use project default</option>
                    {availableModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.displayName}</option>
                    ))}
                  </select>
                  {!modelValue && (
                    <span className={styles.modelDefault}>Using: {defaultModelLabel}</span>
                  )}
                </div>
              )}
            </div>
          )}
          {stage.interviewOptions && (
            <InterviewOptionsEditor
              options={edit.interviewSkillOptions}
              skillList={skillList}
              availableModels={availableModels}
              disabled={disabled}
              skillsDisabled={skillsDisabled}
              onChange={(options) => onEditChange({ interviewSkillOptions: options })} {...{ 'data-testid': 'ps-interview-options-editor' }} />
          )}
          {stage.prdValidationThreshold && (
            <div className={styles.field} style={{ marginTop: '12px' }}>
              <label className={styles.label} htmlFor="ps-validation-threshold">
                Pass threshold (%)
              </label>
              <span className={styles.skillDescription}>
                Minimum validation score required for a PRD to pass the readiness gate. Defaults to 90%.
              </span>
              <select
                id="ps-validation-threshold"
                className={styles.select}
                value={String(edit.prdValidationScoreThreshold)}
                onChange={(e) => onEditChange({ prdValidationScoreThreshold: Number(e.target.value) })}
                disabled={disabled}
               {...{ 'data-testid': 'ps-validation-threshold' }}>
                <option value="50">50%</option>
                <option value="60">60%</option>
                <option value="70">70%</option>
                <option value="75">75%</option>
                <option value="80">80%</option>
                <option value="85">85%</option>
                <option value="90">90% (default)</option>
                <option value="95">95%</option>
                <option value="100">100%</option>
              </select>
            </div>
          )}
          {stage.designDocValidationThreshold && (
            <div className={styles.field} style={{ marginTop: '12px' }}>
              <label className={styles.label} htmlFor="ps-dd-validation-threshold">
                Pass threshold (%)
              </label>
              <span className={styles.skillDescription}>
                Minimum validation score required for a design doc to pass the readiness gate. Defaults to 90%.
              </span>
              <select
                id="ps-dd-validation-threshold"
                className={styles.select}
                value={String(edit.designDocValidationScoreThreshold)}
                onChange={(e) => onEditChange({ designDocValidationScoreThreshold: Number(e.target.value) })}
                disabled={disabled}
               {...{ 'data-testid': 'ps-dd-validation-threshold' }}>
                <option value="50">50%</option>
                <option value="60">60%</option>
                <option value="70">70%</option>
                <option value="75">75%</option>
                <option value="80">80%</option>
                <option value="85">85%</option>
                <option value="90">90% (default)</option>
                <option value="95">95%</option>
                <option value="100">100%</option>
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function readinessFromConfig(config: ProjectSkillConfig): ProjectRepositoryReadiness {
  return {
    skillSettingsId: config.id,
    status: config.repositoryCheckoutStatus ?? 'not_cloned',
    sha: config.repositoryCheckoutSha ?? null,
    error: config.repositoryCheckoutError ?? null,
    startedAt: config.repositoryCheckoutStartedAt ?? null,
    completedAt: config.repositoryCheckoutCompletedAt ?? null,
    filesystemReady: config.repositoryCheckoutStatus === 'ready',
  };
}

interface RepoCheckoutControlsProps {
  config: ProjectSkillConfig;
}

/** Clone / Refresh controls for a saved Project Skill Settings repository row. */
const RepoCheckoutControlsEnabled: React.FC<RepoCheckoutControlsProps> = ({ config }) => {
  const { data: readiness, isFetching } = useAdminProjectRepositoryReadiness(config.id);
  const clone = useCloneProjectRepository();
  const display = readiness ?? readinessFromConfig(config);
  const status = display.status;
  const isCloning = status === 'cloning' || clone.isPending;
  const showClone = status === 'not_cloned' || status === 'snapshot_unavailable';
  // Ready: interviews already fetch the tip. Refresh only retries Failed.
  const showRefresh = status === 'failed';
  const label = isCloning && !readiness
    ? 'Cloning'
    : formatRepositoryCheckoutStatusLabel(display);

  return (
    <div className={styles.repoCheckout} {...{ 'data-testid': `repo-checkout-status-${config.id}` }}>
      <span
        className={`${styles.repoCheckoutStatus} ${status === 'failed' ? styles.repoCheckoutStatusFailed : ''}`}
        title={display.error ?? undefined}
      >
        {label}
        {isFetching && status === 'cloning' ? '…' : ''}
      </span>
      {status === 'failed' && display.error && (
        <span className={styles.repoCheckoutError} title={display.error}>
          {display.error}
        </span>
      )}
      <div className={styles.repoCheckoutActions}>
        {showClone && (
          <button
            className={styles.btnAction}
            type="button"
            disabled={isCloning || clone.isPending}
            onClick={() => void clone.mutateAsync({ id: config.id, refresh: false }).catch(() => undefined)}
            {...{ 'data-testid': `repo-checkout-clone-${config.id}` }}
          >
            {clone.isPending && !clone.variables?.refresh ? 'Cloning…' : 'Clone'}
          </button>
        )}
        {showRefresh && (
          <button
            className={styles.btnAction}
            type="button"
            disabled={isCloning || clone.isPending}
            onClick={() => void clone.mutateAsync({ id: config.id, refresh: true }).catch(() => undefined)}
            {...{ 'data-testid': `repo-checkout-refresh-${config.id}` }}
          >
            {clone.isPending && clone.variables?.refresh ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      </div>
    </div>
  );
};

const RepoCheckoutControls: React.FC<RepoCheckoutControlsProps & { project: string }> = ({
  config,
  project,
}) => {
  const enabled = useFeatureFlag('project-repository-checkout-readiness', project);

  // Retain enabled after two stable sprints at full rollout.
  // @feature-flag:project-repository-checkout-readiness start winner=enabled
  if (!enabled) {
    // @feature-flag:project-repository-checkout-readiness disabled-start
    return null;
    // @feature-flag:project-repository-checkout-readiness disabled-end
  }

  // @feature-flag:project-repository-checkout-readiness enabled-start
  return <RepoCheckoutControlsEnabled config={config} />;
  // @feature-flag:project-repository-checkout-readiness enabled-end
  // @feature-flag:project-repository-checkout-readiness end
};

export const AdminProjectSettings: React.FC<AdminProjectSettingsProps> = ({
  selectedProject = '',
}) => {
  // ── Data hooks ─────────────────────────────────────────────────────────
  const { data: configs = [], isLoading, isError } = useAllProjectSkillConfigs();
  const upsert = useUpsertProjectSkillConfig();
  const remove = useDeleteProjectSkillConfig();
  const { data: availableModels = [], isLoading: isLoadingModels } = useAvailableModels();
  const { data: bedrockModels = [] } = useAvailableBedrockModels();
  const { data: allUsers = [] } = useUsers(selectedProject);

  // ── Derived: filter to current project ────────────────────────────────
  const projectConfigs = configs.filter((c) => c.project === selectedProject);

  // ── Local state ────────────────────────────────────────────────────────
  const [edit, setEdit] = useState<EditState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Accordion expanded state
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    repo: true,
    featurePipeline: true,
    adrPipeline: false,
    sidecarSkills: false,
    bedrockReview: false,
    approvers: false,
    pills: false,
    mcpPills: false,
  });

  // Optional pipeline stages start collapsed; core stages start open
  const [expandedStages, setExpandedStages] = useState<Record<string, boolean>>({});

  // Approver local state
  const [designDocApproverIds, setDesignDocApproverIds] = useState<string[]>([]);
  const [prdApproverIds, setPrdApproverIds] = useState<string[]>([]);
  const [designDocApproverGroupIds, setDesignDocApproverGroupIds] = useState<string[]>([]);
  const [prdApproverGroupIds, setPrdApproverGroupIds] = useState<string[]>([]);
  const [designPrototypeApproverIds, setDesignPrototypeApproverIds] = useState<string[]>([]);
  const [designPrototypeApproverGroupIds, setDesignPrototypeApproverGroupIds] = useState<string[]>([]);
  const [testCaseApproverIds, setTestCaseApproverIds] = useState<string[]>([]);
  const [testCaseApproverGroupIds, setTestCaseApproverGroupIds] = useState<string[]>([]);
  const [adrApproverIds, setAdrApproverIds] = useState<string[]>([]);
  const [adrApproverGroupIds, setAdrApproverGroupIds] = useState<string[]>([]);

  // ── Data queries dependent on edit state ───────────────────────────────
  const { data: repos = [], isLoading: isLoadingRepos } = useSkillRepos(edit?.project || null, edit?.skillProvider);
  const { data: branches = [], isLoading: isLoadingBranches } = useSkillBranches(
    edit?.project || null,
    edit?.skillRepo || null,
    edit?.skillProvider,
  );
  const { data: skillList = [], isLoading: isLoadingSkills } = useSkillList(
    edit?.project || null,
    edit?.skillRepo || null,
    edit?.skillBranch || undefined,
    edit?.skillProvider,
  );
  const {
    data: approversData,
    isSuccess: approversLoadedSuccessfully,
    isError: approversLoadFailed,
  } = useProjectApprovers(edit?.id || null);
  const setApprovers = useSetProjectApprovers();
  const { data: allGroupsWithMembers = [] } = useGroupsWithMembers(selectedProject);

  // ── Effects ────────────────────────────────────────────────────────────

  // Auto-populate branch when repo changes
  useEffect(() => {
    if (!edit?.skillRepo || !repos.length) return;
    const repo = repos.find((r) => r.name === edit.skillRepo);
    if (repo && !edit.skillBranch) {
      setEdit((prev) => prev ? { ...prev, skillBranch: repo.defaultBranch } : prev);
    }
  }, [edit?.skillRepo, repos]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync approver local state when remote data arrives or edit mode changes
  useEffect(() => {
    if (!edit || !approversData) return;
    const { approvers, approverGroups } = approversData;
    setDesignDocApproverIds(
      approvers.filter((a) => a.documentType === 'design_doc').map((a) => a.userId),
    );
    setPrdApproverIds(
      approvers.filter((a) => a.documentType === 'prd').map((a) => a.userId),
    );
    setDesignDocApproverGroupIds(
      approverGroups.filter((g) => g.documentType === 'design_doc').map((g) => g.groupId),
    );
    setPrdApproverGroupIds(
      approverGroups.filter((g) => g.documentType === 'prd').map((g) => g.groupId),
    );
    setDesignPrototypeApproverIds(
      approvers.filter((a) => a.documentType === 'design_prototype').map((a) => a.userId),
    );
    setDesignPrototypeApproverGroupIds(
      approverGroups.filter((g) => g.documentType === 'design_prototype').map((g) => g.groupId),
    );
    setTestCaseApproverIds(
      approvers.filter((a) => a.documentType === 'test_case').map((a) => a.userId),
    );
    setTestCaseApproverGroupIds(
      approverGroups.filter((g) => g.documentType === 'test_case').map((g) => g.groupId),
    );
    setAdrApproverIds(
      approvers.filter((a) => a.documentType === 'adr').map((a) => a.userId),
    );
    setAdrApproverGroupIds(
      approverGroups.filter((g) => g.documentType === 'adr').map((g) => g.groupId),
    );
  }, [approversData, edit?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Computed ───────────────────────────────────────────────────────────

  const groupsWithMembers = allGroupsWithMembers;

  // ── Handlers ───────────────────────────────────────────────────────────

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const isStageExpanded = (stage: PipelineStageDef): boolean =>
    expandedStages[stage.id] ?? !stage.optional;

  const toggleStage = (stageId: string, stage: PipelineStageDef) => {
    setExpandedStages((prev) => ({
      ...prev,
      [stageId]: !(prev[stageId] ?? !stage.optional),
    }));
  };

  const patchEdit = (patch: Partial<EditState>) => {
    setEdit((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const defaultExpandedSections = {
    repo: true,
    featurePipeline: true,
    adrPipeline: false,
    sidecarSkills: false,
    bedrockReview: false,
    approvers: false,
    pills: false,
    mcpPills: false,
  };

  const handleAddNew = () => {
    setEdit({ ...emptyEdit(), project: selectedProject });
    setFormError(null);
    setExpandedSections(defaultExpandedSections);
    setExpandedStages({});
  };

  const handleEditRow = (config: ProjectSkillConfig) => {
    setEdit({
      id: config.id,
      project: config.project,
      friendlyName: config.friendlyName,
      isDefault: config.isDefault,
      skillProvider: config.skillProvider ?? 'ado',
      skillRepo: config.skillRepo,
      skillBranch: config.skillBranch,
      interviewSkillPath: config.interviewSkillPath ?? '',
      prdSkillPath: config.prdSkillPath ?? '',
      adrInterviewSkillPath: config.adrInterviewSkillPath ?? '',
      adrFinalizeSkillPath: config.adrFinalizeSkillPath ?? '',
      adrAssistantSkillPath: config.adrAssistantSkillPath ?? '',
      designDocSkillPath: config.designDocSkillPath ?? '',
      designDocAssistantSkillPath: config.designDocAssistantSkillPath ?? '',
      designPrototypeSkillPath: config.designPrototypeSkillPath ?? '',
      testCaseSkillPath: config.testCaseSkillPath ?? '',
      designDocValidationSkillPath: config.designDocValidationSkillPath ?? '',
      prdValidationSkillPath: config.prdValidationSkillPath ?? '',
      developmentSkillPath: config.developmentSkillPath ?? '',
      standupSkillPath: config.standupSkillPath ?? '',
      featureRequestSkillPath: config.featureRequestSkillPath ?? '',
      technicalSkillPath: config.technicalSkillPath ?? '',
      issueSkillPath: config.issueSkillPath ?? '',
      loadTestGenerationSkillPath: config.loadTestGenerationSkillPath ?? '',
      designModuleSkillPath: config.designModuleSkillPath ?? '',
      designModuleScopingSkillPath: config.designModuleScopingSkillPath ?? '',
      interviewModel: config.interviewModel ?? '',
      prdModel: config.prdModel ?? '',
      adrModel: config.adrModel ?? '',
      designDocModel: config.designDocModel ?? '',
      designDocAssistantModel: config.designDocAssistantModel ?? '',
      designPrototypeModel: config.designPrototypeModel ?? '',
      testCaseModel: config.testCaseModel ?? '',
      designDocValidationModel: config.designDocValidationModel ?? '',
      prdValidationModel: config.prdValidationModel ?? '',
      developmentModel: config.developmentModel ?? '',
      standupModel: config.standupModel ?? '',
      featureRequestModel: config.featureRequestModel ?? '',
      technicalModel: config.technicalModel ?? '',
      issueModel: config.issueModel ?? '',
      loadTestGenerationModel: config.loadTestGenerationModel ?? '',
      designModuleModel: config.designModuleModel ?? '',
      designModuleScopingModel: config.designModuleScopingModel ?? '',
      defaultModel: config.defaultModel ?? '',
      prdReviewBedrockModelId: config.prdReviewBedrockModelId ?? '',
      prdReviewBedrockMaxTokens: config.prdReviewBedrockMaxTokens ?? 16000,
      designPrototypeBedrockModelId: config.designPrototypeBedrockModelId ?? '',
      designPrototypeBedrockMaxTokens: config.designPrototypeBedrockMaxTokens ?? 16000,
      designPrototypeBedrockTimeoutMs: config.designPrototypeBedrockTimeoutMs ?? 720000,
      designPrototypeRegenBedrockModelId: config.designPrototypeRegenBedrockModelId ?? '',
      designPrototypeRegenBedrockMaxTokens: config.designPrototypeRegenBedrockMaxTokens ?? 16000,
      designPlanBedrockModelId: config.designPlanBedrockModelId ?? '',
      designPlanBedrockMaxTokens: config.designPlanBedrockMaxTokens ?? 4000,
      prdValidationScoreThreshold: config.prdValidationScoreThreshold ?? 90,
      designDocValidationScoreThreshold: config.designDocValidationScoreThreshold ?? 90,
      uiLabBedrockModelId: config.uiLabBedrockModelId ?? '',
      uiLabBedrockMaxTokens: config.uiLabBedrockMaxTokens ?? 16000,
      uiLabBedrockTimeoutMs: config.uiLabBedrockTimeoutMs ?? 600000,
      uiLabRegenBedrockModelId: config.uiLabRegenBedrockModelId ?? '',
      uiLabRegenBedrockMaxTokens: config.uiLabRegenBedrockMaxTokens ?? 16000,
      uiLabBedrockTemperature: config.uiLabBedrockTemperature ?? 0,
      quickSkillPills: config.quickSkillPills ?? [],
      quickMcpPills: config.quickMcpPills ?? [],
      approvalMode: config.approvalMode ?? 'any_one',
      approvalModes: config.approvalModes ?? {
        prd: config.approvalMode ?? 'any_one',
        design_doc: config.approvalMode ?? 'any_one',
        design_prototype: config.approvalMode ?? 'any_one',
        test_case: config.approvalMode ?? 'any_one',
        adr: 'any_one',
      },
      interviewSkillOptions: config.interviewSkillOptions ?? [],
      prototypeStageEnabled: config.prototypeStageEnabled !== false,
      interviewWebResearchEnabled: config.interviewWebResearchEnabled ?? false,
      interviewWebMcp: config.interviewWebMcp ?? null,
      prototypeEngine: config.prototypeEngine ?? 'bedrock',
      prototypeDesignSystemPath: config.prototypeDesignSystemPath ?? '',
      screenInventoryPath: config.screenInventoryPath ?? '',
      prototypeWebReferencesEnabled: config.prototypeWebReferencesEnabled ?? false,
      isNew: false,
    });
    setFormError(null);
    setExpandedSections(defaultExpandedSections);
    setExpandedStages({});
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
    if (!edit.friendlyName.trim()) { setFormError('Friendly Name is required.'); return; }
    if (!edit.skillRepo.trim()) { setFormError('Skill Repo is required.'); return; }
    if (!edit.skillBranch.trim()) { setFormError('Skill Branch is required.'); return; }
    setFormError(null);
    try {
      const body: UpsertProjectSkillConfigRequest = {
        friendlyName: edit.friendlyName.trim(),
        isDefault: edit.isDefault,
        skillProvider: edit.skillProvider,
        skillRepo: edit.skillRepo.trim(),
        skillBranch: edit.skillBranch.trim(),
        interviewSkillPath: edit.interviewSkillPath || null,
        prdSkillPath: edit.prdSkillPath || null,
        adrInterviewSkillPath: edit.adrInterviewSkillPath || null,
        adrFinalizeSkillPath: edit.adrFinalizeSkillPath || null,
        adrAssistantSkillPath: edit.adrAssistantSkillPath || null,
        designDocSkillPath: edit.designDocSkillPath || null,
        designDocAssistantSkillPath: edit.designDocAssistantSkillPath || null,
        designPrototypeSkillPath: edit.designPrototypeSkillPath || null,
        testCaseSkillPath: edit.testCaseSkillPath || null,
        designDocValidationSkillPath: edit.designDocValidationSkillPath || null,
        prdValidationSkillPath: edit.prdValidationSkillPath || null,
        developmentSkillPath: edit.developmentSkillPath || null,
        standupSkillPath: edit.standupSkillPath || null,
        featureRequestSkillPath: edit.featureRequestSkillPath || null,
        technicalSkillPath: edit.technicalSkillPath || null,
        issueSkillPath: edit.issueSkillPath || null,
        loadTestGenerationSkillPath: edit.loadTestGenerationSkillPath || null,
        designModuleSkillPath: edit.designModuleSkillPath || null,
        designModuleScopingSkillPath: edit.designModuleScopingSkillPath || null,
        interviewModel: edit.interviewModel || null,
        prdModel: edit.prdModel || null,
        adrModel: edit.adrModel || null,
        designDocModel: edit.designDocModel || null,
        designDocAssistantModel: edit.designDocAssistantModel || null,
        designPrototypeModel: edit.designPrototypeModel || null,
        testCaseModel: edit.testCaseModel || null,
        designDocValidationModel: edit.designDocValidationModel || null,
        prdValidationModel: edit.prdValidationModel || null,
        developmentModel: edit.developmentModel || null,
        standupModel: edit.standupModel || null,
        featureRequestModel: edit.featureRequestModel || null,
        technicalModel: edit.technicalModel || null,
        issueModel: edit.issueModel || null,
        loadTestGenerationModel: edit.loadTestGenerationModel || null,
        designModuleModel: edit.designModuleModel || null,
        designModuleScopingModel: edit.designModuleScopingModel || null,
        defaultModel: edit.defaultModel || null,
        prdReviewBedrockModelId: edit.prdReviewBedrockModelId || null,
        prdReviewBedrockMaxTokens: edit.prdReviewBedrockMaxTokens || null,
        designPrototypeBedrockModelId: edit.designPrototypeBedrockModelId || null,
        designPrototypeBedrockMaxTokens: edit.designPrototypeBedrockMaxTokens || null,
        designPrototypeBedrockTimeoutMs: edit.designPrototypeBedrockTimeoutMs || null,
        designPrototypeRegenBedrockModelId: edit.designPrototypeRegenBedrockModelId || null,
        designPrototypeRegenBedrockMaxTokens: edit.designPrototypeRegenBedrockMaxTokens || null,
        designPlanBedrockModelId: edit.designPlanBedrockModelId || null,
        designPlanBedrockMaxTokens: edit.designPlanBedrockMaxTokens || null,
        prdValidationScoreThreshold: edit.prdValidationScoreThreshold !== 90 ? edit.prdValidationScoreThreshold : null,
        designDocValidationScoreThreshold: edit.designDocValidationScoreThreshold !== 90 ? edit.designDocValidationScoreThreshold : null,
          uiLabBedrockModelId: edit.uiLabBedrockModelId || null,
          uiLabBedrockMaxTokens: edit.uiLabBedrockMaxTokens || null,
          uiLabBedrockTimeoutMs: edit.uiLabBedrockTimeoutMs || null,
          uiLabRegenBedrockModelId: edit.uiLabRegenBedrockModelId || null,
          uiLabRegenBedrockMaxTokens: edit.uiLabRegenBedrockMaxTokens || null,
          uiLabBedrockTemperature: edit.uiLabBedrockTemperature > 0 ? edit.uiLabBedrockTemperature : null,
        quickSkillPills: edit.quickSkillPills.length > 0 ? edit.quickSkillPills : null,
        quickMcpPills: edit.quickMcpPills.length > 0 ? edit.quickMcpPills : null,
        interviewSkillOptions: edit.interviewSkillOptions.length > 0 ? edit.interviewSkillOptions : null,
        // Keep project-level flag aligned with interview options (project-level UI toggle was removed).
        prototypeStageEnabled: edit.interviewSkillOptions.length > 0
          ? edit.interviewSkillOptions.some((o) => o.wantsDesignPrototype !== false)
          : edit.prototypeStageEnabled,
        interviewWebResearchEnabled: edit.interviewWebResearchEnabled,
        interviewWebMcp: edit.interviewWebResearchEnabled ? edit.interviewWebMcp : null,
        prototypeEngine: edit.prototypeEngine,
        prototypeDesignSystemPath: edit.prototypeDesignSystemPath || null,
        screenInventoryPath: edit.screenInventoryPath || null,
        prototypeWebReferencesEnabled: edit.prototypeWebReferencesEnabled,
        approvalMode: edit.approvalModes.prd,
        approvalModes: edit.approvalModes,
      };

      const savedConfig = await upsert.mutateAsync({
        id: edit.id ?? undefined,
        project: edit.project.trim(),
        body,
      });

      const configId = savedConfig.id;
      const hasApprovers =
        designDocApproverIds.length > 0 ||
        prdApproverIds.length > 0 || designPrototypeApproverIds.length > 0 ||
        testCaseApproverIds.length > 0 ||
        adrApproverIds.length > 0 ||
        designDocApproverGroupIds.length > 0 ||
        prdApproverGroupIds.length > 0 || designPrototypeApproverGroupIds.length > 0 ||
        testCaseApproverGroupIds.length > 0 ||
        adrApproverGroupIds.length > 0 ||
        (approversData && (approversData.approvers.length > 0 || approversData.approverGroups.length > 0));
      if (hasApprovers) {
        try {
          await setApprovers.mutateAsync({
            settingsId: configId,
            designDocApprovers: designDocApproverIds,
            prdApprovers: prdApproverIds,
            designDocApproverGroups: designDocApproverGroupIds,
            prdApproverGroups: prdApproverGroupIds,
            designPrototypeApprovers: designPrototypeApproverIds,
            designPrototypeApproverGroups: designPrototypeApproverGroupIds,
            testCaseApprovers: testCaseApproverIds,
            testCaseApproverGroups: testCaseApproverGroupIds,
            adrApprovers: adrApproverIds,
            adrApproverGroups: adrApproverGroupIds,
          });
        } catch (approverErr) {
          // Keep the editor and selections visible so the reviewer save can be retried.
          setFormError(
            approverErr instanceof Error
              ? `Repo config saved, but reviewers failed to save: ${approverErr.message}`
              : 'Repo config saved, but reviewers failed to save.',
          );
          return;
        }
      }

      setEdit(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save.');
    }
  };

  const handleDelete = async (config: ProjectSkillConfig) => {
    if (!window.confirm(`Delete repo config "${config.friendlyName}" for "${config.project}"? This cannot be undone.`)) return;
    setDeletingId(config.id);
    try {
      await remove.mutateAsync(config.id);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to delete.');
    } finally {
      setDeletingId(null);
    }
  };

  // ── Render helpers ─────────────────────────────────────────────────────

  const renderApproverBadge = (config: ProjectSkillConfig) => {
    const ddCount = config.designDocApproverCount ?? 0;
    const prdCount = config.prdApproverCount ?? 0;
    const dpCount = config.designPrototypeApproverCount ?? 0;
    const tcCount = config.testCaseApproverCount ?? 0;
    const adrCount = config.adrApproverCount ?? 0;
    if (ddCount === 0 && prdCount === 0 && dpCount === 0 && tcCount === 0 && adrCount === 0) {
      return <span className={`${styles.approverBadge} ${styles.approverBadgeEmpty}`}>No reviewers</span>;
    }
    const parts: string[] = [];
    if (ddCount > 0) parts.push(`${ddCount} design doc`);
    if (dpCount > 0) parts.push(`${dpCount} design prototype`);
    if (prdCount > 0) parts.push(`${prdCount} PRD`);
    if (tcCount > 0) parts.push(`${tcCount} QA`);
    if (adrCount > 0) parts.push(`${adrCount} ADR`);
    return <span className={styles.approverBadge}>{parts.join(' · ')}</span>;
  };

  const renderApprovalMode = (
    module: ReviewerDocumentType,
    label: string,
    userIds: string[],
    groupIds: string[],
  ) => {
    const poolIsConfigured = userIds.length > 0 || groupIds.length > 0;
    const showNoReviewers = approversLoadedSuccessfully && !poolIsConfigured;
    if (showNoReviewers) {
      return (
        <p
          className={styles.accordionHelp}
          aria-live="polite"
          {...{ 'data-testid': `ps-no-reviewers-helper-${module}` }}
        >
          <strong className={styles.noReviewersLabel}>No Reviewers</strong>
          {' — documents will be approved by their owner'}
        </p>
      );
    }

    const mode = edit?.approvalModes[module] ?? 'any_one';
    const groupLabelId = `ps-approval-mode-${module}-label`;
    return (
      <div
        className={styles.approvalModeSection}
        role="radiogroup"
        aria-labelledby={groupLabelId}
        aria-describedby={approversLoadFailed ? `ps-approval-mode-${module}-load-note` : undefined}
        {...{ 'data-testid': `ps-approval-mode-${module}` }}
      >
        <p id={groupLabelId} className={styles.approverSubTitle}>{label} Approval Mode</p>
        {approversLoadFailed && (
          <span id={`ps-approval-mode-${module}-load-note`} className={styles.accordionHelp}>
            Reviewer configuration could not be refreshed. Showing the last-known approval mode.
          </span>
        )}
        <div className={styles.approvalModeOptions}>
          {(['any_one', 'all_required'] as const).map((option) => {
            const optionId = `ps-approval-mode-${module}-${option.replace('_', '-')}`;
            const optionLabel = option === 'any_one' ? 'Any One' : 'All Required';
            return (
              <label
                key={option}
                htmlFor={optionId}
                className={`${styles.approvalModeOption} ${mode === option ? styles.approvalModeOptionSelected : ''}`}
              >
                <input
                  id={optionId}
                  type="radio"
                  name={`approvalMode-${module}`}
                  value={option}
                  checked={mode === option}
                  onChange={() => setEdit((prev) => prev ? {
                    ...prev,
                    approvalModes: { ...prev.approvalModes, [module]: option },
                  } : prev)}
                  disabled={upsert.isPending}
                  className={styles.approvalModeRadio}
                  {...{ 'data-testid': optionId }}
                />
                <div>
                  <span className={styles.approvalModeLabel}>{optionLabel}</span>
                  <span className={styles.approvalModeDesc}>
                    {option === 'any_one'
                      ? 'Document is approved when any assigned reviewer approves'
                      : 'All assigned reviewers must approve the document'}
                  </span>
                </div>
              </label>
            );
          })}
        </div>
      </div>
    );
  };

  const renderApproverSection = (
    module: ReviewerDocumentType,
    title: string,
    userIds: string[],
    setUserIds: React.Dispatch<React.SetStateAction<string[]>>,
    groupIds: string[],
    setGroupIds: React.Dispatch<React.SetStateAction<string[]>>,
  ) => (
    <div
      className={styles.approverSubSection}
      {...{ 'data-testid': `ps-${module}-approver-pool` }}
    >
      <p className={styles.approverSubTitle}>{title}</p>
      <GroupAwarePeoplePicker
        groups={groupsWithMembers}
        availableUsers={allUsers}
        selectedUserIds={userIds}
        selectedGroupIds={groupIds}
        onUserIdsChange={setUserIds}
        onGroupIdsChange={setGroupIds}
        disabled={upsert.isPending}
        placeholder="Search groups or people to add…"
      />
      {renderApprovalMode(module, title, userIds, groupIds)}
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
            <p className={styles.pageSubtitle}>Configure skill repository, pipeline settings, and document reviewers for <strong>{selectedProject}</strong>.</p>
          </div>
          {!edit && (
            <button className={styles.btnPrimary} onClick={handleAddNew} type="button" {...{ 'data-testid': 'ps-add-repo-config' }}>
              + Add Repo Config
            </button>
          )}
        </div>

        {/* ── Edit form (accordion layout) ────────────────────────────── */}
        {edit && (
          <div className={styles.formCard}>
            <p className={styles.formTitle}>{edit.isNew ? 'Add Repo Config' : `Edit: ${edit.friendlyName || edit.project}`}</p>

            {/* Section 1: Repository & Branch */}
            <AccordionSection
              title="Repository & Branch"
              expanded={expandedSections.repo}
              onToggle={() => toggleSection('repo')}
            >
              <p className={styles.accordionHelp}>
                Select the repository and branch containing your agent skills.
              </p>
              <div className={styles.formGridThreeCol}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-project">Project</label>
                  <input
                    id="ps-project"
                    className={styles.input}
                    value={edit.project}
                    disabled
                    readOnly {...{ 'data-testid': 'ps-project' }} />
                </div>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-friendlyName">Friendly Name</label>
                  <input
                    id="ps-friendlyName"
                    className={styles.input}
                    value={edit.friendlyName}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, friendlyName: e.target.value } : prev)}
                    placeholder="e.g. Main Skills, Feature Branch"
                    disabled={upsert.isPending} {...{ 'data-testid': 'ps-friendlyName' }} />
                </div>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-isDefault">
                    <input
                      id="ps-isDefault"
                      type="checkbox"
                      checked={edit.isDefault}
                      onChange={(e) => setEdit((prev) => prev ? { ...prev, isDefault: e.target.checked } : prev)}
                      disabled={upsert.isPending}
                      style={{ marginRight: '6px' }} {...{ 'data-testid': 'ps-isDefault' }} />
                    Default config
                  </label>
                  <span className={styles.skillDescription}>Auto-selected when user picks this project</span>
                </div>
              </div>

              <div className={styles.field} style={{ marginBottom: '8px' }}>
                <label className={styles.label}>Provider</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {(['ado', 'github'] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={`${styles.btnAction} ${edit.skillProvider === p ? styles.transportActive : ''}`}
                      style={{ padding: '4px 14px', fontSize: '0.82rem' }}
                      onClick={() => setEdit((prev) => prev ? { ...prev, skillProvider: p, skillRepo: '', skillBranch: '' } : prev)}
                      disabled={upsert.isPending}
                     {...{ 'data-testid': `ps-provider-${p}` }}>
                      {p === 'ado' ? 'Azure DevOps' : 'GitHub'}
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.formGridThreeCol}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-repo">{edit.skillProvider === 'github' ? 'GitHub Repository' : 'Skill Repo'}</label>
                  <select
                    id="ps-repo"
                    className={styles.select}
                    value={edit.skillRepo}
                    onChange={(e) => handleRepoChange(e.target.value)}
                    disabled={upsert.isPending || isLoadingRepos || !edit.project}
                   {...{ 'data-testid': 'ps-repo' }}>
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
                    onChange={(branch) => setEdit((prev) => prev ? { ...prev, skillBranch: branch } : prev)} {...{ 'data-testid': 'ps-branch-combobox' }} />
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
                 {...{ 'data-testid': 'ps-defaultModel' }}>
                  <option value="">Use system default (composer-2)</option>
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.displayName}</option>
                  ))}
                </select>
                <span className={styles.modelDefault}>Fallback model for all pipeline stages without a specific override</span>
              </div>

              <div className={styles.field} style={{ marginTop: '12px' }}>
                <label className={styles.label} htmlFor="ps-prototypeEngine">Prototype Engine</label>
                <select
                  id="ps-prototypeEngine"
                  className={styles.select}
                  value={edit.prototypeEngine}
                  onChange={(e) => setEdit((prev) => prev ? { ...prev, prototypeEngine: e.target.value as PrototypeEngine } : prev)}
                  disabled={upsert.isPending}
                 {...{ 'data-testid': 'ps-prototypeEngine' }}>
                  <option value="bedrock">Bedrock (one-shot, built-in prompt)</option>
                  <option value="agent">Agent / skill flow (web-enabled)</option>
                </select>
                <span className={styles.skillDescription}>Which generator produces design prototypes for this project. Bedrock is the default built-in path; Agent runs the project&apos;s prototype skill.</span>
              </div>

              <div className={styles.field} style={{ marginTop: '12px' }}>
                <label className={styles.label} htmlFor="ps-interviewWebResearchEnabled">
                  <input
                    id="ps-interviewWebResearchEnabled"
                    type="checkbox"
                    checked={edit.interviewWebResearchEnabled}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, interviewWebResearchEnabled: e.target.checked } : prev)}
                    disabled={upsert.isPending}
                    style={{ marginRight: '6px' }} {...{ 'data-testid': 'ps-interviewWebResearchEnabled' }} />
                  Enable live web research during interviews
                </label>
                <span className={styles.skillDescription}>Adds a narrow scope carve-out and wires the web-search MCP below into interview threads. Off by default; only affects this project&apos;s interviews.</span>
                {edit.interviewWebResearchEnabled && (
                  <InterviewWebMcpEditor
                    key={edit.id ?? 'new'}
                    value={edit.interviewWebMcp}
                    isPending={upsert.isPending}
                    onChange={(pill) => setEdit((prev) => prev ? { ...prev, interviewWebMcp: pill } : prev)} {...{ 'data-testid': 'ps-interview-web-mcp-editor' }} />
                )}
              </div>
            </AccordionSection>

            {/* Section 2: Document Pipeline — Feature */}
            <AccordionSection
              title="Document Pipeline — Feature"
              hint={`${countConfiguredStages(FEATURE_PIPELINE_STAGES, edit)}/${FEATURE_PIPELINE_STAGES.length} configured${edit.skillRepo ? ` · ${skillList.length} skills available` : ''}`}
              expanded={expandedSections.featurePipeline}
              onToggle={() => toggleSection('featurePipeline')}
            >
              <p className={styles.accordionHelp}>
                Assign skill and model for each stage of the feature document flow.
              </p>
              <PipelineFlow stages={FEATURE_PIPELINE_STAGES} />
              <div className={styles.stageList}>
                {FEATURE_PIPELINE_STAGES.map((stage) => (
                  <PipelineStageCard
                    key={stage.id}
                    stage={stage}
                    edit={edit}
                    skillList={skillList}
                    availableModels={availableModels}
                    expanded={isStageExpanded(stage)}
                    onToggle={() => toggleStage(stage.id, stage)}
                    onEditChange={patchEdit}
                    disabled={upsert.isPending}
                    skillsDisabled={isLoadingSkills || !edit.skillRepo}
                    modelsDisabled={isLoadingModels} {...{ 'data-testid': `ps-pipeline-stage-card-${stage.id}` }} />
                ))}
              </div>
            </AccordionSection>

            {/* Section 3: Document Pipeline — ADR */}
            <AccordionSection
              title="Document Pipeline — ADR"
              hint={`${countConfiguredStages(ADR_PIPELINE_STAGES, edit)}/${ADR_PIPELINE_STAGES.length} configured`}
              expanded={expandedSections.adrPipeline}
              onToggle={() => toggleSection('adrPipeline')}
            >
              <p className={styles.accordionHelp}>
                Separate architecture decision flow — not mixed into the feature pipeline.
                ADR stages share one model override.
              </p>
              <PipelineFlow stages={ADR_PIPELINE_STAGES} />
              <div className={styles.sharedModelRow}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-adrModel">ADR model override</label>
                  <select
                    id="ps-adrModel"
                    className={styles.select}
                    value={edit.adrModel}
                    onChange={(e) => patchEdit({ adrModel: e.target.value })}
                    disabled={upsert.isPending || isLoadingModels}
                   {...{ 'data-testid': 'ps-adrModel' }}>
                    <option value="">Use project default</option>
                    {availableModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.displayName}</option>
                    ))}
                  </select>
                  {!edit.adrModel && (
                    <span className={styles.modelDefault}>
                      Using: {edit.defaultModel
                        ? availableModels.find((m) => m.id === edit.defaultModel)?.displayName ?? edit.defaultModel
                        : 'system default (composer-2)'}
                    </span>
                  )}
                </div>
              </div>
              <div className={styles.stageList}>
                {ADR_PIPELINE_STAGES.map((stage) => (
                  <PipelineStageCard
                    key={stage.id}
                    stage={stage}
                    edit={edit}
                    skillList={skillList}
                    availableModels={availableModels}
                    expanded={isStageExpanded(stage)}
                    onToggle={() => toggleStage(stage.id, stage)}
                    onEditChange={patchEdit}
                    disabled={upsert.isPending}
                    skillsDisabled={isLoadingSkills || !edit.skillRepo}
                    modelsDisabled={isLoadingModels} {...{ 'data-testid': `ps-pipeline-stage-card-${stage.id}` }} />
                ))}
              </div>
            </AccordionSection>

            {/* Section 4: Sidecar Skills */}
            <AccordionSection
              title="Sidecar Skills"
              hint={`${countConfiguredStages(SIDECAR_STAGES, edit)}/${SIDECAR_STAGES.length} configured`}
              expanded={expandedSections.sidecarSkills}
              onToggle={() => toggleSection('sidecarSkills')}
            >
              <p className={styles.accordionHelp}>
                Independent tools that are not stages in the document pipeline.
              </p>
              <div className={styles.stageList}>
                {SIDECAR_STAGES.map((stage) => (
                  <PipelineStageCard
                    key={stage.id}
                    stage={stage}
                    edit={edit}
                    skillList={skillList}
                    availableModels={availableModels}
                    expanded={isStageExpanded(stage)}
                    onToggle={() => toggleStage(stage.id, stage)}
                    onEditChange={patchEdit}
                    disabled={upsert.isPending}
                    skillsDisabled={isLoadingSkills || !edit.skillRepo}
                    modelsDisabled={isLoadingModels} {...{ 'data-testid': `ps-pipeline-stage-card-${stage.id}` }} />
                ))}
              </div>
            </AccordionSection>

            {/* Section 5: Prototype Design System (Bedrock) */}
            <AccordionSection
              title="Prototype Design System"
              expanded={expandedSections.bedrockReview}
              onToggle={() => toggleSection('bedrockReview')}
            >
              <p className={styles.accordionHelp}>
                Each project supplies its own design system for Bedrock prototype generation.
                The design-system skill file (from the project&apos;s repo) defines brand tokens,
                components, and shell — no MaxView styles are injected. Leave the path blank to
                use the convention path <code>.agents/skills/design-system/SKILL.md</code>
                (then <code>.cursor/skills/design-system/SKILL.md</code>).
              </p>
              <div className={styles.formGrid}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-protoDesignSystemPath">Design System Skill</label>
                  <select
                    id="ps-protoDesignSystemPath"
                    className={styles.select}
                    value={edit.prototypeDesignSystemPath}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, prototypeDesignSystemPath: e.target.value } : prev)}
                    disabled={upsert.isPending || isLoadingSkills || !edit.skillRepo}
                   {...{ 'data-testid': 'ps-protoDesignSystemPath' }}>
                    <option value="">None (convention: .agents/skills/design-system/SKILL.md, then .cursor/skills)</option>
                    {skillList.map((s) => (
                      <option key={s.id} value={s.path}>{s.name}</option>
                    ))}
                  </select>
                  <span className={styles.skillDescription}>
                    Skill from this project&apos;s repo that defines brand tokens, components, shell, and self-contained HTML rules. Loaded by Bedrock for every prototype generation.
                  </span>
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-screenInventoryPath">Screen Inventory Path (EXTEND mode)</label>
                  <input
                    id="ps-screenInventoryPath"
                    className={styles.input}
                    placeholder=".cursor/skills/figma-ui-knowledge-base/clientapp-screens.md"
                    value={edit.screenInventoryPath}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, screenInventoryPath: e.target.value } : prev)}
                    disabled={upsert.isPending || !edit.skillRepo} {...{ 'data-testid': 'ps-screenInventoryPath' }} />
                  <span className={styles.skillDescription}>
                    Optional. Path within this project&apos;s repo to a screen-inventory markdown file used in EXTEND mode (extending an existing page). Leave blank to skip.
                  </span>
                </div>
              </div>
              <div className={styles.field} style={{ marginTop: '12px' }}>
                <label className={styles.label} htmlFor="ps-protoWebRefs">
                  <input
                    id="ps-protoWebRefs"
                    type="checkbox"
                    checked={edit.prototypeWebReferencesEnabled}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, prototypeWebReferencesEnabled: e.target.checked } : prev)}
                    disabled={upsert.isPending}
                    style={{ marginRight: '6px' }} {...{ 'data-testid': 'ps-protoWebRefs' }} />
                  Enable live web design references (NEW-page mode only)
                </label>
                <span className={styles.skillDescription}>
                  When on, a per-feature Tavily web search gathers modern UI patterns and injects them as inspiration into the Bedrock prompt. Applied only for NEW-page features; EXTEND mode always uses repo sources only. Requires <code>TAVILY_API_KEY</code> on the server.
                </span>
              </div>
            </AccordionSection>

            {/* Section 6: Apex Bedrock Models */}
            <AccordionSection
              title="Apex Bedrock Models"
              hint={
                edit.prdReviewBedrockModelId || edit.designPrototypeBedrockModelId || edit.designPrototypeRegenBedrockModelId || edit.designPlanBedrockModelId
                  ? [
                      edit.prdReviewBedrockModelId
                        ? `PRD: ${bedrockModels.find((m) => m.id === edit.prdReviewBedrockModelId)?.label ?? edit.prdReviewBedrockModelId}`
                        : null,
                      edit.designPlanBedrockModelId
                        ? `Plan: ${bedrockModels.find((m) => m.id === edit.designPlanBedrockModelId)?.label ?? edit.designPlanBedrockModelId}`
                        : null,
                      edit.designPrototypeBedrockModelId
                        ? `Prototype: ${bedrockModels.find((m) => m.id === edit.designPrototypeBedrockModelId)?.label ?? edit.designPrototypeBedrockModelId}`
                        : null,
                      edit.designPrototypeRegenBedrockModelId
                        ? `Regen: ${bedrockModels.find((m) => m.id === edit.designPrototypeRegenBedrockModelId)?.label ?? edit.designPrototypeRegenBedrockModelId}`
                        : null,
                    ].filter(Boolean).join(' · ') || undefined
                  : undefined
              }
              expanded={expandedSections.bedrockReview}
              onToggle={() => toggleSection('bedrockReview')}
            >
              <p className={styles.accordionHelp}>
                Configure the AWS Bedrock models used by Apex-powered features.
                Defaults fall back to the service-level environment config ({process.env.NODE_ENV === 'production' ? 'BEDROCK_UI_MOCK_MODEL_ID env var' : 'Claude Haiku 4.5'}).
              </p>

              <p className={styles.label} style={{ marginBottom: 6, fontWeight: 600 }}>PRD Apex Review</p>
              <p className={styles.accordionHelp} style={{ marginTop: 0 }}>
                Model used when "Fix with Apex" applies open review comments to a PRD.
              </p>
              <div className={styles.fieldRow}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-bedrock-model">Bedrock Model</label>
                  <select
                    id="ps-bedrock-model"
                    className={styles.select}
                    value={edit.prdReviewBedrockModelId}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, prdReviewBedrockModelId: e.target.value } : prev)}
                    disabled={upsert.isPending}
                   {...{ 'data-testid': 'ps-bedrock-model' }}>
                    <option value="">Use service default</option>
                    {bedrockModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-bedrock-max-tokens">Max Output Tokens</label>
                  <select
                    id="ps-bedrock-max-tokens"
                    className={styles.select}
                    value={String(edit.prdReviewBedrockMaxTokens)}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, prdReviewBedrockMaxTokens: Number(e.target.value) } : prev)}
                    disabled={upsert.isPending}
                   {...{ 'data-testid': 'ps-bedrock-max-tokens' }}>
                    <option value="8000">8 000 (small PRDs)</option>
                    <option value="16000">16 000 (default)</option>
                    <option value="32000">32 000 (large PRDs)</option>
                    <option value="64000">64 000 (very large PRDs)</option>
                  </select>
                </div>
              </div>

              <p className={styles.label} style={{ marginBottom: 6, marginTop: 16, fontWeight: 600 }}>Design Plan Generation</p>
              <p className={styles.accordionHelp} style={{ marginTop: 0 }}>
                Model used for the cheap, structured design plan generated from the PRD before HTML prototypes.
                This is a small JSON call — keep max tokens low.
              </p>
              <div className={styles.fieldRow}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-plan-bedrock-model">Bedrock Model</label>
                  <select
                    id="ps-plan-bedrock-model"
                    className={styles.select}
                    value={edit.designPlanBedrockModelId}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, designPlanBedrockModelId: e.target.value } : prev)}
                    disabled={upsert.isPending}
                   {...{ 'data-testid': 'ps-plan-bedrock-model' }}>
                    <option value="">Use service default</option>
                    {bedrockModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-plan-bedrock-max-tokens">Max Output Tokens</label>
                  <select
                    id="ps-plan-bedrock-max-tokens"
                    className={styles.select}
                    value={String(edit.designPlanBedrockMaxTokens)}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, designPlanBedrockMaxTokens: Number(e.target.value) } : prev)}
                    disabled={upsert.isPending}
                   {...{ 'data-testid': 'ps-plan-bedrock-max-tokens' }}>
                    <option value="2000">2 000</option>
                    <option value="4000">4 000 (default)</option>
                    <option value="8000">8 000</option>
                    <option value="16000">16 000 (many features)</option>
                  </select>
                </div>
              </div>

              <p className={styles.label} style={{ marginBottom: 6, marginTop: 16, fontWeight: 600 }}>Design Prototype Generation</p>
              <p className={styles.accordionHelp} style={{ marginTop: 0 }}>
                Model used for the initial HTML design prototype generation from approved PBI requirements.
              </p>
              <div className={styles.fieldRow}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-prototype-bedrock-model">Bedrock Model</label>
                  <select
                    id="ps-prototype-bedrock-model"
                    className={styles.select}
                    value={edit.designPrototypeBedrockModelId}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, designPrototypeBedrockModelId: e.target.value } : prev)}
                    disabled={upsert.isPending}
                   {...{ 'data-testid': 'ps-prototype-bedrock-model' }}>
                    <option value="">Use service default</option>
                    {bedrockModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-prototype-bedrock-max-tokens">Max Output Tokens</label>
                  <select
                    id="ps-prototype-bedrock-max-tokens"
                    className={styles.select}
                    value={String(edit.designPrototypeBedrockMaxTokens)}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, designPrototypeBedrockMaxTokens: Number(e.target.value) } : prev)}
                    disabled={upsert.isPending}
                   {...{ 'data-testid': 'ps-prototype-bedrock-max-tokens' }}>
                    <option value="8000">8 000</option>
                    <option value="16000">16 000 (default)</option>
                    <option value="32000">32 000</option>
                    <option value="64000">64 000</option>
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-prototype-bedrock-timeout">Bedrock Timeout</label>
                  <select
                    id="ps-prototype-bedrock-timeout"
                    className={styles.select}
                    value={String(edit.designPrototypeBedrockTimeoutMs)}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, designPrototypeBedrockTimeoutMs: Number(e.target.value) } : prev)}
                    disabled={upsert.isPending}
                   {...{ 'data-testid': 'ps-prototype-bedrock-timeout' }}>
                    <option value="480000">8 min</option>
                    <option value="720000">12 min (default)</option>
                    <option value="900000">15 min</option>
                    <option value="1200000">20 min</option>
                  </select>
                </div>
              </div>

              <p className={styles.label} style={{ marginBottom: 6, marginTop: 16, fontWeight: 600 }}>Design Prototype Regeneration</p>
              <p className={styles.accordionHelp} style={{ marginTop: 0 }}>
                Model used when regenerating a prototype from UI/UX feedback. Defaults to the generation model above.
                Use a faster/cheaper model (e.g. Sonnet) for edit-pass tasks.
              </p>
              <div className={styles.fieldRow}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-prototype-regen-bedrock-model">Bedrock Model</label>
                  <select
                    id="ps-prototype-regen-bedrock-model"
                    className={styles.select}
                    value={edit.designPrototypeRegenBedrockModelId}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, designPrototypeRegenBedrockModelId: e.target.value } : prev)}
                    disabled={upsert.isPending}
                   {...{ 'data-testid': 'ps-prototype-regen-bedrock-model' }}>
                    <option value="">Same as generation model</option>
                    {bedrockModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-prototype-regen-bedrock-max-tokens">Max Output Tokens</label>
                  <select
                    id="ps-prototype-regen-bedrock-max-tokens"
                    className={styles.select}
                    value={String(edit.designPrototypeRegenBedrockMaxTokens)}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, designPrototypeRegenBedrockMaxTokens: Number(e.target.value) } : prev)}
                    disabled={upsert.isPending}
                   {...{ 'data-testid': 'ps-prototype-regen-bedrock-max-tokens' }}>
                    <option value="8000">8 000</option>
                    <option value="16000">16 000 (default)</option>
                    <option value="32000">32 000</option>
                    <option value="64000">64 000</option>
                  </select>
                </div>
              </div>

              <p className={styles.label} style={{ marginBottom: 6, marginTop: 24, fontWeight: 600 }}>Apex UI Lab Generation</p>
              <p className={styles.accordionHelp} style={{ marginTop: 0 }}>
                Model used for freeform UI Lab design generation. Defaults to Sonnet if not set.
              </p>
              <div className={styles.fieldRow}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-ui-lab-bedrock-model">Bedrock Model</label>
                  <select
                    id="ps-ui-lab-bedrock-model"
                    className={styles.select}
                    value={edit.uiLabBedrockModelId}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, uiLabBedrockModelId: e.target.value } : prev)}
                    disabled={upsert.isPending}
                   {...{ 'data-testid': 'ps-ui-lab-bedrock-model' }}>
                    <option value="">Use service default</option>
                    {bedrockModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-ui-lab-bedrock-max-tokens">Max Output Tokens</label>
                  <select
                    id="ps-ui-lab-bedrock-max-tokens"
                    className={styles.select}
                    value={String(edit.uiLabBedrockMaxTokens)}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, uiLabBedrockMaxTokens: Number(e.target.value) } : prev)}
                    disabled={upsert.isPending}
                   {...{ 'data-testid': 'ps-ui-lab-bedrock-max-tokens' }}>
                    <option value="8000">8 000</option>
                    <option value="16000">16 000 (default)</option>
                    <option value="32000">32 000</option>
                    <option value="64000">64 000</option>
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-ui-lab-bedrock-timeout">Bedrock Timeout</label>
                  <select
                    id="ps-ui-lab-bedrock-timeout"
                    className={styles.select}
                    value={String(edit.uiLabBedrockTimeoutMs)}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, uiLabBedrockTimeoutMs: Number(e.target.value) } : prev)}
                    disabled={upsert.isPending}
                   {...{ 'data-testid': 'ps-ui-lab-bedrock-timeout' }}>
                    <option value="300000">5 min</option>
                    <option value="480000">8 min</option>
                    <option value="600000">10 min (default)</option>
                    <option value="720000">12 min</option>
                    <option value="900000">15 min</option>
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-ui-lab-temperature">Temperature</label>
                  <select
                    id="ps-ui-lab-temperature"
                    className={styles.select}
                    value={String(edit.uiLabBedrockTemperature)}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, uiLabBedrockTemperature: Number(e.target.value) } : prev)}
                    disabled={upsert.isPending}
                   {...{ 'data-testid': 'ps-ui-lab-temperature' }}>
                    <option value="0">0 — deterministic (default)</option>
                    <option value="0.3">0.3 — slight variation</option>
                    <option value="0.5">0.5 — balanced</option>
                    <option value="0.7">0.7 — creative</option>
                    <option value="1">1.0 — max variation</option>
                  </select>
                </div>
              </div>

              <p className={styles.label} style={{ marginBottom: 6, marginTop: 16, fontWeight: 600 }}>Apex UI Lab Regeneration (Edit Pass)</p>
              <p className={styles.accordionHelp} style={{ marginTop: 0 }}>
                Model used when applying feedback or element-scoped edits in UI Lab. Defaults to the generation model above.
              </p>
              <div className={styles.fieldRow}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-ui-lab-regen-model">Bedrock Model</label>
                  <select
                    id="ps-ui-lab-regen-model"
                    className={styles.select}
                    value={edit.uiLabRegenBedrockModelId}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, uiLabRegenBedrockModelId: e.target.value } : prev)}
                    disabled={upsert.isPending}
                   {...{ 'data-testid': 'ps-ui-lab-regen-model' }}>
                    <option value="">Same as generation model</option>
                    {bedrockModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-ui-lab-regen-max-tokens">Max Output Tokens</label>
                  <select
                    id="ps-ui-lab-regen-max-tokens"
                    className={styles.select}
                    value={String(edit.uiLabRegenBedrockMaxTokens)}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, uiLabRegenBedrockMaxTokens: Number(e.target.value) } : prev)}
                    disabled={upsert.isPending}
                   {...{ 'data-testid': 'ps-ui-lab-regen-max-tokens' }}>
                    <option value="8000">8 000</option>
                    <option value="16000">16 000 (default)</option>
                    <option value="32000">32 000</option>
                    <option value="64000">64 000</option>
                  </select>
                </div>
              </div>
            </AccordionSection>

            {/* Section 5: Reviewers */}
            <AccordionSection
              title="Reviewers"
              hint={
                (designDocApproverIds.length + prdApproverIds.length + designDocApproverGroupIds.length + prdApproverGroupIds.length + designPrototypeApproverIds.length + testCaseApproverIds.length + testCaseApproverGroupIds.length + adrApproverIds.length + adrApproverGroupIds.length) > 0
                  ? `${designDocApproverIds.length + prdApproverIds.length + designPrototypeApproverIds.length + testCaseApproverIds.length + adrApproverIds.length} people, ${designDocApproverGroupIds.length + prdApproverGroupIds.length + designPrototypeApproverGroupIds.length + testCaseApproverGroupIds.length + adrApproverGroupIds.length} groups`
                  : undefined
              }
              expanded={expandedSections.approvers}
              onToggle={() => toggleSection('approvers')}
            >
              <p className={styles.accordionHelp}>
                Designate who can review documents for this project. Users must also have the appropriate review permission.
              </p>

              {renderApproverSection('design_doc', 'Design Doc Reviewers', designDocApproverIds, setDesignDocApproverIds, designDocApproverGroupIds, setDesignDocApproverGroupIds)}
              {renderApproverSection('prd', 'PRD Reviewers', prdApproverIds, setPrdApproverIds, prdApproverGroupIds, setPrdApproverGroupIds)}
              {renderApproverSection('design_prototype', 'Design Prototype Reviewers', designPrototypeApproverIds, setDesignPrototypeApproverIds, designPrototypeApproverGroupIds, setDesignPrototypeApproverGroupIds)}
              {renderApproverSection('test_case', 'QA Reviewers', testCaseApproverIds, setTestCaseApproverIds, testCaseApproverGroupIds, setTestCaseApproverGroupIds)}
              {renderApproverSection('adr', 'Architecture Decision Record Reviewers', adrApproverIds, setAdrApproverIds, adrApproverGroupIds, setAdrApproverGroupIds)}
            </AccordionSection>

            {/* Section 6: Quick Skill Pills */}
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
                         {...{ 'data-testid': `ps-skill-pill-model-${idx}` }}>
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
                         {...{ 'data-testid': `ps-skill-pill-up-${idx}` }}>
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
                         {...{ 'data-testid': `ps-skill-pill-down-${idx}` }}>
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
                         {...{ 'data-testid': `ps-skill-pill-remove-${idx}` }}>
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
                        disabled={upsert.isPending} {...{ 'data-testid': `ps-skill-pill-description-${idx}` }} />
                      <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', marginTop: '4px' }}>
                        <input
                          type="checkbox"
                          checked={pill.bypassScopePolicy ?? false}
                          onChange={(e) => {
                            const pills = [...edit.quickSkillPills];
                            pills[idx] = { ...pills[idx], bypassScopePolicy: e.target.checked || null };
                            setEdit((prev) => prev ? { ...prev, quickSkillPills: pills } : prev);
                          }}
                          disabled={upsert.isPending} {...{ 'data-testid': `ps-skill-pill-bypass-scope-${idx}` }} />
                        Bypass scope guardrail (allows this skill to research public/external topics)
                      </label>
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
                    disabled={upsert.isPending || isLoadingSkills || !edit.skillRepo} {...{ 'data-testid': 'ps-pill-label' }} />
                </div>
                <div className={styles.field} style={{ flex: 1 }}>
                  <label className={styles.label} htmlFor="ps-pill-skill">Skill</label>
                  <select
                    id="ps-pill-skill"
                    className={styles.select}
                    disabled={upsert.isPending || isLoadingSkills || !edit.skillRepo}
                   {...{ 'data-testid': 'ps-pill-skill' }}>
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
                   {...{ 'data-testid': 'ps-pill-model' }}>
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
                 {...{ 'data-testid': 'ps-skill-pill-add' }}>
                  Add
                </button>
              </div>
            </AccordionSection>

            {/* Section 7: Quick MCP Pills */}
            <AccordionSection
              title="Quick MCP Pills"
              hint={edit.quickMcpPills.length > 0 ? `${edit.quickMcpPills.length} configured` : undefined}
              expanded={expandedSections.mcpPills}
              onToggle={() => toggleSection('mcpPills')}
            >
              <p className={styles.accordionHelp}>
                Shortcut pills that wire an external MCP server into the chat agent alongside the built-in ADO skills.
                Choose <strong>HTTP</strong> for hosted endpoints (e.g. mcp.twilio.com) or <strong>stdio</strong> for
                locally-installed CLI packages (e.g. <code>npx sendgrid-mcp</code>).
              </p>

              {edit.quickMcpPills.length > 0 && (
                <div className={styles.pillList}>
                  {edit.quickMcpPills.map((pill, idx) => (
                    <div key={idx} className={styles.pillItem}>
                      <div className={styles.pillItemRow}>
                        <span className={styles.pillLabel}>{pill.label}</span>
                        <span className={styles.pillPath}>{pill.mcpServerName} · {pill.transport}</span>
                        <select
                          className={styles.select}
                          style={{ flex: '0 0 10rem', height: '28px', padding: '4px 8px', fontSize: '12px' }}
                          value={pill.model ?? ''}
                          onChange={(e) => {
                            const pills = [...edit.quickMcpPills];
                            pills[idx] = { ...pills[idx], model: e.target.value || null };
                            setEdit((prev) => prev ? { ...prev, quickMcpPills: pills } : prev);
                          }}
                          disabled={upsert.isPending || isLoadingModels}
                         {...{ 'data-testid': `ps-mcp-pill-model-${idx}` }}>
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
                            const pills = [...edit.quickMcpPills];
                            [pills[idx - 1], pills[idx]] = [pills[idx], pills[idx - 1]];
                            setEdit((prev) => prev ? { ...prev, quickMcpPills: pills } : prev);
                          }}
                          title="Move up"
                         {...{ 'data-testid': `ps-mcp-pill-up-${idx}` }}>↑</button>
                        <button
                          type="button"
                          className={styles.btnAction}
                          disabled={idx === edit.quickMcpPills.length - 1}
                          onClick={() => {
                            const pills = [...edit.quickMcpPills];
                            [pills[idx], pills[idx + 1]] = [pills[idx + 1], pills[idx]];
                            setEdit((prev) => prev ? { ...prev, quickMcpPills: pills } : prev);
                          }}
                          title="Move down"
                         {...{ 'data-testid': `ps-mcp-pill-down-${idx}` }}>↓</button>
                        <button
                          type="button"
                          className={`${styles.btnAction} ${styles.btnActionDanger}`}
                          onClick={() => {
                            const pills = edit.quickMcpPills.filter((_, i) => i !== idx);
                            setEdit((prev) => prev ? { ...prev, quickMcpPills: pills } : prev);
                          }}
                          title="Remove pill"
                         {...{ 'data-testid': `ps-mcp-pill-remove-${idx}` }}>Remove</button>
                      </div>
                      {pill.transport === 'http' ? (
                        <input
                          className={styles.input}
                          style={{ fontSize: '0.8rem', padding: '4px 8px', marginTop: '4px' }}
                          placeholder="URL (e.g. https://mcp.twilio.com/docs)"
                          value={pill.url}
                          onChange={(e) => {
                            const pills = [...edit.quickMcpPills];
                            pills[idx] = { ...pills[idx], url: e.target.value } as typeof pill;
                            setEdit((prev) => prev ? { ...prev, quickMcpPills: pills } : prev);
                          }}
                          disabled={upsert.isPending} {...{ 'data-testid': `ps-mcp-pill-url-${idx}` }} />
                      ) : (
                        <>
                          <input
                            className={styles.input}
                            style={{ fontSize: '0.8rem', padding: '4px 8px', marginTop: '4px' }}
                            placeholder="Command (e.g. npx)"
                            value={pill.command}
                            onChange={(e) => {
                              const pills = [...edit.quickMcpPills];
                              pills[idx] = { ...pills[idx], command: e.target.value } as typeof pill;
                              setEdit((prev) => prev ? { ...prev, quickMcpPills: pills } : prev);
                            }}
                            disabled={upsert.isPending} {...{ 'data-testid': `ps-mcp-pill-command-${idx}` }} />
                          <input
                            className={styles.input}
                            style={{ fontSize: '0.8rem', padding: '4px 8px', marginTop: '4px' }}
                            placeholder="Args (space-separated, e.g. -y sendgrid-mcp)"
                            value={(pill.args ?? []).join(' ')}
                            onChange={(e) => {
                              const pills = [...edit.quickMcpPills];
                              const args = e.target.value.trim() ? e.target.value.trim().split(/\s+/) : [];
                              pills[idx] = { ...pills[idx], args } as typeof pill;
                              setEdit((prev) => prev ? { ...prev, quickMcpPills: pills } : prev);
                            }}
                            disabled={upsert.isPending} {...{ 'data-testid': `ps-mcp-pill-args-${idx}` }} />
                          <input
                            className={styles.input}
                            style={{ fontSize: '0.8rem', padding: '4px 8px', marginTop: '4px' }}
                            placeholder="Env vars (KEY=${ENV_VAR}, comma-separated, e.g. SENDGRID_API_KEY=${SENDGRID_API_KEY})"
                            value={Object.entries(pill.env ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')}
                            onChange={(e) => {
                              const pills = [...edit.quickMcpPills];
                              const env: Record<string, string> = {};
                              for (const pair of e.target.value.split(',')) {
                                const eq = pair.indexOf('=');
                                if (eq > 0) env[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
                              }
                              pills[idx] = { ...pills[idx], env: Object.keys(env).length ? env : null } as typeof pill;
                              setEdit((prev) => prev ? { ...prev, quickMcpPills: pills } : prev);
                            }}
                            disabled={upsert.isPending} {...{ 'data-testid': `ps-mcp-pill-env-${idx}` }} />
                        </>
                      )}
                      <input
                        className={styles.input}
                        style={{ fontSize: '0.8rem', padding: '4px 8px', marginTop: '4px' }}
                        placeholder="System prompt hint (e.g. You have access to SendGrid email analytics tools)"
                        value={pill.systemPromptHint ?? ''}
                        onChange={(e) => {
                          const pills = [...edit.quickMcpPills];
                          pills[idx] = { ...pills[idx], systemPromptHint: e.target.value || null };
                          setEdit((prev) => prev ? { ...prev, quickMcpPills: pills } : prev);
                        }}
                        disabled={upsert.isPending} {...{ 'data-testid': `ps-mcp-pill-system-prompt-${idx}` }} />
                      <input
                        className={styles.input}
                        style={{ fontSize: '0.8rem', padding: '4px 8px', marginTop: '4px' }}
                        placeholder="Description shown to users when selected"
                        value={pill.description ?? ''}
                        onChange={(e) => {
                          const pills = [...edit.quickMcpPills];
                          pills[idx] = { ...pills[idx], description: e.target.value || null };
                          setEdit((prev) => prev ? { ...prev, quickMcpPills: pills } : prev);
                        }}
                        disabled={upsert.isPending} {...{ 'data-testid': `ps-mcp-pill-description-${idx}` }} />
                    </div>
                  ))}
                </div>
              )}

              {/* Add new MCP pill form */}
              <McpPillAddForm
                availableModels={availableModels}
                isLoadingModels={isLoadingModels}
                isPending={upsert.isPending}
                onAdd={(pill) => setEdit((prev) => prev ? { ...prev, quickMcpPills: [...prev.quickMcpPills, pill] } : prev)} {...{ 'data-testid': 'ps-mcp-pill-add-form' }} />
            </AccordionSection>

            {formError && <p className={styles.formError}>{formError}</p>}
            <div className={styles.formActions} style={{ marginTop: '12px' }}>
              <button className={styles.btnCancel} onClick={handleCancel} type="button" disabled={upsert.isPending} {...{ 'data-testid': 'ps-form-cancel' }}>
                Cancel
              </button>
              <button className={styles.btnPrimary} onClick={() => void handleSave()} type="button" disabled={upsert.isPending} {...{ 'data-testid': 'ps-form-save' }}>
                {upsert.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}

        {/* ── Project config list ─────────────────────────────────────── */}
        {projectConfigs.length === 0 && !edit ? (
          <div className={styles.empty}>
            <p>No skill settings configured for <strong>{selectedProject}</strong>. Click <strong>+ Add Repo Config</strong> to get started.</p>
          </div>
        ) : (
          !edit && (
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.th}>Name</th>
                    <th className={styles.th}>Skill Repo / Branch</th>
                    <th className={styles.th}>Reviewers</th>
                    <th className={styles.th}>Last Updated</th>
                    <th className={styles.th}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {projectConfigs.map((config) => (
                    <tr key={config.id} className={styles.tr}>
                      <td className={styles.td}>
                        <span className={styles.projectName}>{config.friendlyName}</span>
                        {config.isDefault && (
                          <span className={styles.approverBadge} style={{ marginLeft: '6px', fontSize: '0.7rem' }}>Default</span>
                        )}
                      </td>
                      <td className={styles.td}>
                        {config.skillProvider === 'github' && (
                          <span className={styles.approverBadge} style={{ marginRight: '6px', fontSize: '0.7rem' }}>GitHub</span>
                        )}
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
                          <RepoCheckoutControls config={config} project={selectedProject} />
                          <button
                            className={styles.btnAction}
                            onClick={() => handleEditRow(config)}
                            type="button"
                            disabled={!!edit || remove.isPending}
                           {...{ 'data-testid': `ps-config-edit-${config.id}` }}>
                            Edit
                          </button>
                          <button
                            className={`${styles.btnAction} ${styles.btnActionDanger}`}
                            onClick={() => void handleDelete(config)}
                            type="button"
                            disabled={deletingId === config.id || remove.isPending}
                           {...{ 'data-testid': `ps-config-delete-${config.id}` }}>
                            {deletingId === config.id ? 'Deleting…' : 'Delete'}
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

        {formError && !edit && <p className={styles.formError}>{formError}</p>}

        {/* ── Foundation Skills (read-only) ────────────────────────────── */}
        {!edit && selectedProject && (
          <FoundationSkillsProjectView project={selectedProject} />
        )}
      </div>
    </div>
  );
};

// ── FoundationSkillsProjectView ───────────────────────────────────────────────

const FoundationSkillsProjectView: React.FC<{ project: string }> = ({ project }) => {
  const [expanded, setExpanded] = useState(false);
  const { data: skills = [], isLoading } = useProjectAvailableSkills(project);

  return (
    <div className={styles.fsSection}>
      <button
        type="button"
        className={styles.fsToggle}
        onClick={() => setExpanded(p => !p)}
        aria-expanded={expanded}
       {...{ 'data-testid': 'ps-foundation-skills-toggle' }}>
        <span className={styles.fsToggleTitle}>Foundation Skills</span>
        {skills.length > 0 && (
          <span className={styles.fsCount}>{skills.length} available</span>
        )}
        <span className={`${styles.fsCaret} ${expanded ? styles.fsCaretOpen : ''}`} aria-hidden="true">▼</span>
      </button>

      {expanded && (
        <div className={styles.fsBody}>
          <p className={styles.fsHint}>
            Foundation skills available to <strong>{project}</strong> from the latest published release.
            Contact a Platform Admin to request additional skills.
          </p>
          {isLoading ? (
            <p className={styles.fsEmpty}>Loading…</p>
          ) : skills.length === 0 ? (
            <p className={styles.fsEmpty}>
              No foundation skills have been released to this project yet.
            </p>
          ) : (
            <div className={styles.fsTableWrap}>
              <table className={styles.fsTable}>
                <thead>
                  <tr>
                    <th>Skill</th>
                    <th>Summary</th>
                    <th>Version</th>
                  </tr>
                </thead>
                <tbody>
                  {skills.map(skill => (
                    <tr key={skill.name}>
                      <td className={styles.fsSkillName}>{skill.name}</td>
                      <td className={styles.fsSkillSummary}>{skill.summary}</td>
                      <td><span className={styles.fsVersion}>v{skill.version}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
