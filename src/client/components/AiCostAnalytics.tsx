import React, { useState, useMemo } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from 'recharts';
import styles from './AiCostAnalytics.module.css';
import { AiCostDrillDown, type DrillDownDimension } from './AiCostDrillDown';
import { AiCostComparison } from './AiCostComparison';
import {
  useAiCostSummary,
  useAiCostTimeseries,
  useAiCostByFeature,
  useAiCostByModel,
  useAiCostByProject,
  useAiCostByUser,
  useAiCostEvents,
  useAiCostReconciliation,
  useAiCostForecast,
  useSyncAiCost,
  useAiCostDailyBrief,
  type AiCostFilters,
} from '../hooks/useAiCostAnalytics';
import { useAppShell } from '../hooks/useAppShell';
import type { AiCostTimeseriesPoint, AiCostForecast } from '../../shared/types/aiCostAnalytics';

// ── Feature display names ─────────────────────────────────────────────────────

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
  'home-chat': 'Home Chat (Ask Apex)',
  'ai-cost-insights': 'AI Cost Insights',
  other: 'Other',
};

function featureLabel(feature: string): string {
  return FEATURE_LABELS[feature] ?? feature;
}

const PROVIDER_COLORS: Record<string, string> = {
  cursor: '#6366f1',
  bedrock: '#f59e0b',
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

const PIE_COLORS = Object.values(FEATURE_COLORS);

function getFeatureColor(feature: string): string {
  return FEATURE_COLORS[feature] ?? '#94a3b8';
}

// ── Formatters ───────────────────────────────────────────────────────────────

function formatCost(usd: number): string {
  if (usd < 0.001) return '$0.00';
  if (usd < 1) return `$${usd.toFixed(4)}`;
  if (usd < 1000) return `$${usd.toFixed(2)}`;
  return `$${(usd / 1000).toFixed(2)}k`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Date preset helper ───────────────────────────────────────────────────────

type DatePreset = '7d' | '30d' | '90d';

function getPresetDates(preset: DatePreset): { from: string; to: string } {
  const to = new Date().toISOString();
  const from = new Date();
  from.setDate(from.getDate() - parseInt(preset, 10));
  return { from: from.toISOString(), to };
}

// ── Custom tooltip ────────────────────────────────────────────────────────────

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}

const CustomTooltip: React.FC<CustomTooltipProps> = ({ active, payload, label }) => {
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

// ── KPI card ─────────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  delta?: number;
  accent?: 'default' | 'green' | 'blue' | 'orange';
  onClick?: () => void;
}

const KpiCard: React.FC<KpiCardProps> = ({ label, value, sub, delta, accent = 'default', onClick }) => {
  const accentClass = accent === 'green' ? styles.kpiCardAccentGreen : accent === 'blue' ? styles.kpiCardAccentBlue : accent === 'orange' ? styles.kpiCardAccentOrange : styles.kpiCardAccent;
  const deltaClass = delta === undefined ? '' : delta > 0 ? styles.kpiDeltaUp : delta < 0 ? styles.kpiDeltaDown : styles.kpiDeltaFlat;
  const deltaIcon = delta === undefined ? '' : delta > 0 ? '↑' : delta < 0 ? '↓' : '→';

  return (
    <div
      className={styles.kpiCard}
      onClick={onClick}
      style={onClick ? { cursor: 'pointer' } : undefined}
      title={onClick ? `Click to drill down into ${label}` : undefined}
    >
      <div className={accentClass} />
      <div className={styles.kpiLabel}>{label}{onClick && <span style={{ fontSize: 10, marginLeft: 4, opacity: 0.5 }}>↗</span>}</div>
      <div className={styles.kpiValue}>{value}</div>
      {delta !== undefined && (
        <span className={`${styles.kpiDelta} ${deltaClass}`}>
          {deltaIcon} {Math.abs(delta).toFixed(1)}%
        </span>
      )}
      {sub && <div className={styles.kpiSub}>{sub}</div>}
    </div>
  );
};

// ── Spend timeseries chart (historical + forecast) ───────────────────────────

interface SpendChartProps {
  timeseries: AiCostTimeseriesPoint[];
  forecast?: AiCostForecast;
  isLoading: boolean;
}

const SpendChart: React.FC<SpendChartProps> = ({ timeseries, forecast, isLoading }) => {
  const today = new Date().toISOString().split('T')[0]!;

  const combined = useMemo(() => {
    const hist = timeseries.map((p) => ({
      date: formatDate(p.date),
      rawDate: p.date,
      cursor: p.cursorCostUsd,
      bedrock: p.bedrockCostUsd,
      forecast: undefined as number | undefined,
      lower: undefined as number | undefined,
      upper: undefined as number | undefined,
    }));

    const fcastPoints = forecast?.series.slice(0, 14) ?? [];
    const fcast = fcastPoints.map((p) => ({
      date: formatDate(p.date),
      rawDate: p.date,
      cursor: undefined as number | undefined,
      bedrock: undefined as number | undefined,
      forecast: p.predictedCostUsd,
      lower: p.lowerBoundUsd,
      upper: p.upperBoundUsd,
    }));

    return [...hist, ...fcast];
  }, [timeseries, forecast]);

  if (isLoading) return <div className={styles.loadingSpinner}>Loading...</div>;
  if (!combined.length) return <div className={styles.emptyState}>No spend data for this period</div>;

  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={combined} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="gradCursor" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={PROVIDER_COLORS.cursor} stopOpacity={0.4} />
            <stop offset="100%" stopColor={PROVIDER_COLORS.cursor} stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="gradBedrock" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={PROVIDER_COLORS.bedrock} stopOpacity={0.4} />
            <stop offset="100%" stopColor={PROVIDER_COLORS.bedrock} stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="gradForecast" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#94a3b8" stopOpacity={0.25} />
            <stop offset="100%" stopColor="#94a3b8" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
        <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
        <YAxis tickFormatter={(v) => formatCost(v)} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} />
        <Tooltip content={<CustomTooltip />} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
        <ReferenceLine x={formatDate(today)} stroke="#64748b" strokeDasharray="4 2" label={{ value: 'Today', position: 'top', fontSize: 10, fill: 'var(--text-muted)' }} />
        <Area type="monotone" dataKey="cursor" name="Cursor" stroke={PROVIDER_COLORS.cursor} fill="url(#gradCursor)" strokeWidth={2} dot={false} />
        <Area type="monotone" dataKey="bedrock" name="Bedrock" stroke={PROVIDER_COLORS.bedrock} fill="url(#gradBedrock)" strokeWidth={2} dot={false} />
        <Area type="monotone" dataKey="forecast" name="Forecast" stroke="#94a3b8" fill="url(#gradForecast)" strokeWidth={1.5} strokeDasharray="5 3" dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
};

// ── Feature bar chart ─────────────────────────────────────────────────────────

const FeatureBarChart: React.FC<{ data: Array<{ feature: string; costUsd: number; interactions: number }>; isLoading: boolean; onFeatureClick?: (feature: string) => void }> = ({ data, isLoading, onFeatureClick }) => {
  if (isLoading) return <div className={styles.loadingSpinner}>Loading...</div>;
  if (!data.length) return <div className={styles.emptyState}>No data</div>;

  const sorted = [...data].sort((a, b) => b.costUsd - a.costUsd).slice(0, 10);
  const chartData = sorted.map(d => ({ ...d, label: featureLabel(d.feature) }));

  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart
        data={chartData}
        layout="vertical"
        margin={{ top: 0, right: 40, left: 110, bottom: 0 }}
        onClick={onFeatureClick ? (data: any) => { const f = data?.activePayload?.[0]?.payload?.feature; if (f) onFeatureClick(f); } : undefined}
        style={onFeatureClick ? { cursor: 'pointer' } : undefined}
      >
        <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border-color)" />
        <XAxis type="number" tickFormatter={(v) => formatCost(v)} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} tickLine={false} axisLine={false} width={105} />
        <Tooltip formatter={(v) => [formatCost(Number(v) || 0), 'Cost']} cursor={{ fill: 'rgba(99,102,241,0.05)' }} />
        <Bar dataKey="costUsd" radius={[0, 4, 4, 0]} name="Cost">
          {chartData.map((entry) => (
            <Cell key={entry.feature} fill={getFeatureColor(entry.feature)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
};

// ── Model mix donut ───────────────────────────────────────────────────────────

const ModelDonut: React.FC<{ data: Array<{ modelId: string; costUsd: number }>; isLoading: boolean }> = ({ data, isLoading }) => {
  if (isLoading) return <div className={styles.loadingSpinner}>Loading...</div>;
  if (!data.length) return <div className={styles.emptyState}>No data</div>;

  const top = [...data].sort((a, b) => b.costUsd - a.costUsd).slice(0, 6);
  const pieData = top.map((d, i) => ({
    name: d.modelId.replace(/^us\.anthropic\./, '').replace(/-\d+v\d+:\d+$/, ''),
    value: d.costUsd,
    fill: PIE_COLORS[i % PIE_COLORS.length],
  }));

  const total = pieData.reduce((s, d) => s + d.value, 0);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <ResponsiveContainer width={150} height={150}>
        <PieChart>
          <Pie data={pieData} cx="50%" cy="50%" innerRadius={40} outerRadius={65} dataKey="value" strokeWidth={2} stroke="var(--bg-secondary)">
            {pieData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
          </Pie>
          <Tooltip formatter={(v) => [formatCost(Number(v) || 0), 'Cost']} />
        </PieChart>
      </ResponsiveContainer>
      <div style={{ flex: 1, minWidth: 0 }}>
        {pieData.map((d) => (
          <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: d.fill, flexShrink: 0 }} />
            <span style={{ fontSize: 11, color: 'var(--text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.name}>{d.name}</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{total > 0 ? Math.round(d.value / total * 100) : 0}%</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ── AI Insights panel REMOVED — replaced by Morning/Afternoon Brief ────────────
// Keeping this comment as a tombstone so future agents know it was intentional.
// The InsightsPanel was removed because insights are now embedded in the
// Executive Daily Brief (8am + 2pm auto-generated, see aiCostDailyBriefService.ts)

const _InsightsPanelRemoved: React.FC<{ project: string }> = ({ project }) => {
  // no-op placeholder to prevent unused import warnings during cleanup
  void project;
  return null;
}; void _InsightsPanelRemoved;

const InsightsPanel: React.FC<{ project: string }> = ({ project }) => {
  void project;
  return null;
}; void InsightsPanel;

// ── Events drill-down table ───────────────────────────────────────────────────

interface EventsTableProps {
  filters: AiCostFilters;
}

const EventsTable: React.FC<EventsTableProps> = ({ filters }) => {
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;
  const { data, isLoading } = useAiCostEvents(filters, page, PAGE_SIZE);

  if (isLoading) return <div className={styles.loadingSpinner}>Loading events...</div>;
  if (!data?.events.length) return <div className={styles.emptyState}>No interactions recorded yet</div>;

  return (
    <>
      <table className={styles.eventsTable}>
        <thead>
          <tr>
            <th>Feature</th>
            <th>Model</th>
            <th>Provider</th>
            <th>Tokens (in/out)</th>
            <th>Cost</th>
            <th>Source</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {data.events.map((e) => (
            <tr key={e.id}>
              <td><span className={styles.featureChip} style={{ background: `${getFeatureColor(e.feature)}18`, color: getFeatureColor(e.feature) }}>{featureLabel(e.feature)}</span></td>
              <td><span className={styles.modelChip} title={e.modelId}>{e.modelId.replace(/^us\.anthropic\./, '').replace(/-\d+v\d+:\d+$/, '')}</span></td>
              <td><span className={styles.modelChip}>{e.provider}</span></td>
              <td className={styles.tokenCell}>{formatTokens(e.inputTokens)} / {formatTokens(e.outputTokens)}</td>
              <td className={styles.costCell}>{formatCost(e.costUsd)}</td>
              <td><span className={e.costSource === 'computed' ? styles.exactBadge : styles.estimatedBadge}>{e.costSource}</span></td>
              <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{new Date(e.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className={styles.pagination}>
        <button className={styles.pageBtn} disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
        <span className={styles.pageInfo}>Page {page} of {Math.max(1, Math.ceil(data.total / PAGE_SIZE))}</span>
        <button className={styles.pageBtn} disabled={page >= Math.ceil(data.total / PAGE_SIZE)} onClick={() => setPage(p => p + 1)}>Next →</button>
      </div>
    </>
  );
};

// ── Executive Daily Brief Banner ──────────────────────────────────────────────

interface ExecutiveBriefBannerProps {
  project: string;
  onDismiss: () => void;
}

const ExecutiveBriefBanner: React.FC<ExecutiveBriefBannerProps> = ({ project, onDismiss }) => {
  const { data: brief, isLoading } = useAiCostDailyBrief(project);

  if (isLoading) return null;

  const trendClass = brief?.trendDirection === 'up' ? styles.briefTrendUp
    : brief?.trendDirection === 'down' ? styles.briefTrendDown
    : styles.briefTrendFlat;
  const trendIcon = brief?.trendDirection === 'up' ? '↑' : brief?.trendDirection === 'down' ? '↓' : '→';

  // Format the briefDate as "Yesterday, Jul 9"
  const briefDateLabel = brief?.briefDate
    ? (() => {
        const d = new Date(brief.briefDate + 'T12:00:00');
        const isToday = d.toISOString().split('T')[0] === new Date().toISOString().split('T')[0]; void isToday;
        const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        if (brief.briefType === 'afternoon') return `Today · ${dateStr} (2pm update)`;
        return `Yesterday · ${dateStr}`;
      })()
    : null;

  return (
    <div className={styles.briefBanner}>
      <div className={styles.briefBannerGlow} />
      <div className={styles.briefBannerHeader}>
        <div className={styles.briefBannerLeft}>
          <span className={styles.briefBannerBadge}>
            <svg viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ width: 12, height: 12 }}>
              <path d="M20 72L43 22H56L34 72H20Z" fill="#fff" />
              <path d="M52 22L78 72H61L43 38L52 22Z" fill="#fff" opacity="0.9" />
              <path d="M40 72L49 54L58 72H40Z" fill="rgba(255,255,255,0.5)" />
            </svg>
            {brief?.briefType === 'afternoon' ? 'Apex Afternoon Update' : 'Apex Daily Brief'}
          </span>
          {briefDateLabel && <span className={styles.briefBannerDate}>{briefDateLabel}</span>}
          {brief && (
            <span className={`${styles.briefTrend} ${trendClass}`}>
              {trendIcon} {Math.abs(brief.trendPct).toFixed(1)}%
            </span>
          )}
        </div>
        <div className={styles.briefBannerActions}>
          <button className={styles.dismissBtn} onClick={onDismiss} title="Dismiss for this session">×</button>
        </div>
      </div>

      {!brief ? (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          No brief yet — Apex Daily Brief auto-generates at 8am (yesterday's recap) and 2pm (today so far).
        </div>
      ) : (
        <>
          {brief.headline && <p className={styles.briefBannerHeadline}>{brief.headline}</p>}

          <div className={styles.briefBannerStats}>
            <div className={styles.briefStat}>
              <div className={styles.briefStatLabel}>{brief.briefType === 'afternoon' ? 'Today So Far' : 'Yesterday'}</div>
              <div className={styles.briefStatValue}>{formatCost(brief.totalCostUsd)}</div>
            </div>
            <div className={styles.briefStatSep} />
            <div className={styles.briefStat}>
              <div className={styles.briefStatLabel}>Month-to-Date</div>
              <div className={styles.briefStatValue}>{formatCost(brief.mtdCostUsd)}</div>
            </div>
            <div className={styles.briefStatSep} />
            <div className={styles.briefStat}>
              <div className={styles.briefStatLabel}>Projected EOM</div>
              <div className={styles.briefStatValue}>{formatCost(brief.projectedEomUsd)}</div>
            </div>
            <div className={styles.briefStatSep} />
            <div className={styles.briefStat}>
              <div className={styles.briefStatLabel}>{brief.briefType === 'afternoon' ? "Today's Interactions" : "Yesterday's Interactions"}</div>
              <div className={styles.briefStatValue}>{brief.totalInteractions}</div>
            </div>
          </div>

          {brief.keyBullets.length > 0 && (
            <div className={styles.briefBullets}>
              {brief.keyBullets.map((b, i) => (
                <div key={i} className={styles.briefBullet}>
                  <span className={styles.briefBulletDot} />
                  {b}
                </div>
              ))}
            </div>
          )}

          {brief.alerts.length > 0 && (
            <div className={styles.briefAlerts}>
              {brief.alerts.map((a, i) => (
                <div key={i} className={styles.briefAlert}>⚠ {a}</div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

interface AiCostAnalyticsProps {
  project: string;
}

export const AiCostAnalytics: React.FC<AiCostAnalyticsProps> = ({ project }) => {
  const { isSuperAdmin } = useAppShell();
  const [preset, setPreset] = useState<DatePreset>('30d');
  const [activeProject, setActiveProject] = useState(project);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [drillDown, setDrillDown] = useState<DrillDownDimension | null>(null);
  const [briefDismissed, setBriefDismissed] = useState(false);
  const [showComparison, setShowComparison] = useState(false);

  const sync = useSyncAiCost();

  const dates = useMemo(() => getPresetDates(preset), [preset]);

  const filters: AiCostFilters = useMemo(() => ({
    from: dates.from,
    to: dates.to,
    project: activeProject,
  }), [dates, activeProject]);

  const { data: summary, isLoading: summaryLoading } = useAiCostSummary(filters);
  const { data: timeseries, isLoading: tsLoading } = useAiCostTimeseries(filters);
  const { data: byFeature, isLoading: featureLoading } = useAiCostByFeature(filters);
  const { data: byModel, isLoading: modelLoading } = useAiCostByModel(filters);
  const { data: reconciliation } = useAiCostReconciliation(filters);
  const { data: forecast } = useAiCostForecast(activeProject);
  const { data: byProject } = useAiCostByProject({ from: dates.from, to: dates.to });
  const { data: byUser } = useAiCostByUser(filters);

  const costOutcomes = useMemo(() => {
    if (!summary || !byFeature) return null;
    const prd = byFeature.find(f => f.feature === 'prd');
    const doc = byFeature.find(f => f.feature === 'design-doc');
    const proto = byFeature.find(f => f.feature === 'design-prototype');
    return { prd, doc, proto };
  }, [summary, byFeature]);

  if (showComparison && isSuperAdmin) {
    return <AiCostComparison onBack={() => setShowComparison(false)} />;
  }

  return (
    <>
    <div className={styles.aiCostPage}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerRow}>
          <h1 className={styles.pageTitle}>
            <div className={styles.pageTitleIcon}>$</div>
            AI Cost Analytics
          </h1>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {isSuperAdmin && (
              <button
                className={styles.refreshBtn}
                onClick={() => setShowComparison(true)}
                title="Compare AI costs across all projects (Super Admin only)"
              >
                ⇄ Project Comparison
              </button>
            )}

            {isSuperAdmin && (
              <button
                className={styles.refreshBtn}
                onClick={() => {
                  sync.mutate(undefined, {
                    onSuccess: () => setSyncMessage('Syncing… data will refresh in ~35s'),
                    onError: () => setSyncMessage('Sync failed'),
                  });
                  setTimeout(() => setSyncMessage(null), 40000);
                }}
                disabled={sync.isPending}
                title="Pull latest billing data from Cursor and AWS now"
              >
                {sync.isPending ? '↻ Syncing…' : '↻ Sync Now'}
              </button>
            )}

            {isSuperAdmin && byProject && (
              <div className={styles.projectSwitcher}>
                <span className={styles.projectLabel}>Project:</span>
                <select
                  className={styles.projectSelect}
                  value={activeProject}
                  onChange={(e) => setActiveProject(e.target.value)}
                >
                  <option value="all">All Projects</option>
                  {byProject.map((p) => (
                    <option key={p.project} value={p.project}>{p.project}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>
        <p className={styles.pageSubtitle}>
          Track AI model usage, costs, and insights for {activeProject === 'all' ? 'all projects' : activeProject}
        </p>
        {syncMessage && (
          <div style={{ fontSize: 12, color: 'var(--accent-color)', marginTop: 4 }}>{syncMessage}</div>
        )}
      </div>

      {/* Filter bar */}
      <div className={styles.filterBar}>
        <span className={styles.filterLabel}>Period</span>
        <div className={styles.filterPresets}>
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
      </div>

      {/* Executive Daily Brief — super admin only */}
      {isSuperAdmin && !briefDismissed && (
        <ExecutiveBriefBanner
          project={activeProject}
          onDismiss={() => setBriefDismissed(true)}
        />
      )}

      {/* KPI cards */}
      <div className={styles.kpiRow}>
        <KpiCard
          label="Total Spend"
          value={summaryLoading ? '…' : formatCost(summary?.totalCostUsd ?? 0)}
          sub={`${summary?.totalInteractions ?? 0} interactions`}
          delta={forecast?.trendPct}
          accent="default"
          onClick={() => setDrillDown({ type: 'total', label: 'Total AI Spend' })}
        />
        <KpiCard
          label="Projected EOM"
          value={forecast ? formatCost(forecast.projectedEndOfMonthUsd) : '…'}
          sub={`${forecast?.trendDirection ?? '—'} trend`}
          accent={forecast?.trendDirection === 'down' ? 'green' : forecast?.trendDirection === 'up' ? 'orange' : 'blue'}
        />
        <KpiCard
          label="Cursor SDK"
          value={summaryLoading ? '…' : formatCost(summary?.cursorCostUsd ?? 0)}
          sub="Agentic workflows"
          accent="blue"
          onClick={() => setDrillDown({ type: 'provider', provider: 'cursor', label: 'Cursor SDK' })}
        />
        <KpiCard
          label="AWS Bedrock"
          value={summaryLoading ? '…' : formatCost(summary?.bedrockCostUsd ?? 0)}
          sub="Direct generation"
          accent="orange"
          onClick={() => setDrillDown({ type: 'provider', provider: 'bedrock', label: 'AWS Bedrock' })}
        />
        {costOutcomes?.prd && (
          <KpiCard
            label="Cost / PRD"
            value={formatCost(costOutcomes.prd.avgCostUsd)}
            sub={`${costOutcomes.prd.interactions} PRDs`}
            accent="green"
            onClick={() => setDrillDown({ type: 'outcome', feature: 'prd', label: 'PRD Generation', metricLabel: `${costOutcomes.prd!.interactions} PRDs · avg ${formatCost(costOutcomes.prd!.avgCostUsd)} each` })}
          />
        )}
        {costOutcomes?.doc && (
          <KpiCard
            label="Cost / Design Doc"
            value={formatCost(costOutcomes.doc.avgCostUsd)}
            sub={`${costOutcomes.doc.interactions} docs`}
            accent="green"
            onClick={() => setDrillDown({ type: 'outcome', feature: 'design-doc', label: 'Design Docs', metricLabel: `${costOutcomes.doc!.interactions} docs · avg ${formatCost(costOutcomes.doc!.avgCostUsd)} each` })}
          />
        )}
        {costOutcomes?.proto && (
          <KpiCard
            label="Cost / Prototype"
            value={formatCost(costOutcomes.proto.avgCostUsd)}
            sub={`${costOutcomes.proto.interactions} prototypes`}
            accent="green"
            onClick={() => setDrillDown({ type: 'outcome', feature: 'design-prototype', label: 'Prototypes', metricLabel: `${costOutcomes.proto!.interactions} prototypes · avg ${formatCost(costOutcomes.proto!.avgCostUsd)} each` })}
          />
        )}
      </div>

      {/* Reconciliation strip */}
      {reconciliation && (
        <div className={styles.reconciliationStrip}>
          <span className={styles.reconciliationLabel}>Billing Reconciliation</span>
          <span className={styles.reconciliationSep} />
          <span>
            <span className={styles.reconciliationLabel}>Attributed: </span>
            <span className={styles.reconciliationValue}>{formatCost(reconciliation.attributedCursorCostUsd)}</span>
          </span>
          <span>
            <span className={styles.reconciliationLabel}>Billed: </span>
            <span className={styles.reconciliationValue}>{formatCost(reconciliation.billedCursorCents / 100)}</span>
          </span>
          <span>
            <span className={styles.reconciliationLabel}>Coverage: </span>
            <span className={styles.reconciliationValue}>{reconciliation.coveragePct.toFixed(1)}%</span>
          </span>
          <span className={styles.reconciliationSep} />
          <span className={styles.exactBadge}>Bedrock: Exact</span>
          <span className={styles.estimatedBadge}>Cursor: Allocated</span>
        </div>
      )}

      {/* Spend over time — full width now that AI Insights panel is removed */}
      <div className={styles.chartsGrid}>
        <div className={styles.chartCard}>
          <div className={styles.chartHeader}>
            <div>
              <p className={styles.chartTitle}>Spend over Time</p>
              <p className={styles.chartSubtitle}>Historical + 14-day forecast</p>
            </div>
            <span className={styles.chartBadge}>{preset}</span>
          </div>
          <SpendChart
            timeseries={timeseries ?? []}
            forecast={forecast}
            isLoading={tsLoading}
          />
        </div>
      </div>

      {/* Feature bars + Model donut */}
      <div className={styles.chartsGridTwo}>
        <div className={styles.chartCard}>
          <div className={styles.chartHeader}>
            <p className={styles.chartTitle}>Spend by Feature</p>
            <p className={styles.chartSubtitle} style={{ fontSize: 11, color: 'var(--text-muted)' }}>Click a bar to drill down</p>
          </div>
          <FeatureBarChart
            data={byFeature ?? []}
            isLoading={featureLoading}
            onFeatureClick={(f) => setDrillDown({ type: 'feature', feature: f, label: featureLabel(f) })}
          />
        </div>

        <div className={styles.chartCard}>
          <div className={styles.chartHeader}>
            <p className={styles.chartTitle}>Model Mix</p>
            <p className={styles.chartSubtitle}>Cost share by model</p>
          </div>
          <ModelDonut data={byModel ?? []} isLoading={modelLoading} />
        </div>
      </div>

      {/* Top Users — super admin only */}
      {isSuperAdmin && byUser && byUser.length > 0 && (
        <div className={styles.chartCard}>
          <div className={styles.chartHeader}>
            <div>
              <p className={styles.chartTitle}>Top Users by Spend</p>
              <p className={styles.chartSubtitle}>Click a row to drill down · Super admin only</p>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['User', 'Total Spend', 'Cursor SDK', 'AWS Bedrock', 'Interactions', 'Top Feature'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-secondary)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {byUser.map((u) => (
                  <tr
                    key={u.userId}
                    style={{ cursor: 'pointer', transition: 'background 0.1s' }}
                    onClick={() => setDrillDown({ type: 'total', label: u.displayName || u.email || u.userId })}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-secondary)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-color-light, var(--border-color))' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg, var(--accent-color), #8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 11, fontWeight: 600, flexShrink: 0 }}>
                          {(u.displayName || u.email || '?')[0].toUpperCase()}
                        </div>
                        <div>
                          <div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{u.displayName || u.userId}</div>
                          {u.email && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{u.email}</div>}
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px', fontWeight: 600, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color-light, var(--border-color))' }}>{formatCost(u.costUsd)}</td>
                    <td style={{ padding: '10px 12px', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color-light, var(--border-color))' }}>{formatCost(u.cursorCostUsd)}</td>
                    <td style={{ padding: '10px 12px', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color-light, var(--border-color))' }}>{formatCost(u.bedrockCostUsd)}</td>
                    <td style={{ padding: '10px 12px', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color-light, var(--border-color))' }}>{u.interactions}</td>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-color-light, var(--border-color))' }}>
                      {u.topFeature && (
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 20, background: `${getFeatureColor(u.topFeature)}18`, color: getFeatureColor(u.topFeature), fontWeight: 500 }}>
                          {featureLabel(u.topFeature)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Drill-down events */}
      <div className={styles.chartCard}>
        <div className={styles.chartHeader}>
          <div>
            <p className={styles.chartTitle}>Interaction Log</p>
            <p className={styles.chartSubtitle}>Every AI call with token & cost breakdown</p>
          </div>
        </div>
        <EventsTable filters={filters} />
      </div>
    </div>

    {/* Drill-down panel */}
    {drillDown && (
      <AiCostDrillDown
        dimension={drillDown}
        filters={filters}
        onClose={() => setDrillDown(null)}
      />
    )}
  </>
  );
};

export default AiCostAnalytics;
