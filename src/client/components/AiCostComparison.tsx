import React, { useState, useMemo } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import styles from './AiCostComparison.module.css';
import { useAiCostComparison } from '../hooks/useAiCostAnalytics';
import type { ProjectComparisonProject } from '../../shared/types/aiCostAnalytics';

// ── Feature display names & colors (mirrors AiCostAnalytics.tsx) ──────────

const FEATURE_LABELS: Record<string, string> = {
  interview: 'Interview',
  prd: 'PRD Generation',
  'prd-review': 'PRD Review',
  'design-doc': 'Design Doc',
  'design-doc-validation': 'Doc Validation',
  'design-plan': 'Design Plan',
  'design-prototype': 'Prototype',
  'my-work': 'My Work (Dev)',
  standup: 'Standup',
  'test-case': 'Test Cases',
  'feature-request': 'Feature Requests',
  'ui-lab': 'UI Lab',
  'backlog-generate': 'Backlog Generation',
  'home-chat': 'Home Chat',
  'ai-cost-insights': 'AI Cost Insights',
  other: 'Other',
};

const FEATURE_COLORS: Record<string, string> = {
  interview: '#6366f1',
  prd: '#8b5cf6',
  'prd-review': '#a78bfa',
  'design-doc': '#ec4899',
  'design-doc-validation': '#f472b6',
  'design-plan': '#f43f5e',
  'design-prototype': '#ef4444',
  'my-work': '#f97316',
  standup: '#eab308',
  'test-case': '#84cc16',
  'feature-request': '#22c55e',
  'ui-lab': '#06b6d4',
  'backlog-generate': '#0ea5e9',
  'home-chat': '#3b82f6',
  'ai-cost-insights': '#64748b',
  other: '#94a3b8',
};

const PROJECT_COLORS = [
  '#6366f1', '#ec4899', '#f59e0b', '#22c55e', '#06b6d4',
  '#8b5cf6', '#f97316', '#84cc16', '#3b82f6', '#a78bfa',
];

function featureLabel(f: string): string {
  return FEATURE_LABELS[f] ?? f;
}

function featureColor(f: string): string {
  return FEATURE_COLORS[f] ?? '#94a3b8';
}

function projectColor(index: number): string {
  return PROJECT_COLORS[index % PROJECT_COLORS.length] ?? '#94a3b8';
}

// ── Formatters ────────────────────────────────────────────────────────────

function formatCost(usd: number): string {
  if (usd < 0.001) return '$0.00';
  if (usd < 1) return `$${usd.toFixed(4)}`;
  if (usd < 1000) return `$${usd.toFixed(2)}`;
  return `$${(usd / 1000).toFixed(2)}k`;
}

type DatePreset = '7d' | '30d' | '90d';

function getPresetDates(preset: DatePreset): { from: string; to: string } {
  const to = new Date().toISOString();
  const from = new Date();
  from.setDate(from.getDate() - parseInt(preset, 10));
  return { from: from.toISOString(), to };
}

// ── Apex A-mark SVG icon ──────────────────────────────────────────────────

const ApexIcon: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ width: size, height: size }}>
    <path d="M20 72L43 22H56L34 72H20Z" fill="#fff" />
    <path d="M52 22L78 72H61L43 38L52 22Z" fill="#fff" opacity="0.9" />
    <path d="M40 72L49 54L58 72H40Z" fill="rgba(255,255,255,0.5)" />
  </svg>
);

// ── Custom tooltip ────────────────────────────────────────────────────────

interface TooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}

const ComparisonTooltip: React.FC<TooltipProps> = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className={styles.customTooltip}>
      <div className={styles.tooltipLabel}>{label}</div>
      {payload.map((p) => (
        <div key={p.name} className={styles.tooltipRow}>
          <span>
            <span className={styles.tooltipDot} style={{ background: p.color }} />
            {p.name}
          </span>
          <span style={{ fontWeight: 600 }}>{formatCost(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

// ── Section 1 — Project Leaderboard ──────────────────────────────────────

interface LeaderboardProps {
  projects: ProjectComparisonProject[];
}

const ProjectLeaderboard: React.FC<LeaderboardProps> = ({ projects }) => {
  const [expandedProject, setExpandedProject] = useState<string | null>(null);

  const maxCost = useMemo(() => Math.max(...projects.map((p) => p.totalCostUsd), 0.0001), [projects]);

  if (!projects.length) {
    return <div className={styles.emptyState}>No project data for this period</div>;
  }

  return (
    <div className={styles.leaderboard}>
      {projects.map((p) => {
        const isExpanded = expandedProject === p.project;
        const cursorPct = p.totalCostUsd > 0 ? (p.cursorCostUsd / p.totalCostUsd) * 100 : 0;
        const bedrockPct = p.totalCostUsd > 0 ? (p.bedrockCostUsd / p.totalCostUsd) * 100 : 0;
        const barWidth = maxCost > 0 ? (p.totalCostUsd / maxCost) * 100 : 0;
        const rankClass =
          p.rank === 1 ? styles.rankGold : p.rank === 2 ? styles.rankSilver : p.rank === 3 ? styles.rankBronze : styles.rankDefault;

        const topFeatures = [...p.features].sort((a, b) => b.costUsd - a.costUsd).slice(0, 6);
        const maxFeatureCost = topFeatures[0]?.costUsd ?? 0.0001;

        return (
          <React.Fragment key={p.project}>
            <div
              className={`${styles.leaderboardRow} ${isExpanded ? styles.leaderboardRowExpanded : ''}`}
              onClick={() => setExpandedProject(isExpanded ? null : p.project)}
            >
              <span className={`${styles.rankBadge} ${rankClass}`}>{p.rank}</span>

              <span className={styles.leaderboardProject} title={p.project}>{p.project}</span>

              <div className={styles.leaderboardBarWrap}>
                <div className={styles.leaderboardBarTrack}>
                  <div className={styles.leaderboardBarCursor} style={{ width: `${Math.min(barWidth * (cursorPct / 100), barWidth)}%` }} />
                  <div
                    className={styles.leaderboardBarBedrock}
                    style={{
                      left: `${Math.min(barWidth * (cursorPct / 100), barWidth)}%`,
                      width: `${Math.min(barWidth * (bedrockPct / 100), barWidth)}%`,
                    }}
                  />
                </div>
                <div className={styles.leaderboardBarLabel}>
                  <span style={{ color: '#6366f1' }}>● Cursor {cursorPct.toFixed(0)}%</span>
                  <span style={{ color: '#f59e0b' }}>● Bedrock {bedrockPct.toFixed(0)}%</span>
                </div>
              </div>

              <div className={styles.leaderboardMeta}>
                <span className={styles.leaderboardCost}>{formatCost(p.totalCostUsd)}</span>
                <span className={styles.leaderboardInteractions}>{p.interactions.toLocaleString()} interactions</span>
              </div>

              <span className={`${styles.expandChevron} ${isExpanded ? styles.expandChevronOpen : ''}`}>▼</span>
            </div>

            {isExpanded && topFeatures.length > 0 && (
              <div className={styles.featureBreakdown}>
                <div className={styles.featureBreakdownTitle}>Feature breakdown</div>
                <div className={styles.featureBreakdownGrid}>
                  {topFeatures.map((f) => (
                    <div key={f.feature} className={styles.featureBreakdownRow}>
                      <span className={styles.featureBreakdownName} title={featureLabel(f.feature)}>
                        {featureLabel(f.feature)}
                      </span>
                      <div className={styles.featureBreakdownBarTrack}>
                        <div
                          className={styles.featureBreakdownBar}
                          style={{
                            width: `${maxFeatureCost > 0 ? (f.costUsd / maxFeatureCost) * 100 : 0}%`,
                            background: featureColor(f.feature),
                          }}
                        />
                      </div>
                      <span className={styles.featureBreakdownCost}>{formatCost(f.costUsd)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
};

// ── Section 2 — Head-to-Head Feature Chart ────────────────────────────────

interface HeadToHeadProps {
  projects: ProjectComparisonProject[];
}

const HeadToHeadChart: React.FC<HeadToHeadProps> = ({ projects }) => {
  const top5Features = useMemo(() => {
    const featureTotals = new Map<string, number>();
    for (const p of projects) {
      for (const f of p.features) {
        featureTotals.set(f.feature, (featureTotals.get(f.feature) ?? 0) + f.costUsd);
      }
    }
    return Array.from(featureTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([f]) => f);
  }, [projects]);

  const chartData = useMemo(() => {
    return top5Features.map((feature) => {
      const row: Record<string, string | number> = { feature: featureLabel(feature) };
      for (const p of projects.slice(0, 8)) {
        const f = p.features.find((x) => x.feature === feature);
        row[p.project] = f?.costUsd ?? 0;
      }
      return row;
    });
  }, [top5Features, projects]);

  if (!projects.length || !top5Features.length) {
    return <div className={styles.emptyState}>No data to compare</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
        <XAxis dataKey="feature" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} />
        <YAxis tickFormatter={(v) => formatCost(v)} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} />
        <Tooltip content={<ComparisonTooltip />} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
        {projects.slice(0, 8).map((p, i) => (
          <Bar key={p.project} dataKey={p.project} fill={projectColor(i)} radius={[3, 3, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
};

// ── Section 3 — Feature Rankings (Stacked) ────────────────────────────────

interface FeatureRankingsProps {
  projects: ProjectComparisonProject[];
}

const FeatureRankingsChart: React.FC<FeatureRankingsProps> = ({ projects }) => {
  const chartData = useMemo(() => {
    const featureTotals = new Map<string, Map<string, number>>();
    for (const p of projects) {
      for (const f of p.features) {
        if (!featureTotals.has(f.feature)) featureTotals.set(f.feature, new Map());
        featureTotals.get(f.feature)!.set(p.project, f.costUsd);
      }
    }
    return Array.from(featureTotals.entries())
      .map(([feature, projectMap]) => {
        const row: Record<string, string | number> = { feature: featureLabel(feature) };
        let total = 0;
        for (const [proj, cost] of projectMap.entries()) {
          row[proj] = cost;
          total += cost;
        }
        row['_total'] = total;
        return row;
      })
      .sort((a, b) => (b['_total'] as number) - (a['_total'] as number))
      .slice(0, 10);
  }, [projects]);

  if (!projects.length) return <div className={styles.emptyState}>No data</div>;

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
        <XAxis dataKey="feature" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} />
        <YAxis tickFormatter={(v) => formatCost(v)} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} />
        <Tooltip content={<ComparisonTooltip />} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
        {projects.slice(0, 8).map((p, i) => (
          <Bar key={p.project} dataKey={p.project} stackId="a" fill={projectColor(i)} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
};

// ── Section 4 — Cross-Project Model Mix ──────────────────────────────────

interface ModelMixProps {
  projects: ProjectComparisonProject[];
}

const ModelMixChart: React.FC<ModelMixProps> = ({ projects }) => {
  const chartData = useMemo(() => {
    return projects.slice(0, 10).map((p) => ({
      project: p.project.length > 12 ? `${p.project.slice(0, 12)}…` : p.project,
      fullProject: p.project,
      Cursor: p.cursorCostUsd,
      Bedrock: p.bedrockCostUsd,
    }));
  }, [projects]);

  if (!projects.length) return <div className={styles.emptyState}>No data</div>;

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
        <XAxis dataKey="project" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} />
        <YAxis tickFormatter={(v) => formatCost(v)} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} />
        <Tooltip
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const fullProject = chartData.find((d) => d.project === label)?.fullProject ?? label;
            return (
              <div className={styles.customTooltip}>
                <div className={styles.tooltipLabel}>{fullProject}</div>
                {payload.map((p, idx) => (
                  <div key={idx} className={styles.tooltipRow}>
                    <span><span className={styles.tooltipDot} style={{ background: String(p.color ?? '') }} />{String(p.name ?? '')}</span>
                    <span style={{ fontWeight: 600 }}>{formatCost(Number(p.value) || 0)}</span>
                  </div>
                ))}
              </div>
            );
          }}
        />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
        <Bar dataKey="Cursor" stackId="b" fill="#6366f1" />
        <Bar dataKey="Bedrock" stackId="b" fill="#f59e0b" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
};

// ── Section 5 — Efficiency Table ──────────────────────────────────────────

interface EfficiencyTableProps {
  projects: ProjectComparisonProject[];
}

const EfficiencyTable: React.FC<EfficiencyTableProps> = ({ projects }) => {
  const rows = useMemo(() => {
    return projects.map((p) => {
      const costPerInteraction = p.interactions > 0 ? p.totalCostUsd / p.interactions : 0;
      const prdFeature = p.features.find((f) => f.feature === 'prd');
      const docFeature = p.features.find((f) => f.feature === 'design-doc');
      const protoFeature = p.features.find((f) => f.feature === 'design-prototype');
      const cursorPct = p.totalCostUsd > 0 ? (p.cursorCostUsd / p.totalCostUsd) * 100 : 0;
      const bedrockPct = p.totalCostUsd > 0 ? (p.bedrockCostUsd / p.totalCostUsd) * 100 : 0;

      return {
        project: p.project,
        rank: p.rank,
        costPerInteraction,
        costPerPrd: prdFeature && prdFeature.interactions > 0 ? prdFeature.costUsd / prdFeature.interactions : null,
        costPerDoc: docFeature && docFeature.interactions > 0 ? docFeature.costUsd / docFeature.interactions : null,
        costPerProto: protoFeature && protoFeature.interactions > 0 ? protoFeature.costUsd / protoFeature.interactions : null,
        cursorPct,
        bedrockPct,
        interactions: p.interactions,
        totalCostUsd: p.totalCostUsd,
      };
    });
  }, [projects]);

  const avgCostPerInteraction = useMemo(() => {
    const valid = rows.filter((r) => r.interactions > 0);
    if (!valid.length) return 0;
    return valid.reduce((s, r) => s + r.costPerInteraction, 0) / valid.length;
  }, [rows]);

  if (!rows.length) return <div className={styles.emptyState}>No data</div>;

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className={styles.efficiencyTable}>
        <thead>
          <tr>
            <th>Project</th>
            <th>$/Interaction</th>
            <th>$/PRD</th>
            <th>$/Design Doc</th>
            <th>$/Prototype</th>
            <th>Provider Split</th>
            <th>Interactions</th>
            <th>Total Spend</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const effClass =
              r.costPerInteraction < avgCostPerInteraction ? styles.cellGreen
              : r.costPerInteraction > avgCostPerInteraction * 1.3 ? styles.cellRed
              : styles.cellNeutral;

            return (
              <tr key={r.project}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: projectColor(r.rank - 1), flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{r.project}</span>
                  </div>
                </td>
                <td className={effClass}>{formatCost(r.costPerInteraction)}</td>
                <td className={styles.cellNeutral}>{r.costPerPrd != null ? formatCost(r.costPerPrd) : '—'}</td>
                <td className={styles.cellNeutral}>{r.costPerDoc != null ? formatCost(r.costPerDoc) : '—'}</td>
                <td className={styles.cellNeutral}>{r.costPerProto != null ? formatCost(r.costPerProto) : '—'}</td>
                <td>
                  <div className={styles.providerSplit}>
                    <span className={`${styles.splitPill} ${styles.splitCursor}`}>{r.cursorPct.toFixed(0)}% C</span>
                    <span className={`${styles.splitPill} ${styles.splitBedrock}`}>{r.bedrockPct.toFixed(0)}% B</span>
                  </div>
                </td>
                <td>{r.interactions.toLocaleString()}</td>
                <td style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{formatCost(r.totalCostUsd)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────

interface AiCostComparisonProps {
  onBack: () => void;
}

export const AiCostComparison: React.FC<AiCostComparisonProps> = ({ onBack }) => {
  const [preset, setPreset] = useState<DatePreset>('30d');

  const dates = useMemo(() => getPresetDates(preset), [preset]);
  const { data, isLoading } = useAiCostComparison({ from: dates.from, to: dates.to });

  const projects = data?.projects ?? [];

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerRow}>
          <div className={styles.titleGroup}>
            <div className={styles.titleIcon}>
              <ApexIcon size={20} />
            </div>
            <div>
              <h1 className={styles.pageTitle}>Project Comparison</h1>
              <p className={styles.pageSubtitle}>
                Cross-project AI cost breakdown · {projects.length} projects · Platform admin only
              </p>
            </div>
          </div>

          <div className={styles.headerActions}>
            <span className={styles.adminBadge}>
              <ApexIcon size={10} /> Super Admin
            </span>
            <button className={styles.backBtn} onClick={onBack}>
              ← AI Cost Overview
            </button>
          </div>
        </div>
      </div>

      {/* Period filter */}
      <div className={styles.filterBar}>
        <span className={styles.filterLabel}>Period</span>
        {(['7d', '30d', '90d'] as DatePreset[]).map((p) => (
          <button
            key={p}
            className={`${styles.presetBtn} ${preset === p ? styles.presetBtnActive : ''}`}
            onClick={() => setPreset(p)}
          >
            {p}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className={styles.loadingState}>Loading comparison data…</div>
      ) : (
        <>
          {/* Section 1 — Project Leaderboard */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <div className={styles.sectionIcon}>
                <ApexIcon size={14} />
              </div>
              <div>
                <p className={styles.sectionTitle}>Project Leaderboard</p>
                <p className={styles.sectionSubtitle}>Ranked by total spend · Click a row to expand feature breakdown</p>
              </div>
            </div>
            <div className={styles.card}>
              <ProjectLeaderboard projects={projects} />
            </div>
          </div>

          {/* Section 2 & 3 — Side by side charts */}
          <div className={styles.twoCol}>
            {/* Section 2 — Head-to-Head */}
            <div className={styles.card}>
              <div className={styles.chartHeader}>
                <div>
                  <p className={styles.chartTitle}>Head-to-Head: Top Features by Project</p>
                  <p className={styles.chartSubtitle}>Grouped bars — top 5 costliest features across projects</p>
                </div>
              </div>
              <HeadToHeadChart projects={projects} />
            </div>

            {/* Section 4 — Provider Mix */}
            <div className={styles.card}>
              <div className={styles.chartHeader}>
                <div>
                  <p className={styles.chartTitle}>Cursor vs Bedrock by Project</p>
                  <p className={styles.chartSubtitle}>Which projects rely on which provider</p>
                </div>
              </div>
              <div className={styles.legendRow}>
                <div className={styles.legendItem}>
                  <span className={styles.legendDot} style={{ background: '#6366f1' }} /> Cursor SDK
                </div>
                <div className={styles.legendItem}>
                  <span className={styles.legendDot} style={{ background: '#f59e0b' }} /> AWS Bedrock
                </div>
              </div>
              <ModelMixChart projects={projects} />
            </div>
          </div>

          {/* Section 3 — Feature Rankings (full-width stacked) */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <div className={styles.sectionIcon}>
                <ApexIcon size={14} />
              </div>
              <div>
                <p className={styles.sectionTitle}>Feature Cost Rankings — Platform-Wide</p>
                <p className={styles.sectionSubtitle}>Stacked bars show which projects drive each feature's cost</p>
              </div>
            </div>
            <div className={styles.card}>
              <FeatureRankingsChart projects={projects} />
            </div>
          </div>

          {/* Section 5 — Efficiency Table */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <div className={styles.sectionIcon}>
                <ApexIcon size={14} />
              </div>
              <div>
                <p className={styles.sectionTitle}>Efficiency Comparison</p>
                <p className={styles.sectionSubtitle}>
                  Cost-per-outcome metrics · Green = below average, red = 30%+ above average
                </p>
              </div>
            </div>
            <div className={styles.card}>
              <EfficiencyTable projects={projects} />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default AiCostComparison;
