import React, { useState } from 'react';
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
  type UpdateReleasePayload,
} from '../hooks/useFoundationSkillAdmin';
import { useProjects } from '../hooks/useProjects';
import type { FoundationSkillRelease, FoundationSkillRepoStatus } from '../../shared/types/foundationSkills';
import styles from './FoundationSkillsAdmin.module.css';

// ── Static catalog (mirrors foundation-skills/catalog.json) ──────────────────

interface CatalogEntry { name: string; summary: string; }

const SKILL_CATALOG: CatalogEntry[] = [
  { name: 'ui-lab',                   summary: 'Generate and edit interactive UI prototypes using the project\'s own design system.' },
  { name: 'issue-analysis',           summary: 'Structured priority/risk analysis for reported issues.' },
  { name: 'technical-analysis',       summary: 'Structured priority/risk analysis for technical backlog items.' },
  { name: 'feature-request-analysis', summary: 'Evaluate feature requests for clarity, feasibility, impact, and alignment.' },
  { name: 'design-doc-validation',    summary: 'Score design docs against a weighted rubric and produce a ValidationScorecard.' },
  { name: 'prd-spec-review',          summary: 'Interactive PRD quality gate: score, report, remediate, and re-score.' },
  { name: 'design-spec-review',       summary: 'Quality gate for design/tech-spec/assumptions output; depends on prd-spec-review.' },
  { name: 'to-prd',                   summary: 'PRD markdown and backlog JSON synthesized from a kickoff transcript.' },
  { name: 'prd-design-spec',          summary: 'Per-Feature design/tech-spec/assumptions; depends on to-prd.' },
  { name: 'kick-off',                 summary: 'Orchestrate classification → interview → design doc → TDD decomposition.' },
  { name: 'create-test-case',         summary: 'Senior-QA test cases from backlog JSON; depends on to-prd.' },
  { name: 'grill-with-docs',          summary: 'Relentless full-repo interview stress-testing a feature plan.' },
  { name: 'grill-design',             summary: 'Full-repo technical design interview.' },
  { name: 'app-knowledge',            summary: 'Full-repo product Q&A from docs and code.' },
  { name: 'daily-standup',            summary: 'Facilitate standup and produce a structured summary.' },
  { name: 'in-app-notifications',     summary: 'Implement or extend in-app notifications.' },
  { name: 'update-changelog',         summary: 'Changelog and version bump from git changes.' },
  { name: 'feature-flags',            summary: 'Add flags using the top-level split pattern.' },
  { name: 'rbac-management',          summary: 'Manage RBAC permissions and roles.' },
  { name: 'dev-orchestrator',         summary: 'Multi-agent implementation from a dev plan.' },
  { name: 'build-test-push',          summary: 'Build, lint, type-check, and test for push readiness.' },
  { name: 'fullstack-node-bff',       summary: 'Node BFF + React + shared-types standards.' },
  { name: 'postgresql-migrations',    summary: 'Safe Postgres migrations and ORM sync.' },
  { name: 'design-module-doc',        summary: 'Technical design doc for a module or subsystem.' },
  { name: 'adr-interview',            summary: 'Full-repo ADR interview and decision transcript.' },
  { name: 'adr-finalize',             summary: 'Transcript → MADR ADR; depends on adr-interview.' },
  { name: 'adr-assistant',            summary: 'Find, explain, update, or supersede ADRs.' },
  { name: 'azure-async-infra',        summary: 'Blob, Service Bus, workers, and auth patterns for Azure.' },
  { name: 'terraform-infra',          summary: 'Terraform IaC standards for Azure resources.' },
  { name: 'create-pull-request',      summary: 'Create a pull request with a structured description.' },
  { name: 'design-system',            summary: 'Design-system reference consumed by APEX when generating prototypes.' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTs(ts: string | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function statusBadgeClass(status: string): string {
  if (status === 'published')   return styles.badgePublished;
  if (status === 'deprecated')  return styles.badgeDeprecated;
  return styles.badgeDraft;
}

function compatBadgeClass(status: string): string {
  if (status === 'compatible')    return styles.badgePublished;
  if (status === 'incompatible')  return styles.badgeDeprecated;
  return styles.badgeDraft;
}

// ── ProjectPicker — reusable multi-select ────────────────────────────────────

const ProjectPicker: React.FC<{
  selected: string[];
  onChange: (projects: string[]) => void;
  placeholder?: string;
}> = ({ selected, onChange, placeholder = 'Search projects…' }) => {
  const [search, setSearch] = useState('');
  const { data: allProjects = [] } = useProjects();
  const filtered = allProjects
    .map(p => p.name)
    .filter(n => n.toLowerCase().includes(search.toLowerCase()) && !selected.includes(n));

  const toggle = (name: string) =>
    onChange(selected.includes(name) ? selected.filter(p => p !== name) : [...selected, name]);

  return (
    <div>
      {selected.length > 0 && (
        <div className={styles.chipRow}>
          {selected.map(p => (
            <span key={p} className={styles.chip}>
              {p}
              <button type="button" className={styles.chipRemove}
                onClick={() => onChange(selected.filter(x => x !== p))} aria-label={`Remove ${p}`}>×</button>
            </span>
          ))}
        </div>
      )}
      <input className={styles.input} value={search} onChange={e => setSearch(e.target.value)}
        placeholder={placeholder} />
      {search && filtered.length > 0 && (
        <ul className={styles.dropdown}>
          {filtered.slice(0, 8).map(name => (
            <li key={name}>
              <button type="button" className={styles.dropdownItem} onClick={() => { toggle(name); setSearch(''); }}>
                {name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {search && filtered.length === 0 && (
        <p className={styles.muted} style={{ margin: '4px 0' }}>No matching projects</p>
      )}
    </div>
  );
};

// ── SkillPicker — checklist with per-skill audience override ─────────────────

interface SkillAudiencePick {
  mode: 'inherit' | 'specific';
  projects: string[];
}

/** Derive skillTargets map from picked audiences (only include explicit overrides). */
function buildSkillTargets(picked: Record<string, SkillAudiencePick>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, pick] of Object.entries(picked)) {
    if (pick.mode === 'specific') {
      out[name] = pick.projects;
    }
  }
  return out;
}

const SkillPicker: React.FC<{
  selectedSkills: string[];
  skillAudiences: Record<string, SkillAudiencePick>;
  releaseAudienceLabel: string; // human-readable description of release-level audience
  onSkillToggle: (name: string) => void;
  onAudienceChange: (name: string, pick: SkillAudiencePick) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
}> = ({ selectedSkills, skillAudiences, releaseAudienceLabel, onSkillToggle, onAudienceChange, onSelectAll, onClearAll }) => {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className={styles.skillPickerBox}>
      <div className={styles.skillPickerHeader}>
        <span className={styles.label}>Skills ({selectedSkills.length} of {SKILL_CATALOG.length} selected)</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className={styles.btnGhost} style={{ padding: '2px 8px', fontSize: 12 }}
            onClick={onSelectAll}>Select all</button>
          <button type="button" className={styles.btnGhost} style={{ padding: '2px 8px', fontSize: 12 }}
            onClick={onClearAll}>Clear</button>
        </div>
      </div>
      <div className={styles.skillList}>
        {SKILL_CATALOG.map(skill => {
          const checked = selectedSkills.includes(skill.name);
          const audience = skillAudiences[skill.name];
          const isExpanded = expanded === skill.name;
          const hasOverride = audience?.mode === 'specific';
          return (
            <div key={skill.name} className={`${styles.skillRow} ${checked ? styles.skillRowChecked : ''}`}>
              <div className={styles.skillRowMain}>
                <input type="checkbox" id={`skill-${skill.name}`} checked={checked}
                  onChange={() => onSkillToggle(skill.name)} />
                <label htmlFor={`skill-${skill.name}`} className={styles.skillName}>
                  {skill.name}
                  {hasOverride && (
                    <span className={styles.overrideBadge} title={`Specific: ${audience.projects.join(', ') || 'none set'}`}>
                      🔒 {audience.projects.length > 0 ? audience.projects.slice(0, 2).join(', ') + (audience.projects.length > 2 ? ` +${audience.projects.length - 2}` : '') : 'none'}
                    </span>
                  )}
                </label>
                <span className={styles.skillSummary}>{skill.summary}</span>
                {checked && (
                  <button type="button" className={styles.btnGhost}
                    style={{ padding: '2px 8px', fontSize: 11, marginLeft: 'auto', flexShrink: 0 }}
                    onClick={() => setExpanded(isExpanded ? null : skill.name)}>
                    {isExpanded ? '▲ Hide' : '▼ Audience'}
                  </button>
                )}
              </div>
              {checked && isExpanded && (
                <div className={styles.skillAudiencePanel}>
                  <span className={styles.label} style={{ fontSize: 11 }}>Audience for {skill.name}</span>
                  <select
                    className={styles.input}
                    style={{ fontSize: 12, padding: '4px 8px' }}
                    value={audience?.mode ?? 'inherit'}
                    onChange={e => {
                      const mode = e.target.value as 'inherit' | 'specific';
                      onAudienceChange(skill.name, { mode, projects: mode === 'inherit' ? [] : (audience?.projects ?? []) });
                    }}
                  >
                    <option value="inherit">Inherit release audience ({releaseAudienceLabel})</option>
                    <option value="specific">Specific projects only</option>
                  </select>
                  {(audience?.mode === 'specific') && (
                    <ProjectPicker
                      selected={audience.projects}
                      onChange={projects => onAudienceChange(skill.name, { mode: 'specific', projects })}
                      placeholder="Add project override…"
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ── CreateReleaseForm ─────────────────────────────────────────────────────────

const CreateReleaseForm: React.FC<{ onCreated: () => void }> = ({ onCreated }) => {
  const [version, setVersion]              = useState('');
  const [artifactVersion, setArtifact]     = useState('');
  const [releaseNotes, setNotes]           = useState('');
  const [breakingChanges, setBreaking]     = useState('');
  const [audienceMode, setAudienceMode]    = useState<'all' | 'specific'>('all');
  const [selectedProjects, setSelected]    = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills]       = useState<string[]>(SKILL_CATALOG.map(s => s.name));
  const [skillAudiences, setSkillAudiences]        = useState<Record<string, SkillAudiencePick>>({});
  const [error, setError]                  = useState<string | null>(null);

  const create = useCreateFoundationSkillRelease();

  const releaseAudienceLabel = audienceMode === 'all' ? 'All projects'
    : selectedProjects.length > 0 ? selectedProjects.join(', ') : 'none selected';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (audienceMode === 'specific' && selectedProjects.length === 0) {
      setError('Select at least one project or switch to "All projects".');
      return;
    }
    if (selectedSkills.length === 0) {
      setError('Select at least one skill to include in this release.');
      return;
    }
    try {
      await create.mutateAsync({
        version:          version.trim(),
        artifactVersion:  artifactVersion.trim() || version.trim(),
        selectedSkills,
        targetProjects:   audienceMode === 'specific' ? selectedProjects : [],
        skillTargets:     buildSkillTargets(skillAudiences),
        releaseNotes:     releaseNotes.trim() || null,
        breakingChanges:  breakingChanges.trim() || null,
      });
      setVersion(''); setArtifact(''); setNotes(''); setBreaking('');
      setAudienceMode('all'); setSelected([]); setSelectedSkills(SKILL_CATALOG.map(s => s.name));
      setSkillAudiences({});
      onCreated();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  return (
    <form className={styles.form} style={{ maxWidth: 560 }} onSubmit={handleSubmit}>
      <h3 className={styles.formTitle}>Create draft release</h3>
      <div className={styles.formRow}>
        <label className={styles.label} htmlFor="fs-version">Suite version</label>
        <input id="fs-version" className={styles.input} value={version}
          onChange={e => setVersion(e.target.value)} placeholder="e.g. 0.3.0" required />
      </div>
      <div className={styles.formRow}>
        <label className={styles.label} htmlFor="fs-artifact">Artifact version</label>
        <input id="fs-artifact" className={styles.input} value={artifactVersion}
          onChange={e => setArtifact(e.target.value)} placeholder="defaults to suite version" />
      </div>

      {/* Release-level audience */}
      <div className={styles.formRow}>
        <label className={styles.label} htmlFor="fs-audience">Default audience</label>
        <select id="fs-audience" className={styles.input} value={audienceMode}
          onChange={e => { setAudienceMode(e.target.value as 'all' | 'specific'); setSelected([]); }}>
          <option value="all">All projects</option>
          <option value="specific">Specific projects</option>
        </select>
      </div>
      {audienceMode === 'specific' && (
        <div className={styles.formRow}>
          <label className={styles.label}>Projects</label>
          <ProjectPicker selected={selectedProjects} onChange={setSelected} />
        </div>
      )}

      {/* Skill picker */}
      <div className={styles.formRow}>
        <SkillPicker
          selectedSkills={selectedSkills}
          skillAudiences={skillAudiences}
          releaseAudienceLabel={releaseAudienceLabel}
          onSkillToggle={(name) =>
            setSelectedSkills(prev => prev.includes(name) ? prev.filter(s => s !== name) : [...prev, name])
          }
          onAudienceChange={(name, pick) => setSkillAudiences(prev => ({ ...prev, [name]: pick }))}
          onSelectAll={() => setSelectedSkills(SKILL_CATALOG.map(s => s.name))}
          onClearAll={() => { setSelectedSkills([]); setSkillAudiences({}); }}
        />
      </div>

      <div className={styles.formRow}>
        <label className={styles.label} htmlFor="fs-notes">Release notes</label>
        <textarea id="fs-notes" className={styles.textarea} value={releaseNotes}
          onChange={e => setNotes(e.target.value)} rows={3} />
      </div>
      <div className={styles.formRow}>
        <label className={styles.label} htmlFor="fs-breaking">Breaking changes</label>
        <textarea id="fs-breaking" className={styles.textarea} value={breakingChanges}
          onChange={e => setBreaking(e.target.value)} rows={2} />
      </div>
      {error && <p className={styles.error}>{error}</p>}
      <button type="submit" className={styles.btnPrimary} disabled={create.isPending}>
        {create.isPending ? 'Creating…' : 'Create draft'}
      </button>
    </form>
  );
};

// ── CompatCheckForm ───────────────────────────────────────────────────────────

const CompatCheckForm: React.FC = () => {
  const [project, setProject]   = useState('');
  const [repo, setRepo]         = useState('');
  const [branch, setBranch]     = useState('main');
  const [apexProj, setApexProj] = useState('');
  const [provider, setProvider] = useState<'ado' | 'github'>('ado');
  const [result, setResult]     = useState<string | null>(null);
  const [err, setErr]           = useState<string | null>(null);
  const checkCompat             = useCheckFoundationSkillCompatibility();

  const handleCheck = async (e: React.FormEvent) => {
    e.preventDefault();
    setResult(null); setErr(null);
    try {
      const res = await checkCompat.mutateAsync({
        project, repo, provider, branch: branch || 'main',
        apexProject: apexProj || undefined,
      });
      const r = res.report;
      setResult(`Status: ${r.status}${r.errors.length ? ` | Errors: ${r.errors.join('; ')}` : ''}${r.warnings.length ? ` | Warnings: ${r.warnings.join('; ')}` : ''}`);
    } catch (e2: unknown) {
      setErr((e2 as Error).message);
    }
  };

  return (
    <form className={styles.form} onSubmit={handleCheck}>
      <h3 className={styles.formTitle}>Run compatibility check</h3>
      <div className={styles.formRow}>
        <label className={styles.label} htmlFor="cc-apex">Apex project name</label>
        <input id="cc-apex" className={styles.input} value={apexProj}
          onChange={e => setApexProj(e.target.value)} placeholder="e.g. MaxView" />
      </div>
      <div className={styles.formRow}>
        <label className={styles.label} htmlFor="cc-provider">Provider</label>
        <select id="cc-provider" className={styles.input} value={provider}
          onChange={e => setProvider(e.target.value as 'ado' | 'github')}>
          <option value="ado">Azure DevOps</option>
          <option value="github">GitHub</option>
        </select>
      </div>
      <div className={styles.formRow}>
        <label className={styles.label} htmlFor="cc-project">ADO project / GitHub org</label>
        <input id="cc-project" className={styles.input} value={project}
          onChange={e => setProject(e.target.value)} placeholder="e.g. MaxView" required />
      </div>
      <div className={styles.formRow}>
        <label className={styles.label} htmlFor="cc-repo">Skill repo name</label>
        <input id="cc-repo" className={styles.input} value={repo}
          onChange={e => setRepo(e.target.value)} placeholder="e.g. MaxView" required />
      </div>
      <div className={styles.formRow}>
        <label className={styles.label} htmlFor="cc-branch">Skill branch</label>
        <input id="cc-branch" className={styles.input} value={branch}
          onChange={e => setBranch(e.target.value)} placeholder="e.g. skill-packaging-apex" />
      </div>
      {err    && <p className={styles.error}>{err}</p>}
      {result && <p className={styles.muted} style={{ wordBreak: 'break-word' }}>{result}</p>}
      <button type="submit" className={styles.btnSecondary} disabled={checkCompat.isPending}>
        {checkCompat.isPending ? 'Checking…' : 'Check compatibility'}
      </button>
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

  const [version,         setVersion]      = useState(release.version);
  const [artifactVersion, setArtifact]     = useState(release.artifactVersion);
  const [notes,           setNotes]        = useState(release.releaseNotes    ?? '');
  const [breaking,        setBreaking]     = useState(release.breakingChanges ?? '');
  const [audienceMode,    setAudienceMode] = useState<'all' | 'specific'>(
    release.targetProjects?.length ? 'specific' : 'all',
  );
  const [selectedProjects, setSelected]   = useState<string[]>(release.targetProjects ?? []);
  const [localErr,         setLocalErr]   = useState<string | null>(null);

  // Skill state
  const [selectedSkills,  setSelectedSkills]  = useState<string[]>(
    release.selectedSkills?.length ? release.selectedSkills : SKILL_CATALOG.map(s => s.name),
  );
  const [skillAudiences, setSkillAudiences] = useState<Record<string, SkillAudiencePick>>(() => {
    const init: Record<string, SkillAudiencePick> = {};
    for (const [name, projects] of Object.entries(release.skillTargets ?? {})) {
      init[name] = { mode: 'specific', projects: projects as string[] };
    }
    return init;
  });

  const releaseAudienceLabel = audienceMode === 'all' ? 'All projects'
    : selectedProjects.length > 0 ? selectedProjects.join(', ') : 'none selected';

  const handleSave = async () => {
    setLocalErr(null);
    if (audienceMode === 'specific' && selectedProjects.length === 0) {
      setLocalErr('Select at least one project or switch to "All projects".');
      return;
    }
    if (selectedSkills.length === 0) {
      setLocalErr('At least one skill must be selected.');
      return;
    }
    await onSave({
      ...(isDraft && { version: version.trim(), artifactVersion: artifactVersion.trim() || version.trim() }),
      releaseNotes:    notes.trim()    || null,
      breakingChanges: breaking.trim() || null,
      targetProjects:  audienceMode === 'specific' ? selectedProjects : [],
      selectedSkills,
      skillTargets:    buildSkillTargets(skillAudiences),
    });
  };

  return (
    <div className={styles.editNotesPanel}>
      <h4 className={styles.editPanelTitle}>Edit release</h4>

      {isDraft && (
        <>
          <div className={styles.formRow}>
            <label className={styles.label} htmlFor="er-version">Suite version</label>
            <input id="er-version" className={styles.input} value={version}
              onChange={e => setVersion(e.target.value)} />
          </div>
          <div className={styles.formRow}>
            <label className={styles.label} htmlFor="er-artifact">Artifact version</label>
            <input id="er-artifact" className={styles.input} value={artifactVersion}
              onChange={e => setArtifact(e.target.value)} />
          </div>
        </>
      )}

      <div className={styles.formRow}>
        <label className={styles.label} htmlFor="er-audience">Default audience</label>
        <select id="er-audience" className={styles.input} value={audienceMode}
          onChange={e => { setAudienceMode(e.target.value as 'all' | 'specific'); setSelected([]); }}>
          <option value="all">All projects</option>
          <option value="specific">Specific projects</option>
        </select>
      </div>
      {audienceMode === 'specific' && (
        <div className={styles.formRow}>
          <label className={styles.label}>Projects</label>
          <ProjectPicker selected={selectedProjects} onChange={setSelected} />
        </div>
      )}

      <div className={styles.formRow}>
        <SkillPicker
          selectedSkills={selectedSkills}
          skillAudiences={skillAudiences}
          releaseAudienceLabel={releaseAudienceLabel}
          onSkillToggle={(name) =>
            setSelectedSkills(prev => prev.includes(name) ? prev.filter(s => s !== name) : [...prev, name])
          }
          onAudienceChange={(name, pick) => setSkillAudiences(prev => ({ ...prev, [name]: pick }))}
          onSelectAll={() => setSelectedSkills(SKILL_CATALOG.map(s => s.name))}
          onClearAll={() => { setSelectedSkills([]); setSkillAudiences({}); }}
        />
      </div>

      <div className={styles.formRow}>
        <label className={styles.label} htmlFor="er-notes">Release notes</label>
        <textarea id="er-notes" className={styles.textarea} value={notes}
          onChange={e => setNotes(e.target.value)} rows={5}
          placeholder="What changed in this release?" />
      </div>
      <div className={styles.formRow}>
        <label className={styles.label} htmlFor="er-breaking">Breaking changes</label>
        <textarea id="er-breaking" className={styles.textarea} value={breaking}
          onChange={e => setBreaking(e.target.value)} rows={2} />
      </div>

      {localErr && <p className={styles.error}>{localErr}</p>}
      <div className={styles.editNotesBtns}>
        <button className={styles.btnPrimary} type="button" disabled={isSaving}
          onClick={() => void handleSave()}>
          {isSaving ? 'Saving…' : 'Save changes'}
        </button>
        <button className={styles.btnGhost} type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
};

// ── AuditDrawer ───────────────────────────────────────────────────────────────

const AuditDrawer: React.FC<{ releaseId: string; onClose: () => void }> = ({ releaseId, onClose }) => {
  const { data: entries = [], isLoading } = useFoundationSkillReleaseAudit(releaseId);
  return (
    <div className={styles.drawer}>
      <div className={styles.drawerHeader}>
        <h3 className={styles.drawerTitle}>Audit log</h3>
        <button className={styles.closeBtn} onClick={onClose} type="button" aria-label="Close">✕</button>
      </div>
      {isLoading ? <p className={styles.muted}>Loading…</p> : entries.length === 0 ? (
        <p className={styles.muted}>No audit entries.</p>
      ) : (
        <table className={styles.table}>
          <thead><tr><th>Action</th><th>Actor</th><th>When</th><th>Details</th></tr></thead>
          <tbody>
            {entries.map(e => (
              <tr key={e.id}>
                <td><span className={styles.auditAction}>{e.action}</span></td>
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

  const filtered = skills.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.summary.toLowerCase().includes(search.toLowerCase()),
  );

  if (isLoading) return <p className={styles.muted}>Loading skills matrix…</p>;

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <input className={styles.input} style={{ maxWidth: 360 }} value={search}
          onChange={e => setSearch(e.target.value)} placeholder="Search skills…" />
      </div>

      {filtered.length === 0 ? (
        <p className={styles.muted}>No skills match your search.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Skill</th>
              <th>In Releases</th>
              <th>Effective Audience</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(skill => {
              const isExpanded = expandedSkill === skill.name;
              const publishedReleases = skill.releases.filter(r => r.status === 'published');
              const allProjects = publishedReleases.every(r => r.effectiveTargetProjects.length === 0);
              const uniqueProjects = Array.from(
                new Set(publishedReleases.flatMap(r => r.effectiveTargetProjects)),
              );

              return (
                <React.Fragment key={skill.name}>
                  <tr
                    className={styles.matrixRow}
                    onClick={() => setExpandedSkill(isExpanded ? null : skill.name)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>
                      <div className={styles.matrixSkillName}>{skill.name}</div>
                      <div className={styles.matrixSkillSummary}>{skill.summary}</div>
                    </td>
                    <td>
                      {skill.releases.length === 0 ? (
                        <span className={styles.muted}>—</span>
                      ) : (
                        <div className={styles.chipRow} style={{ margin: 0 }}>
                          {skill.releases.map(r => (
                            <span key={r.releaseId}
                              className={`${styles.badge} ${statusBadgeClass(r.status)}`}
                              title={`Audience: ${r.effectiveTargetProjects.length === 0 ? 'All projects' : r.effectiveTargetProjects.join(', ')}`}>
                              v{r.version}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      {publishedReleases.length === 0 ? (
                        <span className={styles.muted}>Not in any published release</span>
                      ) : allProjects ? (
                        <span className={`${styles.badge} ${styles.badgeDraft}`}>All projects</span>
                      ) : (
                        <div className={styles.chipRow} style={{ margin: 0 }}>
                          {uniqueProjects.slice(0, 4).map(p => (
                            <span key={p} className={styles.chip}>{p}</span>
                          ))}
                          {uniqueProjects.length > 4 && (
                            <span className={styles.chip}>+{uniqueProjects.length - 4}</span>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={3} className={styles.matrixExpanded}>
                        {skill.releases.length === 0 ? (
                          <p className={styles.muted}>This skill has not been included in any release yet.</p>
                        ) : (
                          <table className={styles.table} style={{ background: 'transparent' }}>
                            <thead>
                              <tr><th>Release</th><th>Status</th><th>Audience</th></tr>
                            </thead>
                            <tbody>
                              {skill.releases.map(r => (
                                <tr key={r.releaseId}>
                                  <td><code>v{r.version}</code></td>
                                  <td>
                                    <span className={`${styles.badge} ${statusBadgeClass(r.status)}`}>{r.status}</span>
                                  </td>
                                  <td>
                                    {r.effectiveTargetProjects.length === 0 ? (
                                      <span className={`${styles.badge} ${styles.badgeDraft}`}>All projects</span>
                                    ) : (
                                      <span title={r.effectiveTargetProjects.join(', ')}>
                                        {r.effectiveTargetProjects.slice(0, 3).join(', ')}
                                        {r.effectiveTargetProjects.length > 3 && ` +${r.effectiveTargetProjects.length - 3}`}
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
      )}
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

type Section = 'releases' | 'skills' | 'repos' | 'create';

const SECTION_LABELS: Record<Section, string> = {
  releases: 'Releases',
  skills:   'Skills',
  repos:    'Consumer Repos',
  create:   'Create Draft',
};

export const FoundationSkillsAdmin: React.FC = () => {
  const [activeSection, setActiveSection] = useState<Section>('releases');
  const [auditReleaseId, setAuditReleaseId] = useState<string | null>(null);
  const [editReleaseId,  setEditReleaseId]  = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMsg,   setActionMsg]   = useState<string | null>(null);

  const { data: releases = [], isLoading: relLoading } = useFoundationSkillReleases();
  const { data: candidates = [], isLoading: candLoading } = useFoundationSkillCandidates();
  const { data: repoStatuses = [], isLoading: repoLoading } = useFoundationSkillRepoStatuses();

  const publish     = usePublishFoundationSkillRelease();
  const deprecate   = useDeprecateFoundationSkillRelease();
  const deleteDraft = useDeleteDraftFoundationSkillRelease();
  const updateRelease = useUpdateFoundationSkillRelease();
  const updateRepo  = useUpdateRepoWithFoundationSkills();
  const checkCompat = useCheckFoundationSkillCompatibility();

  const clearMessages = () => { setActionError(null); setActionMsg(null); };

  const handlePublish = async (release: FoundationSkillRelease) => {
    clearMessages();
    try {
      await publish.mutateAsync(release.id);
      setActionMsg(`v${release.version} published.`);
    } catch (err: unknown) { setActionError((err as Error).message); }
  };

  const handleDeprecate = async (release: FoundationSkillRelease) => {
    if (!confirm(`Deprecate v${release.version}?`)) return;
    clearMessages();
    try {
      await deprecate.mutateAsync({ id: release.id });
      setActionMsg(`v${release.version} deprecated.`);
    } catch (err: unknown) { setActionError((err as Error).message); }
  };

  const handleDelete = async (release: FoundationSkillRelease) => {
    if (!confirm(`Delete draft v${release.version}?`)) return;
    clearMessages();
    try {
      await deleteDraft.mutateAsync(release.id);
      setActionMsg(`Draft v${release.version} deleted.`);
    } catch (err: unknown) { setActionError((err as Error).message); }
  };

  const handleUpdateRepo = async (s: FoundationSkillRepoStatus) => {
    clearMessages();
    try {
      const result = await updateRepo.mutateAsync({ project: s.project, repo: s.repo, provider: s.provider });
      if (result.prUrl) {
        setActionMsg(`PR opened: ${result.prUrl}`);
      } else if (result.status === 'no_changes') {
        setActionMsg('Already up to date — no PR needed.');
      } else {
        setActionMsg(`Update result: ${result.status}. ${result.errors.join(' ')}`);
      }
    } catch (err: unknown) { setActionError((err as Error).message); }
  };

  const handleCheckCompat = async (s: FoundationSkillRepoStatus) => {
    clearMessages();
    try {
      const result = await checkCompat.mutateAsync({ project: s.project, repo: s.repo, provider: s.provider });
      setActionMsg(`Compatibility: ${result.report.status}. ${result.report.errors.join(' ') || result.report.warnings.join(' ') || 'OK'}`);
    } catch (err: unknown) { setActionError((err as Error).message); }
  };

  return (
    <section className={styles.section} aria-labelledby="foundation-skills-title">
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="foundation-skills-title" className={styles.sectionTitle}>APEX Foundation Skills</h2>
          <p className={styles.sectionHint}>
            Manage versioned foundation skill releases, per-skill audience targeting, and consumer repo delivery.
          </p>
        </div>
        <span className={styles.countBadge}>
          {releases.filter(r => r.status === 'published').length} published
        </span>
      </div>

      {actionError && <p className={styles.errorMsg} role="alert">{actionError}</p>}
      {actionMsg   && <p className={styles.successMsg} role="status">{actionMsg}</p>}

      {/* Tab nav */}
      <div className={styles.subNav} role="tablist">
        {(['releases', 'skills', 'repos', 'create'] as const).map(s => (
          <button key={s} type="button" role="tab"
            aria-selected={activeSection === s}
            className={`${styles.subNavBtn} ${activeSection === s ? styles.subNavBtnActive : ''}`}
            onClick={() => { clearMessages(); setActiveSection(s); }}>
            {SECTION_LABELS[s]}
          </button>
        ))}
      </div>

      {/* ── Releases ── */}
      {activeSection === 'releases' && (
        <>
          {relLoading ? <p className={styles.muted}>Loading releases…</p> : releases.length === 0 ? (
            <p className={styles.muted}>No releases yet. Use "Create Draft" to add one.</p>
          ) : (
            <div className={styles.releaseList}>
              {releases.map(r => {
                const hasOverrides = Object.keys(r.skillTargets ?? {}).length > 0;
                return (
                  <div key={r.id} className={styles.releaseCard}>
                    <div className={styles.releaseCardHeader}>
                      <span className={styles.releaseVersion}>v{r.version}</span>
                      <span className={`${styles.badge} ${statusBadgeClass(r.status)}`}>{r.status}</span>
                      {/* Release-level audience */}
                      {r.targetProjects && r.targetProjects.length > 0 ? (
                        <span className={styles.audienceChips} title={r.targetProjects.join(', ')}>
                          {r.targetProjects.slice(0, 3).map(p => (
                            <span key={p} className={styles.chip}>{p}</span>
                          ))}
                          {r.targetProjects.length > 3 && (
                            <span className={styles.chip}>+{r.targetProjects.length - 3}</span>
                          )}
                        </span>
                      ) : (
                        <span className={`${styles.badge} ${styles.badgeDraft}`}>All projects</span>
                      )}
                      {hasOverrides && (
                        <span className={styles.overrideBadge} title={`${Object.keys(r.skillTargets).length} skill(s) have audience overrides`}>
                          🔒 {Object.keys(r.skillTargets).length} override{Object.keys(r.skillTargets).length > 1 ? 's' : ''}
                        </span>
                      )}
                      <span className={styles.releaseDate}>{formatTs(r.createdAt)}</span>
                    </div>

                    {/* Skill pills */}
                    {r.selectedSkills && r.selectedSkills.length > 0 && (
                      <div className={styles.skillPillsRow}>
                        {r.selectedSkills.slice(0, 8).map(name => {
                          const override = r.skillTargets?.[name];
                          return (
                            <span key={name}
                              className={`${styles.skillPill} ${override ? styles.skillPillOverride : ''}`}
                              title={override ? `Audience: ${override.length > 0 ? override.join(', ') : 'all'}` : undefined}>
                              {name}{override ? ' 🔒' : ''}
                            </span>
                          );
                        })}
                        {r.selectedSkills.length > 8 && (
                          <span className={styles.skillPill}>+{r.selectedSkills.length - 8} more</span>
                        )}
                      </div>
                    )}

                    {r.releaseNotes && <p className={styles.releaseNotes}>{r.releaseNotes.slice(0, 120)}</p>}
                    {r.breakingChanges && (
                      <p className={styles.breakingChanges}>Breaking: {r.breakingChanges.slice(0, 100)}</p>
                    )}
                    <div className={styles.releaseActions}>
                      {r.status === 'draft' && (
                        <>
                          <button className={styles.btnSuccess} type="button" disabled={publish.isPending}
                            onClick={() => handlePublish(r)}>Publish</button>
                          <button className={styles.btnDanger} type="button" disabled={deleteDraft.isPending}
                            onClick={() => handleDelete(r)}>Delete draft</button>
                        </>
                      )}
                      {r.status === 'published' && (
                        <button className={styles.btnSecondary} type="button" disabled={deprecate.isPending}
                          onClick={() => handleDeprecate(r)}>Deprecate</button>
                      )}
                      <button className={styles.btnGhost} type="button"
                        onClick={() => { setEditReleaseId(editReleaseId === r.id ? null : r.id); setAuditReleaseId(null); }}>
                        {editReleaseId === r.id ? 'Cancel' : 'Edit'}
                      </button>
                      <button className={styles.btnGhost} type="button"
                        onClick={() => { setAuditReleaseId(auditReleaseId === r.id ? null : r.id); setEditReleaseId(null); }}>
                        {auditReleaseId === r.id ? 'Hide audit' : 'Audit log'}
                      </button>
                    </div>
                    {editReleaseId === r.id && (
                      <EditReleasePanel
                        release={r}
                        onSave={async (payload) => {
                          clearMessages();
                          try {
                            await updateRelease.mutateAsync({ id: r.id, ...payload });
                            setActionMsg(`v${r.version} updated.`);
                            setEditReleaseId(null);
                          } catch (err: unknown) { setActionError((err as Error).message); }
                        }}
                        onCancel={() => setEditReleaseId(null)}
                        isSaving={updateRelease.isPending}
                      />
                    )}
                    {auditReleaseId === r.id && (
                      <AuditDrawer releaseId={r.id} onClose={() => setAuditReleaseId(null)} />
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
                <thead><tr><th>Version</th><th>Published</th></tr></thead>
                <tbody>
                  {candidates.slice(0, 10).map(c => (
                    <tr key={c.version}>
                      <td><code>{c.version}</code></td>
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
      {activeSection === 'skills' && <SkillsMatrixTab />}

      {/* ── Consumer repos ── */}
      {activeSection === 'repos' && (
        <>
          <div style={{ marginBottom: 24 }}>
            <CompatCheckForm />
          </div>
          {repoLoading ? <p className={styles.muted}>Loading repo statuses…</p> :
          repoStatuses.length === 0 ? (
            <p className={styles.muted}>No consumer repos observed yet. Run a compatibility check above to populate.</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Repo</th><th>Installed</th><th>Available</th><th>Compatibility</th><th>Checked</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {repoStatuses.map(s => (
                  <tr key={s.id}>
                    <td><strong>{s.repo}</strong><br /><small className={styles.muted}>{s.project}</small></td>
                    <td>{s.installedVersion ?? '—'}</td>
                    <td>{s.availableVersion ?? '—'}{s.updateAvailable && <span className={styles.updateDot} title="Update available" />}</td>
                    <td>
                      <span className={`${styles.badge} ${compatBadgeClass(s.compatibilityStatus ?? 'unknown')}`}>
                        {s.compatibilityStatus ?? 'unknown'}
                      </span>
                    </td>
                    <td>{formatTs(s.compatibilityCheckedAt)}</td>
                    <td>
                      <button className={styles.btnGhost} type="button" disabled={checkCompat.isPending}
                        onClick={() => handleCheckCompat(s)}>Check</button>
                      {s.updateAvailable && (
                        <button className={styles.btnSuccess} type="button" disabled={updateRepo.isPending}
                          onClick={() => handleUpdateRepo(s)}>Open PR</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {/* ── Create draft ── */}
      {activeSection === 'create' && (
        <CreateReleaseForm onCreated={() => setActiveSection('releases')} />
      )}
    </section>
  );
};
