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
import type { ProjectSkillConfig, UpsertProjectSkillConfigRequest, QuickSkillPill, QuickMcpPill, QuickMcpPillHttp, QuickMcpPillStdio } from '../../shared/types/projectSettings';
import type { ApprovalMode } from '../../shared/types/approvals';
import { useSkillRepos, useSkillBranches, useSkillList } from '../hooks/useChatThreads';
import { useUsers } from '../hooks/useRbac';
import { useGroupsWithMembers } from '../hooks/useGroups';
import { GroupAwarePeoplePicker } from './GroupAwarePeoplePicker';
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
  { key: 'designPrototypeSkillPath' as const, label: 'Design Prototype Skill', desc: 'Guides HTML prototype generation from approved requirements', emptyLabel: 'None (use default)' },
  { key: 'designDocSkillPath' as const, label: 'Design Doc Skill', desc: 'Produces the technical design document', emptyLabel: 'None (use default)' },
  { key: 'designDocAssistantSkillPath' as const, label: 'Design Doc Assistant Skill', desc: 'Provides AI assistance during design doc editing', emptyLabel: 'None (use default model, no skill)' },
  { key: 'testCaseSkillPath' as const, label: 'Test Case Skill', desc: 'Generates QA test cases after PRD generation', emptyLabel: 'None (skip test-case generation)' },
  { key: 'designDocValidationSkillPath' as const, label: 'Design Doc Validation Skill', desc: 'Validates completed design documents', emptyLabel: 'None (skip validation phase)' },
  { key: 'prdValidationSkillPath' as const, label: 'PRD Validation Skill', desc: 'Validates PRD spec after all artifacts are ready', emptyLabel: 'None (skip PRD validation)' },
  { key: 'developmentSkillPath' as const, label: 'Development Skill', desc: 'Guides the AI coding agent during development sessions', emptyLabel: 'None (use default behavior)' },
  { key: 'standupSkillPath' as const, label: 'Standup Skill', desc: 'Custom standup procedure for participant conversations', emptyLabel: 'None (use built-in default)' },
] as const;

const MODEL_FIELDS = [
  { key: 'interviewModel' as const, label: 'Interview Model' },
  { key: 'prdModel' as const, label: 'PRD Model' },
  { key: 'designDocModel' as const, label: 'Design Doc Model' },
  { key: 'designDocAssistantModel' as const, label: 'Design Doc Assistant Model' },
  { key: 'testCaseModel' as const, label: 'Test Case Model' },
  { key: 'designDocValidationModel' as const, label: 'Design Doc Validation Model' },
  { key: 'prdValidationModel' as const, label: 'PRD Validation Model' },
  { key: 'developmentModel' as const, label: 'Development Model' },
  { key: 'standupModel' as const, label: 'Standup Model' },
] as const;

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
          >
            {t === 'stdio' ? 'stdio (npx / command)' : 'HTTP (hosted URL)'}
          </button>
        ))}
      </div>

      {/* Common fields */}
      <div className={styles.pillAddRow}>
        <div className={styles.field} style={{ flex: '0 0 10rem' }}>
          <label className={styles.label}>Label</label>
          <input className={styles.input} placeholder="e.g. SendGrid" value={label} onChange={(e) => setLabel(e.target.value)} disabled={isPending} />
        </div>
        <div className={styles.field} style={{ flex: '0 0 10rem' }}>
          <label className={styles.label}>Server Name</label>
          <input className={styles.input} placeholder="e.g. sendgrid" value={mcpServerName} onChange={(e) => setMcpServerName(e.target.value)} disabled={isPending} />
        </div>
        <div className={styles.field} style={{ flex: '0 0 10rem' }}>
          <label className={styles.label}>Model override</label>
          <select className={styles.select} value={model} onChange={(e) => setModel(e.target.value)} disabled={isPending || isLoadingModels}>
            <option value="">Default model</option>
            {availableModels.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
          </select>
        </div>
      </div>

      {/* Transport-specific fields */}
      {transport === 'http' ? (
        <input className={styles.input} placeholder="HTTP URL (e.g. https://mcp.twilio.com/docs)" value={url} onChange={(e) => setUrl(e.target.value)} disabled={isPending} />
      ) : (
        <>
          <div className={styles.pillAddRow}>
            <div className={styles.field} style={{ flex: '0 0 8rem' }}>
              <label className={styles.label}>Command</label>
              <input className={styles.input} placeholder="npx" value={command} onChange={(e) => setCommand(e.target.value)} disabled={isPending} />
            </div>
            <div className={styles.field} style={{ flex: 1 }}>
              <label className={styles.label}>Args (space-separated)</label>
              <input className={styles.input} placeholder="-y sendgrid-mcp" value={args} onChange={(e) => setArgs(e.target.value)} disabled={isPending} />
            </div>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Env vars (KEY=$&#123;ENV_VAR&#125;, comma-separated)</label>
            <input className={styles.input} placeholder="SENDGRID_API_KEY=${SENDGRID_API_KEY}" value={envStr} onChange={(e) => setEnvStr(e.target.value)} disabled={isPending} />
            <span className={styles.skillDescription}>Values like {'${SENDGRID_API_KEY}'} are resolved from the server&apos;s environment at runtime — secrets stay out of the database.</span>
          </div>
        </>
      )}

      {/* Optional metadata */}
      <input className={styles.input} style={{ fontSize: '0.8rem' }} placeholder="System prompt hint (e.g. You have access to SendGrid email analytics tools for querying email activity, bounces, and stats)" value={systemPromptHint} onChange={(e) => setSystemPromptHint(e.target.value)} disabled={isPending} />
      <input className={styles.input} style={{ fontSize: '0.8rem' }} placeholder="Description shown to users when pill is selected" value={description} onChange={(e) => setDescription(e.target.value)} disabled={isPending} />

      <div>
        <button type="button" className={styles.btnAction} onClick={handleAdd} disabled={isPending}>
          Add MCP Pill
        </button>
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
  skillRepo: string;
  skillBranch: string;
  interviewSkillPath: string;
  prdSkillPath: string;
  designDocSkillPath: string;
  designDocAssistantSkillPath: string;
  designPrototypeSkillPath: string;
  testCaseSkillPath: string;
  designDocValidationSkillPath: string;
  prdValidationSkillPath: string;
  developmentSkillPath: string;
  standupSkillPath: string;
  interviewModel: string;
  prdModel: string;
  designDocModel: string;
  designDocAssistantModel: string;
  designPrototypeModel: string;
  testCaseModel: string;
  designDocValidationModel: string;
  prdValidationModel: string;
  developmentModel: string;
  standupModel: string;
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
  quickSkillPills: QuickSkillPill[];
  quickMcpPills: QuickMcpPill[];
  approvalMode: ApprovalMode;
  isNew: boolean;
}

const emptyEdit = (): EditState => ({
  id: null, project: '', friendlyName: '', isDefault: false,
  skillRepo: '', skillBranch: '',
  interviewSkillPath: '', prdSkillPath: '', designDocSkillPath: '',
  designDocAssistantSkillPath: '', designPrototypeSkillPath: '', testCaseSkillPath: '', designDocValidationSkillPath: '', prdValidationSkillPath: '',
  developmentSkillPath: '', standupSkillPath: '',
  interviewModel: '', prdModel: '', designDocModel: '',
  designDocAssistantModel: '', designPrototypeModel: '', testCaseModel: '', designDocValidationModel: '', prdValidationModel: '',
  developmentModel: '', standupModel: '',
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
  quickSkillPills: [], quickMcpPills: [], approvalMode: 'any_one', isNew: true,
});

export const AdminProjectSettings: React.FC<AdminProjectSettingsProps> = ({
  selectedProject = '',
}) => {
  // ── Data hooks ─────────────────────────────────────────────────────────
  const { data: configs = [], isLoading, isError } = useAllProjectSkillConfigs();
  const upsert = useUpsertProjectSkillConfig();
  const remove = useDeleteProjectSkillConfig();
  const { data: availableModels = [], isLoading: isLoadingModels } = useAvailableModels();
  const { data: bedrockModels = [] } = useAvailableBedrockModels();
  const { data: allUsers = [] } = useUsers();

  // ── Derived: filter to current project ────────────────────────────────
  const projectConfigs = configs.filter((c) => c.project === selectedProject);

  // ── Local state ────────────────────────────────────────────────────────
  const [edit, setEdit] = useState<EditState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Accordion expanded state
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    repo: true,
    skills: false,
    models: false,
    bedrockReview: false,
    approvers: false,
    pills: false,
    mcpPills: false,
  });

  // Approver local state
  const [designDocApproverIds, setDesignDocApproverIds] = useState<string[]>([]);
  const [prdApproverIds, setPrdApproverIds] = useState<string[]>([]);
  const [designDocApproverGroupIds, setDesignDocApproverGroupIds] = useState<string[]>([]);
  const [prdApproverGroupIds, setPrdApproverGroupIds] = useState<string[]>([]);
  const [designPrototypeApproverIds, setDesignPrototypeApproverIds] = useState<string[]>([]);
  const [designPrototypeApproverGroupIds, setDesignPrototypeApproverGroupIds] = useState<string[]>([]);
  const [testCaseApproverIds, setTestCaseApproverIds] = useState<string[]>([]);
  const [testCaseApproverGroupIds, setTestCaseApproverGroupIds] = useState<string[]>([]);

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
  const { data: approversData } = useProjectApprovers(edit?.id || null);
  const setApprovers = useSetProjectApprovers();
  const { data: allGroupsWithMembers = [] } = useGroupsWithMembers();

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
  }, [approversData, edit?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Computed ───────────────────────────────────────────────────────────

  const groupsWithMembers = allGroupsWithMembers;

  // ── Handlers ───────────────────────────────────────────────────────────

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleAddNew = () => {
    setEdit({ ...emptyEdit(), project: selectedProject });
    setFormError(null);
    setExpandedSections({ repo: true, skills: false, models: false, bedrockReview: false, approvers: false, pills: false, mcpPills: false });
  };

  const handleEditRow = (config: ProjectSkillConfig) => {
    setEdit({
      id: config.id,
      project: config.project,
      friendlyName: config.friendlyName,
      isDefault: config.isDefault,
      skillRepo: config.skillRepo,
      skillBranch: config.skillBranch,
      interviewSkillPath: config.interviewSkillPath ?? '',
      prdSkillPath: config.prdSkillPath ?? '',
      designDocSkillPath: config.designDocSkillPath ?? '',
      designDocAssistantSkillPath: config.designDocAssistantSkillPath ?? '',
      designPrototypeSkillPath: config.designPrototypeSkillPath ?? '',
      testCaseSkillPath: config.testCaseSkillPath ?? '',
      designDocValidationSkillPath: config.designDocValidationSkillPath ?? '',
      prdValidationSkillPath: config.prdValidationSkillPath ?? '',
      developmentSkillPath: config.developmentSkillPath ?? '',
      standupSkillPath: config.standupSkillPath ?? '',
      interviewModel: config.interviewModel ?? '',
      prdModel: config.prdModel ?? '',
      designDocModel: config.designDocModel ?? '',
      designDocAssistantModel: config.designDocAssistantModel ?? '',
      designPrototypeModel: config.designPrototypeModel ?? '',
      testCaseModel: config.testCaseModel ?? '',
      designDocValidationModel: config.designDocValidationModel ?? '',
      prdValidationModel: config.prdValidationModel ?? '',
      developmentModel: config.developmentModel ?? '',
      standupModel: config.standupModel ?? '',
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
      quickSkillPills: config.quickSkillPills ?? [],
      quickMcpPills: config.quickMcpPills ?? [],
      approvalMode: config.approvalMode ?? 'any_one',
      isNew: false,
    });
    setFormError(null);
    setExpandedSections({ repo: true, skills: false, models: false, approvers: false, pills: false, mcpPills: false });
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
        skillRepo: edit.skillRepo.trim(),
        skillBranch: edit.skillBranch.trim(),
        interviewSkillPath: edit.interviewSkillPath || null,
        prdSkillPath: edit.prdSkillPath || null,
        designDocSkillPath: edit.designDocSkillPath || null,
        designDocAssistantSkillPath: edit.designDocAssistantSkillPath || null,
        designPrototypeSkillPath: edit.designPrototypeSkillPath || null,
        testCaseSkillPath: edit.testCaseSkillPath || null,
        designDocValidationSkillPath: edit.designDocValidationSkillPath || null,
        prdValidationSkillPath: edit.prdValidationSkillPath || null,
        developmentSkillPath: edit.developmentSkillPath || null,
        standupSkillPath: edit.standupSkillPath || null,
        interviewModel: edit.interviewModel || null,
        prdModel: edit.prdModel || null,
        designDocModel: edit.designDocModel || null,
        designDocAssistantModel: edit.designDocAssistantModel || null,
        designPrototypeModel: edit.designPrototypeModel || null,
        testCaseModel: edit.testCaseModel || null,
        designDocValidationModel: edit.designDocValidationModel || null,
        prdValidationModel: edit.prdValidationModel || null,
        developmentModel: edit.developmentModel || null,
        standupModel: edit.standupModel || null,
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
        quickSkillPills: edit.quickSkillPills.length > 0 ? edit.quickSkillPills : null,
        quickMcpPills: edit.quickMcpPills.length > 0 ? edit.quickMcpPills : null,
        approvalMode: edit.approvalMode,
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
        designDocApproverGroupIds.length > 0 ||
        prdApproverGroupIds.length > 0 || designPrototypeApproverGroupIds.length > 0 ||
        testCaseApproverGroupIds.length > 0 ||
        (approversData && (approversData.approvers.length > 0 || approversData.approverGroups.length > 0));
      if (hasApprovers) {
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
        });
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
    if (ddCount === 0 && prdCount === 0 && dpCount === 0 && tcCount === 0) {
      return <span className={`${styles.approverBadge} ${styles.approverBadgeEmpty}`}>No reviewers</span>;
    }
    const parts: string[] = [];
    if (ddCount > 0) parts.push(`${ddCount} design doc`);
    if (dpCount > 0) parts.push(`${dpCount} design prototype`);
    if (prdCount > 0) parts.push(`${prdCount} PRD`);
    if (tcCount > 0) parts.push(`${tcCount} QA`);
    return <span className={styles.approverBadge}>{parts.join(' · ')}</span>;
  };

  const renderApproverSection = (
    title: string,
    userIds: string[],
    setUserIds: React.Dispatch<React.SetStateAction<string[]>>,
    groupIds: string[],
    setGroupIds: React.Dispatch<React.SetStateAction<string[]>>,
  ) => (
    <div className={styles.approverSubSection}>
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
            <button className={styles.btnPrimary} onClick={handleAddNew} type="button">
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
                  <label className={styles.label} htmlFor="ps-friendlyName">Friendly Name</label>
                  <input
                    id="ps-friendlyName"
                    className={styles.input}
                    value={edit.friendlyName}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, friendlyName: e.target.value } : prev)}
                    placeholder="e.g. Main Skills, Feature Branch"
                    disabled={upsert.isPending}
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-isDefault">
                    <input
                      id="ps-isDefault"
                      type="checkbox"
                      checked={edit.isDefault}
                      onChange={(e) => setEdit((prev) => prev ? { ...prev, isDefault: e.target.checked } : prev)}
                      disabled={upsert.isPending}
                      style={{ marginRight: '6px' }}
                    />
                    Default config
                  </label>
                  <span className={styles.skillDescription}>Auto-selected when user picks this project</span>
                </div>
              </div>

              <div className={styles.formGridThreeCol}>
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
                      disabled={sf.key === 'designPrototypeSkillPath' || upsert.isPending || isLoadingSkills || !edit.skillRepo}
                    >
                      <option value="">{sf.emptyLabel}</option>
                      {skillList.map((s) => (
                        <option key={s.id} value={s.path}>{s.name}</option>
                      ))}
                    </select>
                    <span className={styles.skillDescription}>
                      {sf.key === 'designPrototypeSkillPath'
                        ? 'Uses built-in Bedrock prompt — skill override not yet supported'
                        : sf.desc}
                    </span>
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

            {/* Section 4: Apex Bedrock Models */}
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
                  >
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
                  >
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
                  >
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
                  >
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
                  >
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
                  >
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
                  >
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
                  >
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
                  >
                    <option value="8000">8 000</option>
                    <option value="16000">16 000 (default)</option>
                    <option value="32000">32 000</option>
                    <option value="64000">64 000</option>
                  </select>
                </div>
              </div>

              <p className={styles.label} style={{ marginBottom: 6, marginTop: 16, fontWeight: 600 }}>PRD Validation Score Threshold</p>
              <p className={styles.accordionHelp} style={{ marginTop: 0 }}>
                Minimum validation score (%) required for a PRD to pass the readiness gate.
                Defaults to 90% if not set.
              </p>
              <div className={styles.fieldRow}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ps-validation-threshold">Pass Threshold (%)</label>
                  <select
                    id="ps-validation-threshold"
                    className={styles.select}
                    value={String(edit.prdValidationScoreThreshold)}
                    onChange={(e) => setEdit((prev) => prev ? { ...prev, prdValidationScoreThreshold: Number(e.target.value) } : prev)}
                    disabled={upsert.isPending}
                  >
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
              </div>
            </AccordionSection>

            {/* Section 5: Reviewers */}
            <AccordionSection
              title="Reviewers"
              hint={
                (designDocApproverIds.length + prdApproverIds.length + designDocApproverGroupIds.length + prdApproverGroupIds.length + designPrototypeApproverIds.length + testCaseApproverIds.length + testCaseApproverGroupIds.length) > 0
                  ? `${designDocApproverIds.length + prdApproverIds.length + designPrototypeApproverIds.length + testCaseApproverIds.length} people, ${designDocApproverGroupIds.length + prdApproverGroupIds.length + designPrototypeApproverGroupIds.length + testCaseApproverGroupIds.length} groups`
                  : undefined
              }
              expanded={expandedSections.approvers}
              onToggle={() => toggleSection('approvers')}
            >
              <p className={styles.accordionHelp}>
                Designate who can review documents for this project. Users must also have the appropriate review permission.
              </p>

              <div className={styles.approvalModeSection}>
                <p className={styles.approverSubTitle}>Approval Mode</p>
                <div className={styles.approvalModeOptions}>
                  <label className={`${styles.approvalModeOption} ${edit.approvalMode === 'any_one' ? styles.approvalModeOptionSelected : ''}`}>
                    <input
                      type="radio"
                      name="approvalMode"
                      value="any_one"
                      checked={edit.approvalMode === 'any_one'}
                      onChange={() => setEdit((prev) => prev ? { ...prev, approvalMode: 'any_one' } : prev)}
                      disabled={upsert.isPending}
                      className={styles.approvalModeRadio}
                    />
                    <div>
                      <span className={styles.approvalModeLabel}>Any One</span>
                      <span className={styles.approvalModeDesc}>Document is approved when any assigned reviewer approves</span>
                    </div>
                  </label>
                  <label className={`${styles.approvalModeOption} ${edit.approvalMode === 'all_required' ? styles.approvalModeOptionSelected : ''}`}>
                    <input
                      type="radio"
                      name="approvalMode"
                      value="all_required"
                      checked={edit.approvalMode === 'all_required'}
                      onChange={() => setEdit((prev) => prev ? { ...prev, approvalMode: 'all_required' } : prev)}
                      disabled={upsert.isPending}
                      className={styles.approvalModeRadio}
                    />
                    <div>
                      <span className={styles.approvalModeLabel}>All Required</span>
                      <span className={styles.approvalModeDesc}>All assigned reviewers must approve the document</span>
                    </div>
                  </label>
                </div>
              </div>

              {renderApproverSection('Design Doc Reviewers', designDocApproverIds, setDesignDocApproverIds, designDocApproverGroupIds, setDesignDocApproverGroupIds)}
              {renderApproverSection('PRD Reviewers', prdApproverIds, setPrdApproverIds, prdApproverGroupIds, setPrdApproverGroupIds)}
              {renderApproverSection('Design Prototype Reviewers', designPrototypeApproverIds, setDesignPrototypeApproverIds, designPrototypeApproverGroupIds, setDesignPrototypeApproverGroupIds)}
              {renderApproverSection('QA Reviewers', testCaseApproverIds, setTestCaseApproverIds, testCaseApproverGroupIds, setTestCaseApproverGroupIds)}
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
                            const pills = [...edit.quickMcpPills];
                            [pills[idx - 1], pills[idx]] = [pills[idx], pills[idx - 1]];
                            setEdit((prev) => prev ? { ...prev, quickMcpPills: pills } : prev);
                          }}
                          title="Move up"
                        >↑</button>
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
                        >↓</button>
                        <button
                          type="button"
                          className={`${styles.btnAction} ${styles.btnActionDanger}`}
                          onClick={() => {
                            const pills = edit.quickMcpPills.filter((_, i) => i !== idx);
                            setEdit((prev) => prev ? { ...prev, quickMcpPills: pills } : prev);
                          }}
                          title="Remove pill"
                        >Remove</button>
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
                          disabled={upsert.isPending}
                        />
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
                            disabled={upsert.isPending}
                          />
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
                            disabled={upsert.isPending}
                          />
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
                            disabled={upsert.isPending}
                          />
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
                        disabled={upsert.isPending}
                      />
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
                        disabled={upsert.isPending}
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* Add new MCP pill form */}
              <McpPillAddForm
                availableModels={availableModels}
                isLoadingModels={isLoadingModels}
                isPending={upsert.isPending}
                onAdd={(pill) => setEdit((prev) => prev ? { ...prev, quickMcpPills: [...prev.quickMcpPills, pill] } : prev)}
              />
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
                            onClick={() => void handleDelete(config)}
                            type="button"
                            disabled={deletingId === config.id || remove.isPending}
                          >
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
      </div>
    </div>
  );
};
