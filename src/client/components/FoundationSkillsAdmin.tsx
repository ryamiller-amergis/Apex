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
  useUpdateRepoWithFoundationSkills,
  useCheckFoundationSkillCompatibility,
} from '../hooks/useFoundationSkillAdmin';
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
  const [version, setVersion]           = useState('');
  const [artifactVersion, setArtifact]  = useState('');
  const [releaseNotes, setNotes]        = useState('');
  const [breakingChanges, setBreaking]  = useState('');
  const [error, setError]               = useState<string | null>(null);
  const create = useCreateFoundationSkillRelease();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await create.mutateAsync({
        version: version.trim(),
        artifactVersion: artifactVersion.trim() || version.trim(),
        selectedSkills: [],
        releaseNotes:   releaseNotes.trim() || null,
        breakingChanges: breakingChanges.trim() || null,
      });
      setVersion(''); setArtifact(''); setNotes(''); setBreaking('');
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
          onChange={e => setVersion(e.target.value)} placeholder="e.g. 1.2.0" required />
      </div>
      <div className={styles.formRow}>
        <label className={styles.label} htmlFor="fs-artifact">Artifact version</label>
        <input id="fs-artifact" className={styles.input} value={artifactVersion}
          onChange={e => setArtifact(e.target.value)} placeholder="defaults to suite version" />
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
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const { data: releases = [], isLoading: relLoading } = useFoundationSkillReleases();
  const { data: candidates = [], isLoading: candLoading } = useFoundationSkillCandidates();
  const { data: repoStatuses = [], isLoading: repoLoading } = useFoundationSkillRepoStatuses();

  const publish    = usePublishFoundationSkillRelease();
  const deprecate  = useDeprecateFoundationSkillRelease();
  const deleteDraft = useDeleteDraftFoundationSkillRelease();
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
                    <span className={styles.releaseDate}>{formatTs(r.createdAt)}</span>
                  </div>
                  {r.releaseNotes && <p className={styles.releaseNotes}>{r.releaseNotes.slice(0, 120)}</p>}
                  {r.breakingChanges && (
                    <p className={styles.breakingChanges}>⚠️ Breaking: {r.breakingChanges.slice(0, 100)}</p>
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
                      onClick={() => setAuditReleaseId(auditReleaseId === r.id ? null : r.id)}>
                      {auditReleaseId === r.id ? 'Hide audit' : 'Audit log'}
                    </button>
                  </div>
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
        repoLoading ? <p className={styles.muted}>Loading repo statuses…</p> :
        repoStatuses.length === 0 ? (
          <p className={styles.muted}>No consumer repos observed yet. Run a compatibility check to populate.</p>
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
        )
      )}

      {/* ── Create draft ── */}
      {activeSection === 'create' && (
        <CreateReleaseForm onCreated={() => setActiveSection('releases')} />
      )}
    </section>
  );
};
