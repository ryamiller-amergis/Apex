import React, { useEffect } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from 'recharts';
import styles from './AiCostDrillDown.module.css';
import { useAiCostEvents, useAiCostTimeseries, useAiCostByModel, type AiCostFilters } from '../hooks/useAiCostAnalytics';

// ── Types ─────────────────────────────────────────────────────────────────────

export type DrillDownDimension =
  | { type: 'total'; label: string }
  | { type: 'provider'; provider: 'cursor' | 'bedrock'; label: string }
  | { type: 'feature'; feature: string; label: string }
  | { type: 'model'; modelId: string; label: string }
  | { type: 'outcome'; feature: string; label: string; metricLabel: string };

const DIMENSION_COLORS: Record<string, string> = {
  total: '#6366f1',
  cursor: '#6366f1',
  bedrock: '#f59e0b',
  feature: '#8b5cf6',
  model: '#06b6d4',
  outcome: '#10b981',
};

const DIMENSION_ICONS: Record<string, string> = {
  total: '$',
  cursor: '⚡',
  bedrock: '☁',
  feature: '⬡',
  model: '◈',
  outcome: '◎',
};

// ── Formatters ─────────────────────────────────────────────────────────────────

function formatCost(usd: number): string {
  if (usd < 0.0001) return '$0.0000';
  if (usd < 1) return `$${usd.toFixed(4)}`;
  if (usd < 1000) return `$${usd.toFixed(2)}`;
  return `$${(usd / 1000).toFixed(2)}k`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function shortModel(modelId: string): string {
  return modelId
    .replace(/^us\.anthropic\./, '')
    .replace(/-\d{8}-v\d+:\d+$/, '')
    .replace(/-20\d{6}.*$/, '');
}

// ── Drill-down panel ───────────────────────────────────────────────────────────

interface AiCostDrillDownProps {
  dimension: DrillDownDimension;
  filters: AiCostFilters;
  onClose: () => void;
}

export const AiCostDrillDown: React.FC<AiCostDrillDownProps> = ({ dimension, filters, onClose }) => {
  const dimType = dimension.type;
  const iconKey = dimType === 'provider' && 'provider' in dimension ? dimension.provider : dimType;
  const color = DIMENSION_COLORS[iconKey] ?? '#6366f1';
  const icon = DIMENSION_ICONS[iconKey] ?? '$';

  // Build filters scoped to this dimension
  const scopedFilters: AiCostFilters = {
    ...filters,
    provider: dimType === 'provider' && 'provider' in dimension ? dimension.provider : filters.provider,
    feature: dimType === 'feature' && 'feature' in dimension ? dimension.feature
      : dimType === 'outcome' && 'feature' in dimension ? dimension.feature
      : filters.feature,
    model: dimType === 'model' && 'modelId' in dimension ? dimension.modelId : filters.model,
  };

  const { data: events, isLoading: eventsLoading } = useAiCostEvents(scopedFilters, 1, 30);
  const { data: timeseries, isLoading: tsLoading } = useAiCostTimeseries(scopedFilters);
  const { data: byModel } = useAiCostByModel(scopedFilters);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Derived stats from events
  const totalCost = events?.events.reduce((s, e) => s + e.costUsd, 0) ?? 0;
  const totalInput = events?.events.reduce((s, e) => s + e.inputTokens, 0) ?? 0;
  const totalOutput = events?.events.reduce((s, e) => s + e.outputTokens, 0) ?? 0;
  const totalCache = events?.events.reduce((s, e) => s + e.cacheReadTokens + e.cacheWriteTokens, 0) ?? 0;
  const totalTokens = totalInput + totalOutput + totalCache;
  const avgCost = (events?.total ?? 0) > 0 ? totalCost / (events?.total ?? 1) : 0;

  // Token breakdown bar proportions
  const inputPct = totalTokens > 0 ? (totalInput / totalTokens) * 100 : 33;
  const outputPct = totalTokens > 0 ? (totalOutput / totalTokens) * 100 : 33;
  const cachePct = totalTokens > 0 ? (totalCache / totalTokens) * 100 : 34;

  // Chart data
  const chartData = (timeseries ?? []).map((p) => ({
    date: new Date(p.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    cost: dimType === 'provider' && 'provider' in dimension
      ? dimension.provider === 'cursor' ? p.cursorCostUsd : p.bedrockCostUsd
      : p.totalCostUsd,
  }));

  const topModels = (byModel ?? []).slice(0, 5);

  return (
    <>
      <div className={styles.drillDownOverlay} onClick={onClose} />
      <div className={styles.drillDownPanel} role="dialog" aria-label={`${dimension.label} detail`}>

        {/* Header */}
        <div className={styles.panelHeader}>
          <div className={styles.panelTitleRow}>
            <div className={styles.panelIcon} style={{ background: `linear-gradient(135deg, ${color}, ${color}aa)` }}>
              {icon}
            </div>
            <div>
              <h2 className={styles.panelTitle}>{dimension.label}</h2>
              <p className={styles.panelSubtitle}>
                {'metricLabel' in dimension ? dimension.metricLabel : `Detailed breakdown · ${filters.project ?? 'all projects'}`}
              </p>
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">×</button>
        </div>

        {/* Body */}
        <div className={styles.panelBody}>

          {/* Hero stats */}
          <div className={styles.heroStrip}>
            <div className={styles.heroStat}>
              <div className={styles.heroStatBar} style={{ background: `linear-gradient(90deg, ${color}, ${color}66)` }} />
              <div className={styles.heroStatLabel}>Total Cost</div>
              <div className={styles.heroStatValue}>{formatCost(totalCost)}</div>
              <div className={styles.heroStatSub}>{events?.total ?? 0} interactions</div>
            </div>
            <div className={styles.heroStat}>
              <div className={styles.heroStatBar} style={{ background: 'linear-gradient(90deg, #f59e0b, #f59e0b66)' }} />
              <div className={styles.heroStatLabel}>Avg / Interaction</div>
              <div className={styles.heroStatValue}>{formatCost(avgCost)}</div>
              <div className={styles.heroStatSub}>per run</div>
            </div>
            <div className={styles.heroStat}>
              <div className={styles.heroStatBar} style={{ background: 'linear-gradient(90deg, #10b981, #10b98166)' }} />
              <div className={styles.heroStatLabel}>Total Tokens</div>
              <div className={styles.heroStatValue}>{formatTokens(totalInput + totalOutput)}</div>
              <div className={styles.heroStatSub}>{formatTokens(totalCache)} cached</div>
            </div>
          </div>

          {/* Spend trend */}
          <div className={styles.sectionCard}>
            <p className={styles.sectionTitle}><span className={styles.sectionIcon}>📈</span> Spend Trend</p>
            {tsLoading ? (
              <div><div className={styles.shimmer} style={{ width: '100%', height: 120 }} /></div>
            ) : chartData.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px', fontSize: 13, color: 'var(--text-muted)' }}>No data in this period</div>
            ) : (
              <ResponsiveContainer width="100%" height={130}>
                <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id={`dd-grad-${dimType}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={color} stopOpacity={0.4} />
                      <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis tickFormatter={(v) => formatCost(v)} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} />
                  <Tooltip formatter={(v) => [formatCost(Number(v) || 0), 'Cost']} />
                  <Area type="monotone" dataKey="cost" stroke={color} fill={`url(#dd-grad-${dimType})`} strokeWidth={2} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Token breakdown */}
          {(totalInput > 0 || totalOutput > 0) && (
            <div className={styles.sectionCard}>
              <p className={styles.sectionTitle}><span className={styles.sectionIcon}>🔢</span> Token Breakdown</p>
              <div className={styles.tokenBar}>
                <div className={styles.tokenBarIn} style={{ width: `${inputPct}%` }} />
                <div className={styles.tokenBarOut} style={{ width: `${outputPct}%` }} />
                <div className={styles.tokenBarCache} style={{ width: `${cachePct}%` }} />
              </div>
              <div className={styles.tokenLegend}>
                <div className={styles.tokenLegendItem}>
                  <div className={styles.tokenLegendDot} style={{ background: 'var(--accent-color)' }} />
                  Input: {formatTokens(totalInput)} ({inputPct.toFixed(0)}%)
                </div>
                <div className={styles.tokenLegendItem}>
                  <div className={styles.tokenLegendDot} style={{ background: '#f59e0b' }} />
                  Output: {formatTokens(totalOutput)} ({outputPct.toFixed(0)}%)
                </div>
                <div className={styles.tokenLegendItem}>
                  <div className={styles.tokenLegendDot} style={{ background: '#10b981' }} />
                  Cache: {formatTokens(totalCache)} ({cachePct.toFixed(0)}%)
                </div>
              </div>
            </div>
          )}

          {/* Model breakdown (if not already drilling into a model) */}
          {dimType !== 'model' && topModels.length > 0 && (
            <div className={styles.sectionCard}>
              <p className={styles.sectionTitle}><span className={styles.sectionIcon}>◈</span> Models Used</p>
              <ResponsiveContainer width="100%" height={Math.min(topModels.length * 32, 180)}>
                <BarChart data={topModels.map(m => ({ name: shortModel(m.modelId), cost: m.costUsd }))} layout="vertical" margin={{ top: 0, right: 40, left: 100, bottom: 0 }}>
                  <XAxis type="number" tickFormatter={(v) => formatCost(v)} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: 'var(--text-secondary)' }} tickLine={false} axisLine={false} width={96} />
                  <Tooltip formatter={(v) => [formatCost(Number(v) || 0), 'Cost']} />
                  <Bar dataKey="cost" radius={[0, 4, 4, 0]}>
                    {topModels.map((_, i) => (
                      <Cell key={i} fill={i === 0 ? color : `${color}88`} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Interaction log */}
          <div className={styles.sectionCard}>
            <p className={styles.sectionTitle}>
              <span className={styles.sectionIcon}>📋</span>
              Recent Interactions
              {events?.total ? <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>({events.total} total)</span> : null}
            </p>
            {eventsLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className={styles.shimmer} style={{ width: `${75 + (i % 3) * 10}%`, marginBottom: 8 }} />
              ))
            ) : !events?.events.length ? (
              <div style={{ textAlign: 'center', padding: '16px', fontSize: 13, color: 'var(--text-muted)' }}>No interactions yet</div>
            ) : (
              <div className={styles.interactionList}>
                {events.events.map((e) => (
                  <div key={e.id} className={styles.interactionRow}>
                    <span className={styles.interactionModel} title={e.modelId}>{shortModel(e.modelId)}</span>
                    <span className={styles.interactionCost}>{formatCost(e.costUsd)}</span>
                    <span className={styles.interactionTokens}>
                      {formatTokens(e.inputTokens)}↑ {formatTokens(e.outputTokens)}↓
                      {e.cacheReadTokens > 0 ? ` ${formatTokens(e.cacheReadTokens)}⚡` : ''}
                    </span>
                    <span className={`${styles.interactionBadge} ${e.costSource === 'computed' ? styles.exactBadge : styles.allocatedBadge}`}>
                      {e.costSource === 'computed' ? 'exact' : 'alloc'}
                    </span>
                    <span className={styles.interactionTime}>
                      {new Date(e.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </>
  );
};
