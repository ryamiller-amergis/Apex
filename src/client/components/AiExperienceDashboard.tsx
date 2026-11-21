import React, { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AI_EXPERIENCE_WINDOWS,
  AI_EXPERIENCE_WINDOW_LABELS,
  type AiExperienceGranularity,
  type AiExperienceModuleSummary,
  type AiExperienceWindow,
} from '../../shared/types/aiExperience';
import { useObservabilityAiExperience } from '../hooks/useObservabilityQueries';
import { ApexLoader } from './ApexLoader';
import styles from './AiExperienceDashboard.module.css';

interface AiExperienceDashboardProps {
  /** Active shell project used for feature-flag evaluation on the backend. */
  flagProject: string;
}

type LatencyPercentile = 'p50' | 'p90';

const SERIES_COLORS = {
  accent: 'var(--accent-color)',
  success: 'var(--success-color)',
  warning: 'var(--warning-color)',
  error: 'var(--error-color)',
  teal: '#0d9488',
  violet: '#7c3aed',
} as const;

const TOOLTIP_STYLE: React.CSSProperties = {
  backgroundColor: 'var(--bg-secondary)',
  border: '1px solid var(--border-color)',
  borderRadius: '8px',
  color: 'var(--text-primary)',
  fontSize: '12px',
};

function formatDurationSec(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '—';
  if (sec >= 90) return `${(sec / 60).toFixed(1)} min`;
  return `${sec.toFixed(1)}s`;
}

function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)} ms`;
}

function formatUsd(usd: number | null, digits = 2): string {
  if (usd === null || !Number.isFinite(usd)) return '—';
  return `$${usd.toFixed(digits)}`;
}

function formatPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  return `${pct.toFixed(1)}%`;
}

function formatDeltaLabel(deltaPct: number | null): { text: string; className: string } {
  if (deltaPct === null || !Number.isFinite(deltaPct)) {
    return { text: 'New / single period', className: `${styles.deltaBadge} ${styles.deltaNeutral}` };
  }
  const abs = Math.abs(deltaPct).toFixed(0);
  if (deltaPct <= -5) {
    return { text: `${abs}% faster`, className: `${styles.deltaBadge} ${styles.deltaGood}` };
  }
  if (deltaPct >= 5) {
    return { text: `${abs}% slower`, className: `${styles.deltaBadge} ${styles.deltaBad}` };
  }
  return { text: 'Steady', className: `${styles.deltaBadge} ${styles.deltaNeutral}` };
}

function formatReasonLabel(reason: string): string {
  return reason.replace(/_/g, ' ');
}

function formatTooltipSuffix(val: unknown, suffix: string): string {
  if (val === undefined || val === null) return '—';
  const num = typeof val === 'number' ? val : Number(val);
  if (Number.isFinite(num)) return `${num}${suffix}`;
  return `${String(val)}${suffix}`;
}

function formatTooltipMsValue(val: unknown): string {
  if (val === undefined || val === null) return '—';
  const num = typeof val === 'number' ? val : Number(val);
  return Number.isFinite(num) ? formatMs(num) : String(val);
}

export const AiExperienceDashboard: React.FC<AiExperienceDashboardProps> = ({ flagProject }) => {
  const [windowKey, setWindowKey] = useState<AiExperienceWindow>('120d');
  const [granularity, setGranularity] = useState<AiExperienceGranularity>('month');
  const [scopeProject, setScopeProject] = useState<string>('all');
  const [percentile, setPercentile] = useState<LatencyPercentile>('p50');

  const query = useObservabilityAiExperience(flagProject, scopeProject, windowKey, granularity);
  const data = query.data;

  const projectOptions = useMemo(() => {
    const set = new Set<string>(data?.availableProjects ?? []);
    if (scopeProject !== 'all') set.add(scopeProject);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [data?.availableProjects, scopeProject]);

  const hasAdrSeries = useMemo(
    () => (data?.conversationTrend ?? []).some((pt) => pt.adrP50Sec !== null),
    [data?.conversationTrend],
  );

  const hasBrainstormSeries = useMemo(
    () => (data?.conversationTrend ?? []).some((pt) => pt.brainstormP50Sec !== null),
    [data?.conversationTrend],
  );

  const hasPrototypeSeries = useMemo(
    () => (data?.generationTrend ?? []).some((pt) => pt.prototypeP50Min !== null),
    [data?.generationTrend],
  );

  const hasTestCaseSeries = useMemo(
    () => (data?.generationTrend ?? []).some((pt) => pt.testCaseP50Min !== null),
    [data?.generationTrend],
  );

  const handleWindowChange = (nextWindow: AiExperienceWindow) => {
    setWindowKey(nextWindow);
    setGranularity(nextWindow === '30d' ? 'week' : 'month');
  };

  if (query.isLoading && !data) {
    return (
      <div className={styles.container} {...{ 'data-testid': 'ai-experience-dashboard' }}>
        <div className={styles.stateBox} role="status">
          <ApexLoader size={36} />
          <p className={styles.lead}>Loading AI &amp; application experience metrics…</p>
        </div>
      </div>
    );
  }

  if (query.isError && !data) {
    return (
      <div className={styles.container} {...{ 'data-testid': 'ai-experience-dashboard' }}>
        <div className={styles.stateBox} role="alert">
          <p className={styles.errorTitle}>Unable to load AI Experience metrics</p>
          <p className={styles.errorMessage}>
            {query.error?.message ?? 'An unexpected error occurred.'}
          </p>
          <button
            type="button"
            className={styles.refreshBtn}
            onClick={() => void query.refetch()}
            {...{ 'data-testid': 'ai-experience-retry-btn' }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { headline, stageTimings, reliability, apiExperience, costAndQuality } = data;
  const warmthTotal =
    stageTimings.warmCount + stageTimings.resumedCount + stageTimings.recreatedCount;

  return (
    <div className={styles.container} {...{ 'data-testid': 'ai-experience-dashboard' }}>
      {/* Executive Hero & Filters */}
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>Platform Speed &amp; Quality</span>
          <h2 className={styles.heading}>AI &amp; Application Experience</h2>
          <p className={styles.lead}>
            End-to-end reply speed, document generation runtime, run reliability, API latency, and
            cost efficiency across Apex agents.
          </p>
        </div>

        <div className={styles.toolbar} {...{ 'data-testid': 'ai-experience-controls' }}>
          <div className={styles.controlGroup}>
            <label className={styles.controlLabel} htmlFor="ai-exp-project">
              Scope
            </label>
            <select
              id="ai-exp-project"
              className={styles.select}
              value={scopeProject}
              onChange={(e) => setScopeProject(e.target.value)}
              {...{ 'data-testid': 'ai-experience-project-select' }}
            >
              <option value="all">All projects</option>
              {projectOptions.map((proj) => (
                <option key={proj} value={proj}>
                  {proj}
                </option>
              ))}
            </select>
          </div>

          <div
            className={styles.segmented}
            role="group"
            aria-label="Time window"
            {...{ 'data-testid': 'ai-experience-window-group' }}
          >
            {AI_EXPERIENCE_WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={windowKey === w}
                className={
                  windowKey === w
                    ? `${styles.segmentBtn} ${styles.segmentBtnActive}`
                    : styles.segmentBtn
                }
                onClick={() => handleWindowChange(w)}
                {...{ 'data-testid': `ai-experience-window-${w}` }}
              >
                {w}
              </button>
            ))}
          </div>

          <div className={styles.segmented} role="group" aria-label="Trend granularity">
            {(['week', 'month'] as const).map((g) => (
              <button
                key={g}
                type="button"
                aria-pressed={granularity === g}
                className={
                  granularity === g
                    ? `${styles.segmentBtn} ${styles.segmentBtnActive}`
                    : styles.segmentBtn
                }
                onClick={() => setGranularity(g)}
                {...{ 'data-testid': `ai-experience-granularity-${g}` }}
              >
                {g === 'week' ? 'Weekly' : 'Monthly'}
              </button>
            ))}
          </div>

          <button
            type="button"
            className={styles.refreshBtn}
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
            {...{ 'data-testid': 'ai-experience-refresh' }}
          >
            {query.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {/* Executive KPI Strip */}
      <section className={styles.kpiStrip} {...{ 'data-testid': 'ai-experience-kpi-strip' }}>
        <article className={`${styles.kpiTile} ${styles.kpiTileHighlight}`}>
          <span className={styles.kpiLabel}>Chat Reply Median</span>
          <span className={styles.kpiValue}>
            {formatDurationSec(headline.conversationalMedianSec)}
          </span>
          <span className={styles.kpiSub}>
            {headline.conversationalTurns.toLocaleString()} turns · {AI_EXPERIENCE_WINDOW_LABELS[data.window]}
          </span>
        </article>

        <article className={styles.kpiTile}>
          <span className={styles.kpiLabel}>Doc Generation Median</span>
          <span className={styles.kpiValue}>
            {formatDurationSec(headline.generationMedianSec)}
          </span>
          <span className={styles.kpiSub}>
            {headline.generationRuns.toLocaleString()} completed runs
          </span>
        </article>

        <article className={styles.kpiTile}>
          <span className={styles.kpiLabel}>First-Token Median (TTFT)</span>
          <span
            className={
              headline.firstTokenMedianMs !== null
                ? `${styles.kpiValue} ${styles.kpiValueGood}`
                : styles.kpiValue
            }
          >
            {formatMs(headline.firstTokenMedianMs)}
          </span>
          <span className={styles.kpiSub}>
            {headline.firstTokenSamples > 0
              ? `${headline.firstTokenSamples.toLocaleString()} timed turns`
              : 'Live capture active'}
          </span>
        </article>

        <article className={styles.kpiTile}>
          <span className={styles.kpiLabel}>Agent Run Success</span>
          <span
            className={
              headline.successRatePct !== null && headline.successRatePct >= 95
                ? `${styles.kpiValue} ${styles.kpiValueGood}`
                : headline.successRatePct !== null && headline.successRatePct < 85
                  ? `${styles.kpiValue} ${styles.kpiValueBad}`
                  : styles.kpiValue
            }
          >
            {formatPct(headline.successRatePct)}
          </span>
          <span className={styles.kpiSub}>
            {headline.totalRuns.toLocaleString()} terminal runs
          </span>
        </article>

        <article className={styles.kpiTile}>
          <span className={styles.kpiLabel}>API Latency (p95)</span>
          <span className={styles.kpiValue}>{formatMs(headline.apiP95Ms)}</span>
          <span className={styles.kpiSub}>
            {headline.apiRequests.toLocaleString()} traced requests
          </span>
        </article>

        <article className={styles.kpiTile}>
          <span className={styles.kpiLabel}>Prompt Cache Hit Rate</span>
          <span className={styles.kpiValue}>{formatPct(headline.cacheHitPct)}</span>
          <span className={styles.kpiSub}>
            {formatUsd(headline.totalCostUsd)} total AI spend
          </span>
        </article>
      </section>

      {/* Primary Speed Trend Line Charts */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <h3 className={styles.sectionTitle}>Agent Response Speed Trends</h3>
            <p className={styles.sectionSubtitle}>
              Send-to-saved reply time for interactive chat agents and end-to-end runtime for
              document generation jobs.
            </p>
          </div>
          <div className={styles.segmented} role="group" aria-label="Latency percentile">
            <button
              type="button"
              aria-pressed={percentile === 'p50'}
              className={
                percentile === 'p50'
                  ? `${styles.segmentBtn} ${styles.segmentBtnActive}`
                  : styles.segmentBtn
              }
              onClick={() => setPercentile('p50')}
              {...{ 'data-testid': 'ai-experience-percentile-p50' }}
            >
              Median (p50)
            </button>
            <button
              type="button"
              aria-pressed={percentile === 'p90'}
              className={
                percentile === 'p90'
                  ? `${styles.segmentBtn} ${styles.segmentBtnActive}`
                  : styles.segmentBtn
              }
              onClick={() => setPercentile('p90')}
              {...{ 'data-testid': 'ai-experience-percentile-p90' }}
            >
              Slow tail (p90)
            </button>
          </div>
        </div>

        <div className={styles.twoCol}>
          <div className={styles.chartPanel} {...{ 'data-testid': 'ai-experience-conversation-chart' }}>
            <div className={styles.panelHeader}>
              <div>
                <h4 className={styles.panelTitle}>
                  Conversational Agents ({percentile === 'p50' ? 'Median' : 'p90'}, seconds)
                </h4>
                <p className={styles.panelHint}>
                  Lower is faster · measured from user message send to saved agent reply
                </p>
              </div>
            </div>
            {data.conversationTrend.length === 0 ? (
              <div className={styles.emptyChart}>No conversational turns in this window.</div>
            ) : (
              <div className={styles.chartWrap}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={data.conversationTrend}
                    margin={{ top: 8, right: 16, bottom: 4, left: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                    />
                    <YAxis
                      unit="s"
                      tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                    />
                    {/* data-testid-exempt — Recharts hover chrome */}
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      formatter={(val) => [formatTooltipSuffix(val, 's'), '']}
                    />
                    <Legend wrapperStyle={{ fontSize: '12px' }} />
                    <Line
                      type="monotone"
                      dataKey={percentile === 'p50' ? 'homeChatP50Sec' : 'homeChatP90Sec'}
                      name="Home Chat"
                      stroke={SERIES_COLORS.accent}
                      strokeWidth={2.5}
                      dot={{ r: 3 }}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey={percentile === 'p50' ? 'interviewP50Sec' : 'interviewP90Sec'}
                      name="Interview"
                      stroke={SERIES_COLORS.teal}
                      strokeWidth={2.5}
                      dot={{ r: 3 }}
                      connectNulls
                    />
                    {hasBrainstormSeries && (
                      <Line
                        type="monotone"
                        dataKey={percentile === 'p50' ? 'brainstormP50Sec' : 'brainstormP90Sec'}
                        name="Brainstorm"
                        stroke={SERIES_COLORS.success}
                        strokeWidth={2.5}
                        dot={{ r: 4 }}
                        connectNulls
                      />
                    )}
                    {hasAdrSeries && (
                      <Line
                        type="monotone"
                        dataKey={percentile === 'p50' ? 'adrP50Sec' : 'adrP90Sec'}
                        name="ADR"
                        stroke={SERIES_COLORS.warning}
                        strokeWidth={2}
                        strokeDasharray="4 4"
                        dot={{ r: 2.5 }}
                        connectNulls
                      />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className={styles.chartPanel} {...{ 'data-testid': 'ai-experience-generation-chart' }}>
            <div className={styles.panelHeader}>
              <div>
                <h4 className={styles.panelTitle}>
                  Document Generation ({percentile === 'p50' ? 'Median' : 'p90'}, minutes)
                </h4>
                <p className={styles.panelHint}>
                  End-to-end runtime of successful generation runs
                </p>
              </div>
            </div>
            {data.generationTrend.length === 0 ? (
              <div className={styles.emptyChart}>No timed document generation runs in this window.</div>
            ) : (
              <div className={styles.chartWrap}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={data.generationTrend}
                    margin={{ top: 8, right: 16, bottom: 4, left: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                    />
                    <YAxis
                      unit="m"
                      tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                    />
                    {/* data-testid-exempt — Recharts hover chrome */}
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      formatter={(val) => [formatTooltipSuffix(val, ' min'), '']}
                    />
                    <Legend wrapperStyle={{ fontSize: '12px' }} />
                    <Line
                      type="monotone"
                      dataKey={percentile === 'p50' ? 'designDocP50Min' : 'designDocP90Min'}
                      name="Design Doc"
                      stroke={SERIES_COLORS.success}
                      strokeWidth={2.5}
                      dot={{ r: 3.5 }}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey={percentile === 'p50' ? 'prdP50Min' : 'prdP90Min'}
                      name="PRD"
                      stroke={SERIES_COLORS.accent}
                      strokeWidth={2.5}
                      dot={{ r: 3.5 }}
                      connectNulls
                    />
                    {hasPrototypeSeries && percentile === 'p50' && (
                      <Line
                        type="monotone"
                        dataKey="prototypeP50Min"
                        name="Prototype"
                        stroke={SERIES_COLORS.violet}
                        strokeWidth={2}
                        dot={{ r: 2.5 }}
                        connectNulls
                      />
                    )}
                    {hasTestCaseSeries && percentile === 'p50' && (
                      <Line
                        type="monotone"
                        dataKey="testCaseP50Min"
                        name="Test Cases"
                        stroke={SERIES_COLORS.warning}
                        strokeWidth={2}
                        strokeDasharray="4 4"
                        dot={{ r: 2.5 }}
                        connectNulls
                      />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Module Scoreboard */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <h3 className={styles.sectionTitle}>Module Performance Scoreboard</h3>
            <p className={styles.sectionSubtitle}>
              Period change compares the first active {data.granularity} in the window against the
              most recent active {data.granularity}.
            </p>
          </div>
        </div>

        <div className={styles.tableShell} {...{ 'data-testid': 'ai-experience-module-table' }}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Module</th>
                <th>Type</th>
                <th className={styles.numCell}>Turns / Runs</th>
                <th className={styles.numCell}>Median (p50)</th>
                <th className={styles.numCell}>Average</th>
                <th className={styles.numCell}>p90</th>
                <th className={styles.numCell}>Trend</th>
                <th className={styles.numCell}>Success</th>
                <th className={styles.numCell}>Avg Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.modules.map((mod: AiExperienceModuleSummary) => {
                const delta = formatDeltaLabel(mod.deltaPct);
                return (
                  <tr key={mod.key}>
                    <td>
                      <strong>{mod.label}</strong>
                    </td>
                    <td>
                      <span className={styles.categoryTag}>
                        {mod.category === 'conversation' ? 'Chat' : 'Generation'}
                      </span>
                    </td>
                    <td className={styles.numCell}>{mod.turns.toLocaleString()}</td>
                    <td className={styles.numCell}>{formatDurationSec(mod.p50Sec)}</td>
                    <td className={styles.numCell}>{formatDurationSec(mod.avgSec)}</td>
                    <td className={styles.numCell}>{formatDurationSec(mod.p90Sec)}</td>
                    <td className={styles.numCell}>
                      <span className={delta.className}>{delta.text}</span>
                    </td>
                    <td className={styles.numCell}>{formatPct(mod.successRatePct)}</td>
                    <td className={styles.numCell}>
                      {mod.avgCostUsd !== null ? formatUsd(mod.avgCostUsd, 3) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Perceived Speed: True Time-to-First-Token & Stage Timings */}
      <section className={styles.section} {...{ 'data-testid': 'ai-experience-ttft-section' }}>
        <div className={styles.sectionHeader}>
          <div>
            <h3 className={styles.sectionTitle}>Perceived Speed: First-Token &amp; Stage Timings</h3>
            <p className={styles.sectionSubtitle}>
              Measures how fast users see the first streamed token versus full turn completion,
              plus session warmth (warm vs. resumed vs. recreated).
            </p>
          </div>
          {warmthTotal > 0 && (
            <div className={styles.pillRow}>
              <span className={styles.statChip}>
                Warm {Math.round((stageTimings.warmCount / warmthTotal) * 100)}%
                <span className={styles.statChipMuted}>({stageTimings.warmCount})</span>
              </span>
              <span className={styles.statChip}>
                Resumed {Math.round((stageTimings.resumedCount / warmthTotal) * 100)}%
                <span className={styles.statChipMuted}>({stageTimings.resumedCount})</span>
              </span>
              <span className={styles.statChip}>
                Recreated {Math.round((stageTimings.recreatedCount / warmthTotal) * 100)}%
                <span className={styles.statChipMuted}>({stageTimings.recreatedCount})</span>
              </span>
            </div>
          )}
        </div>

        {stageTimings.sampleCount === 0 ? (
          <div className={styles.noticeBanner}>
            <span className={styles.noticeTitle}>
              Durable first-token &amp; stage timing persistence is active
            </span>
            <p className={styles.noticeBody}>
              No interactive turns have been recorded in <code>ai_turn_stage_timings</code> for
              this window yet. As interactive turns complete, this section will automatically chart
              time-to-first-token (TTFT), workspace prep, agent acquire time, and warm vs. cold
              session rates by chat area.
            </p>
          </div>
        ) : (
          <>
            <div className={styles.stageBarGrid}>
              <div className={styles.stageCard}>
                <span className={styles.stageName}>Workspace Prep (p50)</span>
                <span className={styles.stageMetric}>{formatMs(stageTimings.workspaceP50Ms)}</span>
              </div>
              <div className={styles.stageCard}>
                <span className={styles.stageName}>Agent Acquire (p50)</span>
                <span className={styles.stageMetric}>{formatMs(stageTimings.acquireP50Ms)}</span>
              </div>
              <div className={styles.stageCard}>
                <span className={styles.stageName}>First Progress Event (p50)</span>
                <span className={styles.stageMetric}>{formatMs(stageTimings.firstEventP50Ms)}</span>
              </div>
              <div className={styles.stageCard}>
                <span className={styles.stageName}>First Token — TTFT (p50 / p90)</span>
                <span className={styles.stageMetric}>
                  {formatMs(stageTimings.ttftP50Ms)} / {formatMs(stageTimings.ttftP90Ms)}
                </span>
              </div>
              <div className={styles.stageCard}>
                <span className={styles.stageName}>Full Worker Turn (p50)</span>
                <span className={styles.stageMetric}>{formatMs(stageTimings.workerTurnP50Ms)}</span>
              </div>
            </div>

            <div className={styles.twoCol}>
              <div className={styles.chartPanel}>
                <div className={styles.panelHeader}>
                  <div>
                    <h4 className={styles.panelTitle}>First-Token vs. Full Turn Trend (ms)</h4>
                    <p className={styles.panelHint}>
                      Gap between lines shows how much streaming hides total turn time
                    </p>
                  </div>
                </div>
                <div className={styles.chartWrap}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={stageTimings.trend}
                      margin={{ top: 8, right: 16, bottom: 4, left: 4 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                      <YAxis unit="ms" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                      {/* data-testid-exempt — Recharts hover chrome */}
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE}
                        formatter={(val) => [formatTooltipMsValue(val), '']}
                      />
                      <Legend wrapperStyle={{ fontSize: '12px' }} />
                      <Line
                        type="monotone"
                        dataKey="ttftP50Ms"
                        name="First Token (p50)"
                        stroke={SERIES_COLORS.success}
                        strokeWidth={2.5}
                        dot={{ r: 3 }}
                        connectNulls
                      />
                      <Line
                        type="monotone"
                        dataKey="firstEventP50Ms"
                        name="First Feedback (p50)"
                        stroke={SERIES_COLORS.accent}
                        strokeWidth={2}
                        dot={{ r: 2.5 }}
                        connectNulls
                      />
                      <Line
                        type="monotone"
                        dataKey="workerTurnP50Ms"
                        name="Full Worker Turn (p50)"
                        stroke={SERIES_COLORS.warning}
                        strokeWidth={2}
                        strokeDasharray="4 4"
                        dot={{ r: 2.5 }}
                        connectNulls
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className={styles.tableShell}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Chat Area</th>
                      <th className={styles.numCell}>Samples</th>
                      <th className={styles.numCell}>TTFT p50</th>
                      <th className={styles.numCell}>TTFT p90</th>
                      <th className={styles.numCell}>Full Turn p50</th>
                      <th className={styles.numCell}>Warm %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stageTimings.byArea.map((row) => (
                      <tr key={row.area}>
                        <td>
                          <strong>{row.label}</strong>
                        </td>
                        <td className={styles.numCell}>{row.samples.toLocaleString()}</td>
                        <td className={styles.numCell}>{formatMs(row.ttftP50Ms)}</td>
                        <td className={styles.numCell}>{formatMs(row.ttftP90Ms)}</td>
                        <td className={styles.numCell}>{formatMs(row.workerTurnP50Ms)}</td>
                        <td className={styles.numCell}>{formatPct(row.warmPct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </section>

      {/* Home Chat Breakdown + Run Reliability & Queue Wait */}
      <section className={styles.section}>
        <div className={styles.twoCol}>
          <div className={styles.chartPanel} {...{ 'data-testid': 'ai-experience-home-split-chart' }}>
            <div className={styles.panelHeader}>
              <div>
                <h4 className={styles.panelTitle}>Home Chat Speed by Skill Type (Median, s)</h4>
                <p className={styles.panelHint}>
                  Separates App Knowledge lookups from other home skills and free chat
                </p>
              </div>
            </div>
            {data.homeChatSplit.length === 0 ? (
              <div className={styles.emptyChart}>No Home Chat turns in this window.</div>
            ) : (
              <div className={styles.chartWrap}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={data.homeChatSplit}
                    margin={{ top: 8, right: 16, bottom: 4, left: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                    <YAxis unit="s" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                    {/* data-testid-exempt — Recharts hover chrome */}
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      formatter={(val) => [formatTooltipSuffix(val, 's'), '']}
                    />
                    <Legend wrapperStyle={{ fontSize: '12px' }} />
                    <Line
                      type="monotone"
                      dataKey="appKnowledgeP50Sec"
                      name="App Knowledge"
                      stroke={SERIES_COLORS.warning}
                      strokeWidth={2.5}
                      dot={{ r: 3 }}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey="otherSkillP50Sec"
                      name="Other Home Skills"
                      stroke={SERIES_COLORS.accent}
                      strokeWidth={2.5}
                      dot={{ r: 3 }}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey="freeChatP50Sec"
                      name="Free Chat"
                      stroke={SERIES_COLORS.success}
                      strokeWidth={2}
                      strokeDasharray="4 4"
                      dot={{ r: 2.5 }}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className={styles.chartPanel} {...{ 'data-testid': 'ai-experience-reliability-chart' }}>
            <div className={styles.panelHeader}>
              <div>
                <h4 className={styles.panelTitle}>Run Reliability &amp; Queue Wait</h4>
                <p className={styles.panelHint}>
                  Queue wait p50: {formatDurationSec(reliability.queueWaitP50Sec)} · p90:{' '}
                  {formatDurationSec(reliability.queueWaitP90Sec)}
                </p>
              </div>
            </div>
            {reliability.trend.length === 0 ? (
              <div className={styles.emptyChart}>No terminal agent runs in this window.</div>
            ) : (
              <div className={styles.chartWrap}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={reliability.trend}
                    margin={{ top: 8, right: 16, bottom: 4, left: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                    <YAxis
                      yAxisId="pct"
                      domain={[0, 100]}
                      unit="%"
                      tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                    />
                    <YAxis
                      yAxisId="sec"
                      orientation="right"
                      unit="s"
                      tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                    />
                    {/* data-testid-exempt — Recharts hover chrome */}
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: '12px' }} />
                    <Line
                      yAxisId="pct"
                      type="monotone"
                      dataKey="successRatePct"
                      name="Success Rate (%)"
                      stroke={SERIES_COLORS.success}
                      strokeWidth={2.5}
                      dot={{ r: 3 }}
                      connectNulls
                    />
                    <Line
                      yAxisId="sec"
                      type="monotone"
                      dataKey="queueWaitP50Sec"
                      name="Queue Wait p50 (s)"
                      stroke={SERIES_COLORS.accent}
                      strokeWidth={2}
                      dot={{ r: 2.5 }}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
            {reliability.terminalReasons.length > 0 && (
              <div className={styles.pillRow}>
                <span className={styles.controlLabel}>Top failure reasons:</span>
                {reliability.terminalReasons.map((item) => (
                  <span key={item.reason} className={styles.statChip}>
                    {formatReasonLabel(item.reason)}
                    <span className={styles.statChipMuted}>{item.count}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* App & API Responsiveness */}
      <section className={styles.section} {...{ 'data-testid': 'ai-experience-api-section' }}>
        <div className={styles.sectionHeader}>
          <div>
            <h3 className={styles.sectionTitle}>Application &amp; API Responsiveness</h3>
            <p className={styles.sectionSubtitle}>
              API request latency and 5xx error rates from platform trace telemetry (
              {apiExperience.totalRequests.toLocaleString()} requests ·{' '}
              {apiExperience.clientErrors.toLocaleString()} tracked errors).
            </p>
          </div>
        </div>

        <div className={styles.twoCol}>
          <div className={styles.chartPanel}>
            <div className={styles.panelHeader}>
              <div>
                <h4 className={styles.panelTitle}>API Latency Trend (p50 &amp; p95, ms)</h4>
                <p className={styles.panelHint}>
                  Overall p50: {formatMs(apiExperience.p50Ms)} · p95:{' '}
                  {formatMs(apiExperience.p95Ms)} · 5xx rate:{' '}
                  {formatPct(apiExperience.errorRatePct)}
                </p>
              </div>
            </div>
            {apiExperience.trend.length === 0 ? (
              <div className={styles.emptyChart}>No traced API requests in this window.</div>
            ) : (
              <div className={styles.chartWrap}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={apiExperience.trend}
                    margin={{ top: 8, right: 16, bottom: 4, left: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                    <YAxis unit="ms" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                    {/* data-testid-exempt — Recharts hover chrome */}
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      formatter={(val) => [formatTooltipMsValue(val), '']}
                    />
                    <Legend wrapperStyle={{ fontSize: '12px' }} />
                    <Line
                      type="monotone"
                      dataKey="p50Ms"
                      name="API Median (p50)"
                      stroke={SERIES_COLORS.accent}
                      strokeWidth={2.5}
                      dot={{ r: 3 }}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey="p95Ms"
                      name="API Slow Tail (p95)"
                      stroke={SERIES_COLORS.warning}
                      strokeWidth={2.5}
                      dot={{ r: 3 }}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className={styles.tableShell}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Slowest API Routes (≥5 calls)</th>
                  <th className={styles.numCell}>Calls</th>
                  <th className={styles.numCell}>p50</th>
                  <th className={styles.numCell}>p95</th>
                  <th className={styles.numCell}>5xx %</th>
                </tr>
              </thead>
              <tbody>
                {apiExperience.slowestRoutes.length === 0 ? (
                  <tr>
                    <td colSpan={5} className={styles.chartCaption}>
                      No traced routes with at least 5 requests in this window.
                    </td>
                  </tr>
                ) : (
                  apiExperience.slowestRoutes.map((route) => (
                    <tr key={route.routeTemplate}>
                      <td className={styles.monoCell}>{route.routeTemplate}</td>
                      <td className={styles.numCell}>{route.requests.toLocaleString()}</td>
                      <td className={styles.numCell}>{formatMs(route.p50Ms)}</td>
                      <td className={styles.numCell}>{formatMs(route.p95Ms)}</td>
                      <td className={styles.numCell}>{formatPct(route.errorRatePct)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Cost, Prompt Cache & User Quality */}
      <section className={styles.section} {...{ 'data-testid': 'ai-experience-cost-section' }}>
        <div className={styles.sectionHeader}>
          <div>
            <h3 className={styles.sectionTitle}>Cost Efficiency, Cache &amp; User Sentiment</h3>
            <p className={styles.sectionSubtitle}>
              Balances speed improvements against model spend, prompt cache reuse, and direct user
              feedback.
            </p>
          </div>
        </div>

        <div className={styles.twoCol}>
          <div className={styles.chartPanel}>
            <div className={styles.panelHeader}>
              <div>
                <h4 className={styles.panelTitle}>Prompt Cache Hit Rate &amp; Avg Cost per Run</h4>
                <p className={styles.panelHint}>
                  Higher cache reuse lowers both latency and token cost
                </p>
              </div>
            </div>
            {costAndQuality.trend.length === 0 ? (
              <div className={styles.emptyChart}>No AI usage events in this window.</div>
            ) : (
              <div className={styles.chartWrap}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={costAndQuality.trend}
                    margin={{ top: 8, right: 16, bottom: 4, left: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                    <YAxis
                      yAxisId="pct"
                      domain={[0, 100]}
                      unit="%"
                      tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                    />
                    <YAxis
                      yAxisId="usd"
                      orientation="right"
                      unit="$"
                      tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                    />
                    {/* data-testid-exempt — Recharts hover chrome */}
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: '12px' }} />
                    <Line
                      yAxisId="pct"
                      type="monotone"
                      dataKey="cacheHitPct"
                      name="Cache Hit (%)"
                      stroke={SERIES_COLORS.success}
                      strokeWidth={2.5}
                      dot={{ r: 3 }}
                      connectNulls
                    />
                    <Line
                      yAxisId="usd"
                      type="monotone"
                      dataKey="avgCostPerRunUsd"
                      name="Avg Cost / Run ($)"
                      stroke={SERIES_COLORS.accent}
                      strokeWidth={2}
                      dot={{ r: 2.5 }}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className={styles.tableShell}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Model</th>
                  <th className={styles.numCell}>Runs</th>
                  <th className={styles.numCell}>Median</th>
                  <th className={styles.numCell}>Cache Hit</th>
                  <th className={styles.numCell}>Avg Cost</th>
                  <th className={styles.numCell}>Spend</th>
                </tr>
              </thead>
              <tbody>
                {costAndQuality.byModel.length === 0 ? (
                  <tr>
                    <td colSpan={6} className={styles.chartCaption}>
                      No model usage recorded in this window.
                    </td>
                  </tr>
                ) : (
                  costAndQuality.byModel.map((row) => (
                    <tr key={row.modelId}>
                      <td className={styles.monoCell}>{row.modelId}</td>
                      <td className={styles.numCell}>{row.runs.toLocaleString()}</td>
                      <td className={styles.numCell}>{formatDurationSec(row.p50Sec)}</td>
                      <td className={styles.numCell}>{formatPct(row.cacheHitPct)}</td>
                      <td className={styles.numCell}>{formatUsd(row.avgCostUsd, 3)}</td>
                      <td className={styles.numCell}>{formatUsd(row.totalCostUsd)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className={styles.sentimentGrid}>
          <article className={styles.sentimentCard}>
            <span className={styles.kpiLabel}>User Output Ratings</span>
            <span className={styles.kpiValue}>
              {formatPct(costAndQuality.ratings.positiveRatePct)}
            </span>
            <div className={styles.pillRow}>
              <span className={styles.statChip}>Good {costAndQuality.ratings.good}</span>
              <span className={styles.statChip}>
                Needs work {costAndQuality.ratings.needsImprovement}
              </span>
              <span className={styles.statChip}>Bad {costAndQuality.ratings.bad}</span>
            </div>
          </article>

          <article className={styles.sentimentCard}>
            <span className={styles.kpiLabel}>Flagged Chat Threads</span>
            <span className={styles.kpiValue}>
              {costAndQuality.flaggedThreads.flagged.toLocaleString()}
            </span>
            <span className={styles.kpiSub}>
              {formatPct(costAndQuality.flaggedThreads.ratePct)} of{' '}
              {costAndQuality.flaggedThreads.total.toLocaleString()} threads in window
            </span>
          </article>
        </div>
      </section>
    </div>
  );
};
