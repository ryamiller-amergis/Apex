import React, { useState, useCallback } from 'react';
import type { AiCapabilityLadderResult, LadderBar, LadderCriterion, CriterionStatus } from '../types/aiCapabilityLadder';

// ── Baseline capture panel ─────────────────────────────────────────────────────

interface CaptureResult {
  prCycleTimeDays: number | null;
  leadTimeDays: number | null;
  defectRatePerPbi: number | null;
  capturedFrom: string;
  capturedTo: string;
  prSampleSize: number;
  leadTimeSampleSize: number;
}

interface SkillEntry {
  skillName: string;
  developer: string;
  sharedRegistry: boolean;
}

const BaselineCapturePanel: React.FC<{ onCaptured: () => void }> = ({ onCaptured }) => {
  const [open, setOpen] = useState(false);
  const [aiStartDate, setAiStartDate] = useState('2026-04-13');
  const [lookbackDays, setLookbackDays] = useState(90);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Skills management
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsSaved, setSkillsSaved] = useState(false);
  const [newSkillName, setNewSkillName] = useState('');
  const [newSkillDev, setNewSkillDev] = useState('');
  const [newSkillShared, setNewSkillShared] = useState(true);

  const loadSkills = useCallback(async () => {
    setSkillsLoading(true);
    try {
      const res = await fetch('/api/ai-capability-baseline', { credentials: 'include' });
      const data = await res.json();
      setSkills(data.skillContributions ?? []);
      setSkillsLoaded(true);
    } catch {
      // ignore
    } finally {
      setSkillsLoading(false);
    }
  }, []);

  const saveSkills = useCallback(async (updated: SkillEntry[]) => {
    setSkillsLoading(true);
    setSkillsSaved(false);
    try {
      const current = await fetch('/api/ai-capability-baseline', { credentials: 'include' }).then(r => r.json());
      await fetch('/api/ai-capability-baseline', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...current, skillContributions: updated }),
      });
      setSkills(updated);
      setSkillsSaved(true);
      onCaptured();
    } catch {
      // ignore
    } finally {
      setSkillsLoading(false);
    }
  }, [onCaptured]);

  const addSkill = useCallback(() => {
    if (!newSkillName.trim()) return;
    const entry: SkillEntry = { skillName: newSkillName.trim(), developer: newSkillDev.trim(), sharedRegistry: newSkillShared };
    const updated = [...skills, entry];
    setSkills(updated);
    saveSkills(updated);
    setNewSkillName('');
    setNewSkillDev('');
    setNewSkillShared(true);
  }, [newSkillName, newSkillDev, newSkillShared, skills, saveSkills]);

  const removeSkill = useCallback((idx: number) => {
    const updated = skills.filter((_, i) => i !== idx);
    saveSkills(updated);
  }, [skills, saveSkills]);

  const toggleShared = useCallback((idx: number) => {
    const updated = skills.map((s, i) => i === idx ? { ...s, sharedRegistry: !s.sharedRegistry } : s);
    saveSkills(updated);
  }, [skills, saveSkills]);

  const handleToggle = useCallback(() => {
    setOpen(o => {
      if (!o && !skillsLoaded) loadSkills();
      return !o;
    });
  }, [skillsLoaded, loadSkills]);

  const capture = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/ai-capability-baseline/auto-capture', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiStartDate, lookbackDays }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult(data);
      onCaptured();
    } catch (e: any) {
      setError(e.message ?? 'Capture failed');
    } finally {
      setLoading(false);
    }
  }, [aiStartDate, lookbackDays, onCaptured]);

  return (
    <div className="ladder-baseline-panel">
      <button className="ladder-baseline-toggle" onClick={handleToggle}>
        {open ? '▲' : '▼'} Pre-AI Baseline &amp; Skills Configuration
      </button>

      {open && (
        <div className="ladder-baseline-form">

          {/* ── Metrics capture ── */}
          <div className="ladder-baseline-section-title">Capture Pre-AI Metrics from ADO</div>
          <p className="ladder-baseline-desc">
            Queries ADO PR cycle time and lead time for the period <em>before</em> your AI adoption date.
            The window will be <strong>{lookbackDays} days before {aiStartDate}</strong>.
          </p>
          <div className="ladder-baseline-fields">
            <label className="ladder-baseline-field">
              <span>AI adoption start date</span>
              <input
                type="date"
                value={aiStartDate}
                onChange={e => setAiStartDate(e.target.value)}
                className="ladder-baseline-input"
              />
            </label>
            <label className="ladder-baseline-field">
              <span>Lookback window (days)</span>
              <input
                type="number"
                min={14}
                max={365}
                value={lookbackDays}
                onChange={e => setLookbackDays(Number(e.target.value))}
                className="ladder-baseline-input ladder-baseline-input-narrow"
              />
            </label>
            <button className="load-stats-button" onClick={capture} disabled={loading}>
              {loading ? 'Capturing…' : 'Capture & Save Baseline'}
            </button>
          </div>

          {error && <div className="ladder-baseline-error">⚠ {error}</div>}

          {result && (
            <div className="ladder-baseline-result">
              <div className="ladder-baseline-result-title">
                ✓ Baseline captured from {result.capturedFrom} → {result.capturedTo}
              </div>
              <div className="ladder-baseline-result-grid">
                <div className="ladder-baseline-metric">
                  <span className="ladder-baseline-metric-label">PR Cycle Time</span>
                  <span className="ladder-baseline-metric-value">
                    {result.prCycleTimeDays != null ? `${result.prCycleTimeDays}d` : 'No data'}
                  </span>
                  <span className="ladder-baseline-metric-sample">({result.prSampleSize} PRs)</span>
                </div>
                <div className="ladder-baseline-metric">
                  <span className="ladder-baseline-metric-label">Lead Time</span>
                  <span className="ladder-baseline-metric-value">
                    {result.leadTimeDays != null ? `${result.leadTimeDays}d` : 'No data'}
                  </span>
                  <span className="ladder-baseline-metric-sample">({result.leadTimeSampleSize} items)</span>
                </div>
                <div className="ladder-baseline-metric">
                  <span className="ladder-baseline-metric-label">Defect Rate</span>
                  <span className="ladder-baseline-metric-value">
                    {result.defectRatePerPbi != null ? `${result.defectRatePerPbi} bugs/PBI` : 'No data'}
                  </span>
                </div>
              </div>
              <p className="ladder-baseline-saved-note">Saved. Reload the scorecard to see updated comparisons.</p>
            </div>
          )}

          {/* ── Skills configuration ── */}
          <div className="ladder-baseline-divider" />
          <div className="ladder-baseline-section-title">Team Skills in Use</div>
          <p className="ladder-baseline-desc">
            Register Cursor skills your team actively uses. These count toward the contribution criteria
            when the Cursor analytics API does not surface them automatically.
            Mark a skill as <strong>Shared</strong> to credit it toward the Bar 3 shared-registry criterion.
          </p>

          {skillsLoading && <div className="ladder-baseline-desc">Saving…</div>}
          {skillsSaved && !skillsLoading && <div className="ladder-baseline-saved-note">✓ Skills saved.</div>}

          {skills.length > 0 && (
            <table className="ladder-dev-table" style={{ marginBottom: 10 }}>
              <thead>
                <tr><th>Skill</th><th>Developer</th><th>Shared Registry</th><th></th></tr>
              </thead>
              <tbody>
                {skills.map((s, i) => (
                  <tr key={i}>
                    <td>{s.skillName}</td>
                    <td>{s.developer || '—'}</td>
                    <td>
                      <button
                        className={`ladder-skill-toggle ${s.sharedRegistry ? 'ladder-skill-shared' : 'ladder-skill-local'}`}
                        onClick={() => toggleShared(i)}
                      >
                        {s.sharedRegistry ? 'Shared' : 'Local'}
                      </button>
                    </td>
                    <td>
                      <button className="ladder-skill-remove" onClick={() => removeSkill(i)}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="ladder-baseline-fields">
            <label className="ladder-baseline-field">
              <span>Skill name</span>
              <input
                type="text"
                placeholder="/design-doc-kickoff"
                value={newSkillName}
                onChange={e => setNewSkillName(e.target.value)}
                className="ladder-baseline-input"
                onKeyDown={e => e.key === 'Enter' && addSkill()}
              />
            </label>
            <label className="ladder-baseline-field">
              <span>Developer (optional)</span>
              <input
                type="text"
                placeholder="All team"
                value={newSkillDev}
                onChange={e => setNewSkillDev(e.target.value)}
                className="ladder-baseline-input"
                onKeyDown={e => e.key === 'Enter' && addSkill()}
              />
            </label>
            <label className="ladder-baseline-field">
              <span>Shared registry</span>
              <input
                type="checkbox"
                checked={newSkillShared}
                onChange={e => setNewSkillShared(e.target.checked)}
                className="ladder-skill-checkbox"
              />
            </label>
            <button className="load-stats-button" onClick={addSkill} disabled={!newSkillName.trim() || skillsLoading}>
              Add Skill
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

interface AiCapabilityLadderSectionProps {
  fromDate: string;
  toDate: string;
  areaPath?: string;
}

// ── Status helpers ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: CriterionStatus }) {
  const config: Record<CriterionStatus, { label: string; cls: string }> = {
    met:       { label: 'Met',     cls: 'ladder-status-met' },
    'at-risk': { label: 'At Risk', cls: 'ladder-status-at-risk' },
    'not-met': { label: 'Not Met', cls: 'ladder-status-not-met' },
    unknown:   { label: 'Unknown', cls: 'ladder-status-unknown' },
  };
  const { label, cls } = config[status];
  return <span className={`ladder-status-badge ${cls}`}>{label}</span>;
}

function EvidencePill({ quality }: { quality: string }) {
  const cls =
    quality === 'definitive' ? 'ladder-evidence-definitive' :
    quality === 'configured' ? 'ladder-evidence-configured' :
    'ladder-evidence-inferred';
  const label =
    quality === 'definitive' ? 'Definitive' :
    quality === 'configured' ? 'Configured' :
    'Inferred';
  return <span className={`ladder-evidence-pill ${cls}`}>{label}</span>;
}

// ── Criterion row ──────────────────────────────────────────────────────────────

function CriterionRow({ criterion }: { criterion: LadderCriterion }) {
  const [expanded, setExpanded] = useState(false);
  const hasGaps = criterion.gapDisplay || criterion.developersNeedingLift.length > 0;

  return (
    <div className={`ladder-criterion${criterion.status === 'not-met' ? ' ladder-criterion-notmet' : criterion.status === 'at-risk' ? ' ladder-criterion-atrisk' : ''}`}>
      <div className="ladder-criterion-header" onClick={() => hasGaps && setExpanded(e => !e)} role={hasGaps ? 'button' : undefined} tabIndex={hasGaps ? 0 : undefined} onKeyDown={e => { if (hasGaps && (e.key === 'Enter' || e.key === ' ')) setExpanded(ex => !ex); }}>
        <span className="ladder-criterion-label">{criterion.label}</span>
        <div className="ladder-criterion-meta">
          <span className="ladder-criterion-current">{criterion.currentDisplay}</span>
          <span className="ladder-criterion-target">Goal: {criterion.targetDisplay}</span>
          <EvidencePill quality={criterion.evidenceQuality} />
          <StatusBadge status={criterion.status} />
          {hasGaps && (
            <span className="ladder-criterion-expand">{expanded ? '▲' : '▼'}</span>
          )}
        </div>
      </div>

      {expanded && (
        <div className="ladder-criterion-detail">
          {criterion.gapDisplay && (
            <div className="ladder-gap-banner">
              <span className="ladder-gap-icon">⚠</span>
              <span>{criterion.gapDisplay}</span>
            </div>
          )}
          <div className="ladder-evidence-source">Source: {criterion.evidenceSource}</div>
          {criterion.developersNeedingLift.length > 0 && (
            <div className="ladder-dev-gaps">
              <div className="ladder-dev-gaps-title">Developers needing lift</div>
              <table className="ladder-dev-table">
                <thead>
                  <tr>
                    <th>Developer</th>
                    <th>Current</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {criterion.developersNeedingLift.map(d => (
                    <tr key={d.email || d.name}>
                      <td>{d.name}{d.email && d.email !== d.name ? <span className="ladder-dev-email"> ({d.email})</span> : null}</td>
                      <td>{d.currentDisplay}</td>
                      <td>{d.action}</td>
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
}

// ── Bar card ───────────────────────────────────────────────────────────────────

function BarCard({ bar }: { bar: LadderBar }) {
  const [collapsed, setCollapsed] = useState(false);

  const categories = ['adoption', 'practice', 'outcomes', 'contribution'] as const;
  const categoryLabels: Record<string, string> = {
    adoption: 'Adoption',
    practice: 'Practice',
    outcomes: 'Outcomes',
    contribution: 'Contribution',
  };

  return (
    <div className={`ladder-bar ladder-bar-${bar.status}`}>
      <div className="ladder-bar-header" onClick={() => setCollapsed(c => !c)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setCollapsed(c => !c); }}>
        <span className="ladder-bar-title">{bar.title}</span>
        <div className="ladder-bar-header-right">
          <StatusBadge status={bar.status} />
          <span className="ladder-bar-chevron">{collapsed ? '▶' : '▼'}</span>
        </div>
      </div>

      {!collapsed && (
        <div className="ladder-bar-body">
          {categories.map(cat => {
            const criteria = bar.criteria.filter(c => c.category === cat);
            if (criteria.length === 0) return null;
            return (
              <div key={cat} className="ladder-category">
                <div className="ladder-category-label">{categoryLabels[cat]}</div>
                {criteria.map(c => <CriterionRow key={c.id} criterion={c} />)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Top gaps summary ───────────────────────────────────────────────────────────

function TopGapsSummary({ result }: { result: AiCapabilityLadderResult }) {
  if (result.topGaps.length === 0 && result.developersWithoutCursorActivity.length === 0) {
    return (
      <div className="ladder-top-gaps-empty">
        All evaluated criteria are met or at-risk. No critical gaps detected.
      </div>
    );
  }

  return (
    <div className="ladder-top-gaps">
      <div className="ladder-top-gaps-title">Top Gaps</div>
      {result.topGaps.map(g => (
        <div key={g.id} className={`ladder-gap-row ladder-gap-${g.status}`}>
          <StatusBadge status={g.status} />
          <span className="ladder-gap-label">{g.label}</span>
          <span className="ladder-gap-current">{g.currentDisplay}</span>
          {g.gapDisplay && <span className="ladder-gap-detail">{g.gapDisplay}</span>}
        </div>
      ))}
      {result.developersWithoutCursorActivity.length > 0 && (
        <div className="ladder-no-cursor">
          <span className="ladder-no-cursor-title">No Cursor activity detected:</span>
          <span className="ladder-no-cursor-names">
            {result.developersWithoutCursorActivity.map(d => d.name).join(', ')}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Main section ───────────────────────────────────────────────────────────────

export const AiCapabilityLadderSection: React.FC<AiCapabilityLadderSectionProps> = ({
  fromDate,
  toDate,
  areaPath,
}) => {
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AiCapabilityLadderResult | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from: fromDate, to: toDate });
      if (areaPath) params.set('areaPath', areaPath);
      const res = await fetch(`/api/ai-capability-ladder?${params}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: AiCapabilityLadderResult = await res.json();
      setResult(data);
      setLoaded(true);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load scorecard');
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate, areaPath]);

  const handleBaselineCaptured = useCallback(() => {
    if (loaded) load();
  }, [loaded, load]);

  return (
    <div className="stats-section ladder-section">
      <h3>
        <button
          className="collapse-button"
          onClick={() => setCollapsed(c => !c)}
          aria-label={collapsed ? 'Expand section' : 'Collapse section'}
        >
          {collapsed ? '▶' : '▼'}
        </button>
        AI Capability Ladder
        <span className="ladder-section-subtitle">Definitive scoring from Cursor + ADO</span>
      </h3>

      {!collapsed && (
        <>
          <BaselineCapturePanel onCaptured={handleBaselineCaptured} />

          <div className="filter-actions">
            <button
              onClick={load}
              disabled={loading}
              className="load-stats-button"
            >
              {loading ? 'Loading…' : loaded ? 'Refresh Scorecard' : 'Load Scorecard'}
            </button>
            {result && (
              <span className="ladder-eval-meta">
                Evaluated {new Date(result.evaluatedAt).toLocaleString()} · {result.adoTeamSize} ADO devs · {result.cursorSeats} Cursor seats · Window: {result.fromDate} → {result.toDate}
              </span>
            )}
          </div>

          {loading && (
            <div className="background-notification loading">
              <div className="notification-spinner" />
              <span className="notification-text">Fetching Cursor analytics and ADO metrics…</span>
            </div>
          )}

          {error && (
            <div className="background-notification error">
              <span className="notification-text">Error: {error}</span>
            </div>
          )}

          {!loaded && !loading && !error && (
            <p className="placeholder-text">
              Click "Load Scorecard" to evaluate AI adoption against Bar 1, 2, and 3 thresholds using Cursor analytics and ADO delivery data.
            </p>
          )}

          {loaded && result && !loading && (
            <>
              {result.cursorApiError && (
                <div className="ladder-cursor-error">
                  <span className="ladder-cursor-error-icon">⚠</span>
                  <div>
                    <strong>Cursor API unavailable</strong> — Cursor-based criteria show as Unknown.
                    <span className="ladder-cursor-error-detail"> {result.cursorApiError}</span>
                  </div>
                </div>
              )}
              <TopGapsSummary result={result} />
              <div className="ladder-bars">
                {result.bars.map(bar => <BarCard key={bar.bar} bar={bar} />)}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
};
