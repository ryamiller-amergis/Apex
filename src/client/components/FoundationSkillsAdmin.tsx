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
} from '../hooks/useFoundationSkillAdmin';
import { useProjects } from '../hooks/useProjects';
import type { FoundationSkillRelease, FoundationSkillRepoStatus } from '../../shared/types/foundationSkills';
import styles from './FoundationSkillsAdmin.module.css';

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
  if (status === 'compatible')     return styles.badgePublished;
  if (status === 'incompatible')   return styles.badgeDeprecated;
  if (status === 'drift')          return styles.badgeDraft;
  if (status === 'not-installed')  return styles.badgeDraft;
  return styles.badgeDraft;
}

// ── Sub-components ────────────────────────────────────────────────────────────

const CreateReleaseForm: React.FC<{ onCreated: () => void }> = ({ onCreated }) => {
  const [version, setVersion]              = useState('');
  const [artifactVersion, setArtifact]     = useState('');
  const [releaseNotes, setNotes]           = useState('');
  const [breakingChanges, setBreaking]     = useState('');
  const [audienceMode, setAudienceMode]    = useState<'all' | 'specific'>('all');
  const [selectedProjects, setSelected]    = useState<string[]>([]);
  const [projectSearch, setProjectSearch]  = useState('');
  const [error, setError]                  = useState<string | null>(null);

  const create              = useCreateFoundationSkillRelease();
  const { data: allProjects = [] } = useProjects();

  const filteredProjects = allProjects
    .map(p => p.name)
    .filter(n => n.toLowerCase().includes(projectSearch.toLowerCase()) && !selectedProjects.includes(n));

  const toggleProject = (name: string) => {
    setSelected(prev =>
      prev.includes(name) ? prev.filter(p => p !== name) : [...prev, name],
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (audienceMode === 'specific' && selectedProjects.length === 0) {
      setError('Select at least one project or switch to "All projects".');
      return;
    }
    try {
      await create.mutateAsync({
        version: version.trim(),
        artifactVersion: artifactVersion.trim() || version.trim(),
        selectedSkills: [],
        targetProjects: audienceMode === 'specific' ? selectedProjects : [],
        releaseNotes:   releaseNotes.trim() || null,
        breakingChanges: breakingChanges.trim() || null,
      });
      setVersion(''); setArtifact(''); setNotes(''); setBreaking('');
      setAudienceMode('all'); setSelected([]); setProjectSearch('');
      onCreated();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <h3 className={styles.formTitle}>Create draft release</h3>
      <div className={styles.formRow}>
        <label className={styles.label} htmlFor="fs-version">Suite version</label>
        <input id="fs-version" className={styles.input} value={version}
          onChange={e => setVersion(e.target.value)} placeholder="e.g. 0.2.0" required />
      </div>
      <div className={styles.formRow}>
        <label className={styles.label} htmlFor="fs-artifact">Artifact version</label>
        <input id="fs-artifact" className={styles.input} value={artifactVersion}
          onChange={e => setArtifact(e.target.value)} placeholder="defaults to suite version" />
      </div>

      {/* Audience control */}
      <div className={styles.formRow}>
        <label className={styles.label} htmlFor="fs-audience">Audience</label>
        <select
          id="fs-audience"
          className={styles.input}
          value={audienceMode}
          onChange={e => {
            setAudienceMode(e.target.value as 'all' | 'specific');
            setSelected([]);
            setProjectSearch('');
          }}
        >
          <option value="all">All projects</option>
          <option value="specific">Specific projects</option>
        </select>
      </div>

      {audienceMode === 'specific' && (
        <div className={styles.formRow}>
          <label className={styles.label}>Projects</label>
          {selectedProjects.length > 0 && (
            <div className={styles.chipRow}>
              {selectedProjects.map(p => (
                <span key={p} className={styles.chip}>
                  {p}
                  <button
                    type="button"
                    className={styles.chipRemove}
                    onClick={() => setSelected(prev => prev.filter(x => x !== p))}
                    aria-label={`Remove ${p}`}
                  >×</button>
                </span>
              ))}
            </div>
          )}
          <input
            className={styles.input}
            placeholder="Search projects…"
            value={projectSearch}
            onChange={e => setProjectSearch(e.target.value)}
          />
          {projectSearch && filteredProjects.length > 0 && (
            <ul className={styles.dropdown}>
              {filteredProjects.slice(0, 10).map(name => (
                <li key={name}>
                  <button type="button" className={styles.dropdownItem} onClick={() => {
                    toggleProject(name);
                    setProjectSearch('');
                  }}>
                    {name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {projectSearch && filteredProjects.length === 0 && (
            <p className={styles.muted} style={{ margin: '4px 0' }}>No matching projects</p>
          )}
        </div>
      )}

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

const EditReleasePanel: React.FC<{
  release: FoundationSkillRelease;
  onSave: (payload: Omit<import('../hooks/useFoundationSkillAdmin').UpdateReleasePayload, 'id'>) => Promise<void>;
  onCancel: () => void;
  isSaving: boolean;
}> = ({ release, onSave, onCancel, isSaving }) => {
  const isDraft = release.status === 'draft';

  const [version,         setVersion]       = useState(release.version);
  const [artifactVersion, setArtifact]      = useState(release.artifactVersion);
  const [notes,           setNotes]         = useState(release.releaseNotes    ?? '');
  const [breaking,        setBreaking]      = useState(release.breakingChanges ?? '');
  const [audienceMode,    setAudienceMode]  = useState<'all' | 'specific'>(
    release.targetProjects?.length ? 'specific' : 'all',
  );
  const [selectedProjects, setSelected]    = useState<string[]>(release.targetProjects ?? []);
  const [projectSearch,    setSearch]      = useState('');
  const [localErr,         setLocalErr]    = useState<string | null>(null);

  const { data: allProjects = [] } = useProjects();
  const filteredProjects = allProjects
    .map(p => p.name)
    .filter(n => n.toLowerCase().includes(projectSearch.toLowerCase()) && !selectedProjects.includes(n));

  const toggleProject = (name: string) =>
    setSelected(prev => prev.includes(name) ? prev.filter(p => p !== name) : [...prev, name]);

  const handleSave = async () => {
    setLocalErr(null);
    if (audienceMode === 'specific' && selectedProjects.length === 0) {
      setLocalErr('Select at least one project or switch to "All projects".');
      return;
    }
    await onSave({
      ...(isDraft && { version: version.trim(), artifactVersion: artifactVersion.trim() || version.trim() }),
      releaseNotes:    notes.trim()    || null,
      breakingChanges: breaking.trim() || null,
      targetProjects:  audienceMode === 'specific' ? selectedProjects : [],
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
              onChange={e => setVersion(e.target.value)} placeholder="e.g. 0.3.0" />
          </div>
          <div className={styles.formRow}>
            <label className={styles.label} htmlFor="er-artifact">Artifact version</label>
            <input id="er-artifact" className={styles.input} value={artifactVersion}
              onChange={e => setArtifact(e.target.value)} placeholder="defaults to suite version" />
          </div>
        </>
      )}

      {/* Audience */}
      <div className={styles.formRow}>
        <label className={styles.label} htmlFor="er-audience">Audience</label>
        <select id="er-audience" className={styles.input} value={audienceMode}
          onChange={e => { setAudienceMode(e.target.value as 'all' | 'specific'); setSelected([]); }}>
          <option value="all">All projects</option>
          <option value="specific">Specific projects</option>
        </select>
      </div>
      {audienceMode === 'specific' && (
        <div className={styles.formRow}>
          <label className={styles.label}>Projects</label>
          <div className={styles.chipRow}>
            {selectedProjects.map(p => (
              <span key={p} className={styles.chip}>
                {p}
                <button className={styles.chipRemove} type="button" onClick={() => toggleProject(p)} aria-label={`Remove ${p}`}>×</button>
              </span>
            ))}
          </div>
          <input className={styles.input} value={projectSearch}
            onChange={e => setSearch(e.target.value)} placeholder="Search projects…" />
          {projectSearch && filteredProjects.slice(0, 6).map(p => (
            <div key={p} className={styles.dropdownItem} onClick={() => { toggleProject(p); setSearch(''); }}>
              {p}
            </div>
          ))}
        </div>
      )}

      <div className={styles.formRow}>
        <label className={styles.label} htmlFor="er-notes">Release notes</label>
        <textarea id="er-notes" className={styles.textarea} value={notes}
          onChange={e => setNotes(e.target.value)} rows={5}
          placeholder="What changed in this release?" />
      </div>
      <div className={styles.formRow}>
        <label className={styles.label} htmlFor="er-breaking">Breaking changes</label>
        <textarea id="er-breaking" className={styles.textarea} value={breaking}
          onChange={e => setBreaking(e.target.value)} rows={2}
          placeholder="Describe any breaking changes that require consumer action" />
      </div>

      {localErr && <p className={styles.error}>{localErr}</p>}
      <div className={styles.editNotesBtns}>
        <button className={styles.btnPrimary} type="button" disabled={isSaving} onClick={() => void handleSave()}>
          {isSaving ? 'Saving…' : 'Save changes'}
        </button>
        <button className={styles.btnGhost} type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
};

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

// ── Main component ────────────────────────────────────────────────────────────

export const FoundationSkillsAdmin: React.FC = () => {
  const [activeSection, setActiveSection] = useState<'releases' | 'repos' | 'create'>('releases');
  const [auditReleaseId, setAuditReleaseId] = useState<string | null>(null);
  const [editNotesId, setEditNotesId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const { data: releases = [], isLoading: relLoading } = useFoundationSkillReleases();
  const { data: candidates = [], isLoading: candLoading } = useFoundationSkillCandidates();
  const { data: repoStatuses = [], isLoading: repoLoading } = useFoundationSkillRepoStatuses();

  const publish    = usePublishFoundationSkillRelease();
  const deprecate  = useDeprecateFoundationSkillRelease();
  const deleteDraft = useDeleteDraftFoundationSkillRelease();
  const updateRelease = useUpdateFoundationSkillRelease();
  const updateRepo = useUpdateRepoWithFoundationSkills();
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
            Manage versioned foundation skill releases and deliver updates to consumer repos.
          </p>
        </div>
        <span className={styles.countBadge}>
          {releases.filter(r => r.status === 'published').length} published
        </span>
      </div>

      {actionError && <p className={styles.errorMsg} role="alert">{actionError}</p>}
      {actionMsg   && <p className={styles.successMsg} role="status">{actionMsg}</p>}

      {/* Section nav */}
      <div className={styles.subNav} role="tablist">
        {(['releases', 'repos', 'create'] as const).map(s => (
          <button key={s} type="button" role="tab"
            aria-selected={activeSection === s}
            className={`${styles.subNavBtn} ${activeSection === s ? styles.subNavBtnActive : ''}`}
            onClick={() => { clearMessages(); setActiveSection(s); }}>
            {s === 'releases' ? 'Releases' : s === 'repos' ? 'Consumer Repos' : 'Create Draft'}
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
              {releases.map(r => (
                <div key={r.id} className={styles.releaseCard}>
                  <div className={styles.releaseCardHeader}>
                    <span className={styles.releaseVersion}>v{r.version}</span>
                    <span className={`${styles.badge} ${statusBadgeClass(r.status)}`}>{r.status}</span>
                    {/* Audience badge */}
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
                    <span className={styles.releaseDate}>{formatTs(r.createdAt)}</span>
                  </div>
                  {r.releaseNotes && <p className={styles.releaseNotes}>{r.releaseNotes.slice(0, 120)}</p>}
                  {r.breakingChanges && (
                    <p className={styles.breakingChanges}>Breaking: {r.breakingChanges.slice(0, 100)}</p>
                  )}
                  <div className={styles.releaseActions}>
                    {r.status === 'draft' && (
                      <>
                        <button className={styles.btnSuccess} type="button" disabled={publish.isPending}
                          onClick={() => handlePublish(r)}>
                          Publish
                        </button>
                        <button className={styles.btnDanger} type="button" disabled={deleteDraft.isPending}
                          onClick={() => handleDelete(r)}>
                          Delete draft
                        </button>
                      </>
                    )}
                    {r.status === 'published' && (
                      <button className={styles.btnSecondary} type="button" disabled={deprecate.isPending}
                        onClick={() => handleDeprecate(r)}>
                        Deprecate
                      </button>
                    )}
                    <button className={styles.btnGhost} type="button"
                      onClick={() => { setEditNotesId(editNotesId === r.id ? null : r.id); setAuditReleaseId(null); }}>
                      {editNotesId === r.id ? 'Cancel' : 'Edit notes'}
                    </button>
                    <button className={styles.btnGhost} type="button"
                      onClick={() => { setAuditReleaseId(auditReleaseId === r.id ? null : r.id); setEditNotesId(null); }}>
                      {auditReleaseId === r.id ? 'Hide audit' : 'Audit log'}
                    </button>
                  </div>
                  {editNotesId === r.id && (
                    <EditReleasePanel
                      release={r}
                      onSave={async (payload) => {
                        clearMessages();
                        try {
                          await updateRelease.mutateAsync({ id: r.id, ...payload });
                          setActionMsg(`v${r.version} updated.`);
                          setEditNotesId(null);
                        } catch (err: unknown) { setActionError((err as Error).message); }
                      }}
                      onCancel={() => setEditNotesId(null)}
                      isSaving={updateRelease.isPending}
                    />
                  )}
                  {auditReleaseId === r.id && (
                    <AuditDrawer releaseId={r.id} onClose={() => setAuditReleaseId(null)} />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Candidates */}
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

      {/* ── Consumer repos ── */}
      {activeSection === 'repos' && (
        <>
          {/* Compatibility check form — always visible so MV can be seeded without raw fetch */}
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
                      <button className={styles.btnGhost} type="button"
                        disabled={checkCompat.isPending}
                        onClick={() => handleCheckCompat(s)}>
                        Check
                      </button>
                      {s.updateAvailable && (
                        <button className={styles.btnSuccess} type="button"
                          disabled={updateRepo.isPending}
                          onClick={() => handleUpdateRepo(s)}>
                          Open PR
                        </button>
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
