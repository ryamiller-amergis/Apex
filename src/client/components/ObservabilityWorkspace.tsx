import React, { useCallback, useMemo, useState } from 'react';
import { EFFORT_LEVELS, type EffortLevel } from '../../shared/types/effort';
import {
  OBSERVABILITY_PO_DEFAULT_EFFORT,
  OBSERVABILITY_PO_SKILL_PATH,
  OBSERVABILITY_TREND_WINDOWS,
  OBSERVABILITY_TREND_WINDOW_LABELS,
  type ObservabilityAdoptionSummary,
  type ObservabilityDropReasonsSummary,
  type ObservabilityExceptionItem,
  type ObservabilityModuleRetentionDropItem,
  type ObservabilityScheduleSummary,
  type ObservabilityTopModuleItem,
  type ObservabilityTopUserItem,
  type ObservabilityTrendWindow,
  type ObservabilityWindowComparisonMap,
} from '../../shared/types/observability';
import { effortLabel } from '../../shared/utils/effort';
import { buildFallbackPoDigestResponse } from '../../shared/utils/observabilityPoDigest';
import { DEFAULT_MODEL_ID, PLATFORM_MODEL_OPTIONS } from '../config/models';
import { useAppShell } from '../hooks/useAppShell';
import {
  useGenerateObservabilityPoDigest,
  useObservabilityPoDigest,
} from '../hooks/useObservabilityQueries';
import { useAvailableModels } from '../hooks/useProjectSkillConfig';
import styles from './ObservabilityWorkspace.module.css';

function formatDelta(deltaPct: number, invertGood = false): { text: string; positive: boolean } {
  const sign = deltaPct > 0 ? '+' : '';
  const text = `${sign}${deltaPct.toFixed(1)}%`;
  const positive = invertGood ? deltaPct <= 0 : deltaPct >= 0;
  return { text, positive };
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'Pending first run';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function severityBadgeClass(severity: ObservabilityExceptionItem['severity']): string {
  if (severity === 'critical' || severity === 'high') {
    return `${styles.badge} ${styles.badgeError}`;
  }
  if (severity === 'medium') {
    return `${styles.badge} ${styles.badgeUi}`;
  }
  return `${styles.badge} ${styles.badgeAgent}`;
}

function impactBadgeClass(impact: 'high' | 'medium' | 'low'): string {
  if (impact === 'high') return `${styles.badge} ${styles.badgeApi}`;
  if (impact === 'medium') return `${styles.badge} ${styles.badgeUi}`;
  return `${styles.badge} ${styles.badgeAgent}`;
}

interface WindowComparisonStripProps {
  values: ObservabilityWindowComparisonMap;
  activeWindow: ObservabilityTrendWindow;
  suffix?: string;
}

const WindowComparisonStrip: React.FC<WindowComparisonStripProps> = ({
  values,
  activeWindow,
  suffix = '',
}) => (
  <div className={styles.poWindowCompareStrip} aria-label="Multi-window trend comparison">
    {OBSERVABILITY_TREND_WINDOWS.map((w) => (
      <span
        key={w}
        className={w === activeWindow ? styles.poWindowMiniChipActive : styles.poWindowMiniChip}
      >
        {w}: {values[w].toLocaleString()}
        {suffix}
      </span>
    ))}
  </div>
);

interface ObservabilityWorkspaceProps {
  project?: string;
}

export const ObservabilityWorkspace: React.FC<ObservabilityWorkspaceProps> = ({ project }) => {
  const [selectedWindow, setSelectedWindow] = useState<ObservabilityTrendWindow>('7d');
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL_ID);
  const [selectedEffort, setSelectedEffort] = useState<EffortLevel>(OBSERVABILITY_PO_DEFAULT_EFFORT);

  const { selectedProject } = useAppShell();
  const resolvedProject = project ?? selectedProject ?? 'Apex';

  const modelsQuery = useAvailableModels();
  const digestQuery = useObservabilityPoDigest(
    resolvedProject,
    selectedWindow,
    selectedModel,
    selectedEffort,
  );
  const generateMutation = useGenerateObservabilityPoDigest(resolvedProject);

  const modelOptions = useMemo(() => {
    const merged = new Map<string, string>();
    for (const preset of PLATFORM_MODEL_OPTIONS) {
      merged.set(preset.id, preset.displayName);
    }
    for (const remote of modelsQuery.data ?? []) {
      if (remote.id && !merged.has(remote.id)) {
        merged.set(remote.id, remote.displayName || remote.id);
      }
    }
    if (!merged.has(selectedModel)) {
      merged.set(selectedModel, selectedModel);
    }
    return Array.from(merged.entries()).map(([id, displayName]) => ({ id, displayName }));
  }, [modelsQuery.data, selectedModel]);

  const selectedModelDisplayName = useMemo(() => {
    return (
      modelOptions.find((opt) => opt.id === selectedModel)?.displayName ?? selectedModel
    );
  }, [modelOptions, selectedModel]);

  const fallbackPayload = useMemo(
    () =>
      buildFallbackPoDigestResponse({
        project: resolvedProject,
        window: selectedWindow,
        model: selectedModel,
        effort: selectedEffort,
      }),
    [resolvedProject, selectedEffort, selectedModel, selectedWindow],
  );

  const activePayload = digestQuery.data ?? (digestQuery.isError ? null : fallbackPayload);
  const digest = activePayload?.digest ?? null;
  const schedule: ObservabilityScheduleSummary =
    activePayload?.schedule ?? fallbackPayload.schedule;
  const history = activePayload?.history ?? fallbackPayload.history;

  const handleGenerateNow = useCallback(() => {
    generateMutation.mutate({
      project: resolvedProject,
      window: selectedWindow,
      model: selectedModel,
      effort: selectedEffort,
      slot: 'on_demand',
    });
  }, [generateMutation, resolvedProject, selectedEffort, selectedModel, selectedWindow]);

  const maxUserInteractions = useMemo(() => {
    if (!digest || digest.topUsers.length === 0) return 1;
    return Math.max(1, ...digest.topUsers.map((u) => u.interactions));
  }, [digest]);

  return (
    <section className={styles.workspace} {...{ 'data-testid': 'observability-workspace' }}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <div>
            <h2 className={styles.title}>Product Owner Observability</h2>
            <p className={styles.subtitle}>
              Skill-driven adoption, retention, and exception digest ({OBSERVABILITY_PO_SKILL_PATH}) ·
              Automated daily at 6:00 AM &amp; 6:00 PM
            </p>
          </div>
          <div
            className={
              digestQuery.isError ? `${styles.status} ${styles.statusDegraded}` : styles.status
            }
            {...{ 'data-testid': 'observability-schedule-status-badge' }}
          >
            <span
              className={
                digestQuery.isError
                  ? `${styles.statusDot} ${styles.statusDotError}`
                  : styles.statusDot
              }
            />
            <span>
              {digestQuery.isError
                ? 'Digest service degraded'
                : '6:00 AM & 6:00 PM Daily Digest Active'}
            </span>
          </div>
        </div>
      </div>

      <div className={styles.poSection}>
        {/* Controls: Multi-window trend selector + AI Model & Effort selector + On-demand trigger */}
        <div className={styles.poControlBar} {...{ 'data-testid': 'observability-po-controls' }}>
          <div className={styles.poWindowGroup}>
            <span className={styles.filterLabel}>Trend Window</span>
            <div
              className={styles.poWindowPills}
              role="group"
              aria-label="Observability trend window"
              {...{ 'data-testid': 'observability-trend-window-group' }}
            >
              {OBSERVABILITY_TREND_WINDOWS.map((windowKey) => {
                const active = selectedWindow === windowKey;
                return (
                  <button
                    key={windowKey}
                    type="button"
                    aria-pressed={active}
                    className={active ? `${styles.chip} ${styles.chipActive}` : styles.chip}
                    onClick={() => setSelectedWindow(windowKey)}
                    {...{ 'data-testid': `observability-window-${windowKey}` }}
                  >
                    {OBSERVABILITY_TREND_WINDOW_LABELS[windowKey]}
                  </button>
                );
              })}
            </div>
          </div>

          <div className={styles.poAiControls}>
            <div className={styles.filterGroup}>
              <label className={styles.filterLabel} htmlFor="observability-model-select">
                AI Model
              </label>
              <select
                id="observability-model-select"
                className={styles.filterInput}
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                {...{ 'data-testid': 'observability-model-select' }}
              >
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.filterGroup}>
              <label className={styles.filterLabel} htmlFor="observability-effort-select">
                Thinking / Effort Level
              </label>
              <select
                id="observability-effort-select"
                className={styles.filterInput}
                value={selectedEffort}
                onChange={(e) => setSelectedEffort(e.target.value as EffortLevel)}
                {...{ 'data-testid': 'observability-effort-select' }}
              >
                {EFFORT_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {effortLabel(level)}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              className={styles.primaryButton}
              disabled={generateMutation.isPending}
              onClick={handleGenerateNow}
              {...{ 'data-testid': 'observability-generate-digest' }}
            >
              {generateMutation.isPending ? 'Synthesizing Digest…' : 'Generate Digest Now'}
            </button>
          </div>
        </div>

        {/* Scheduled Twice-Daily Digest Strip (6:00 AM & 6:00 PM) */}
        <div
          className={styles.poScheduleStrip}
          {...{ 'data-testid': 'observability-schedule-strip' }}
        >
          <article
            className={styles.poScheduleCard}
            {...{ 'data-testid': 'observability-schedule-6am' }}
          >
            <div className={styles.poScheduleTitle}>
              <span>Morning Scheduled Digest</span>
              <span className={`${styles.badge} ${styles.badgeApi}`}>6:00 AM Daily</span>
            </div>
            <div className={styles.poScheduleMain}>{schedule.morningSlot.label}</div>
            <div className={styles.poScheduleSub}>
              Last run: {formatTimestamp(schedule.morningSlot.lastRunAt)} · Next:{' '}
              {formatTimestamp(schedule.morningSlot.nextRunAt)}
            </div>
          </article>

          <article
            className={styles.poScheduleCard}
            {...{ 'data-testid': 'observability-schedule-6pm' }}
          >
            <div className={styles.poScheduleTitle}>
              <span>Evening Scheduled Digest</span>
              <span className={`${styles.badge} ${styles.badgeApi}`}>6:00 PM Daily</span>
            </div>
            <div className={styles.poScheduleMain}>{schedule.eveningSlot.label}</div>
            <div className={styles.poScheduleSub}>
              Last run: {formatTimestamp(schedule.eveningSlot.lastRunAt)} · Next:{' '}
              {formatTimestamp(schedule.eveningSlot.nextRunAt)}
            </div>
          </article>

          <article
            className={styles.poScheduleCard}
            {...{ 'data-testid': 'observability-schedule-history' }}
          >
            <div className={styles.poScheduleTitle}>
              <span>Skill &amp; Snapshot Provenance</span>
              <span className={`${styles.badge} ${styles.badgeUi}`}>
                {history.length} snapshots
              </span>
            </div>
            <div className={styles.poScheduleMain}>
              {selectedModelDisplayName} ({selectedModel}) · {effortLabel(selectedEffort)} effort
            </div>
            <div className={styles.poScheduleSub}>
              Skill: <code>{schedule.skillPath}</code>
            </div>
          </article>
        </div>

        {digestQuery.isError && (
          <div
            className={styles.errorBanner}
            role="alert"
            {...{ 'data-testid': 'observability-po-error' }}
          >
            <div>
              <p className={styles.errorTitle}>Unable to load Product Owner Observability Digest</p>
              <p className={styles.errorDetail}>
                {digestQuery.error?.message ?? 'Observability digest service is unavailable.'}
              </p>
              <button
                type="button"
                className={styles.retryButton}
                onClick={() => {
                  void digestQuery.refetch();
                }}
                {...{ 'data-testid': 'observability-po-retry' }}
              >
                Retry Digest
              </button>
            </div>
          </div>
        )}

        {digest && (
          <>
            {/* Executive Headline & Model Provenance */}
            <div
              className={styles.poHeadlineBanner}
              {...{ 'data-testid': 'observability-digest-headline' }}
            >
              <p className={styles.poHeadlineText}>{digest.headline}</p>
              <span
                className={styles.poProvenanceBadge}
                {...{ 'data-testid': 'observability-active-model-badge' }}
              >
                {selectedModelDisplayName} ({digest.model}) · {effortLabel(digest.effort)} ·{' '}
                {digest.windowLabel}
              </span>
            </div>

            {/* Executive KPI Cards */}
            <div className={styles.poKpiRow} {...{ 'data-testid': 'observability-kpi-row' }}>
              <article className={styles.card}>
                <div className={styles.cardLabel}>Active Users ({digest.windowLabel})</div>
                <div className={styles.cardValue}>{digest.kpis.activeUsers.toLocaleString()}</div>
                <div className={styles.cardSub}>
                  <span className={styles.poDeltaPositive}>
                    +{digest.kpis.activeUsersDeltaPct}%
                  </span>{' '}
                  {digest.baselineLabel}
                </div>
              </article>

              <article className={styles.card}>
                <div className={styles.cardLabel}>Exceptions ({digest.windowLabel})</div>
                <div className={styles.cardValue}>
                  {digest.kpis.totalExceptions.toLocaleString()}
                </div>
                <div className={styles.cardSub}>
                  <span
                    className={
                      digest.kpis.exceptionsDeltaPct <= 0
                        ? styles.poDeltaPositive
                        : styles.poDeltaNegative
                    }
                  >
                    {digest.kpis.exceptionsDeltaPct > 0 ? '+' : ''}
                    {digest.kpis.exceptionsDeltaPct}%
                  </span>{' '}
                  {digest.baselineLabel}
                </div>
              </article>

              <article className={styles.card}>
                <div className={styles.cardLabel}>Avg Module Retention</div>
                <div className={styles.cardValue}>{digest.kpis.avgModuleRetentionPct}%</div>
                <div className={styles.cardSub}>
                  <span className={styles.poDeltaPositive}>
                    +{digest.kpis.retentionDeltaPct}%
                  </span>{' '}
                  cohort return rate
                </div>
              </article>

              <article className={styles.card}>
                <div className={styles.cardLabel}>Leading Module</div>
                <div className={styles.cardValue}>{digest.kpis.topModuleSharePct}%</div>
                <div className={styles.cardSub}>{digest.kpis.topModuleName}</div>
              </article>
            </div>

            {/* Six Core Product Owner Signals Grid */}
            <div className={styles.poSignalGrid} {...{ 'data-testid': 'observability-signals-grid' }}>
              <TopUsersSignalCard
                items={digest.topUsers}
                maxInteractions={maxUserInteractions}
                activeWindow={selectedWindow}
                windowLabel={digest.windowLabel}
                baselineLabel={digest.baselineLabel}
                data-testid="observability-signal-top-users"
              />

              <CommonExceptionsSignalCard
                items={digest.commonExceptions}
                activeWindow={selectedWindow}
                windowLabel={digest.windowLabel}
                baselineLabel={digest.baselineLabel}
                data-testid="observability-signal-common-exceptions"
              />

              <RetentionDropsSignalCard
                items={digest.moduleRetentionDrops}
                activeWindow={selectedWindow}
                windowLabel={digest.windowLabel}
                data-testid="observability-signal-retention-drops"
              />

              <DropReasonsAiSignalCard
                summary={digest.dropReasonsSummary}
                modelLabel={selectedModelDisplayName}
                effort={digest.effort}
                data-testid="observability-signal-drop-reasons"
              />

              <TopModulesSignalCard
                items={digest.topModules}
                activeWindow={selectedWindow}
                windowLabel={digest.windowLabel}
                baselineLabel={digest.baselineLabel}
                data-testid="observability-signal-top-modules"
              />

              <DriveAdoptionAiSignalCard
                summary={digest.adoptionRecommendations}
                modelLabel={selectedModelDisplayName}
                effort={digest.effort}
                data-testid="observability-signal-drive-adoption"
              />
            </div>
          </>
        )}
      </div>
    </section>
  );
};

interface TopUsersSignalCardProps {
  items: ObservabilityTopUserItem[];
  maxInteractions: number;
  activeWindow: ObservabilityTrendWindow;
  windowLabel: string;
  baselineLabel: string;
  'data-testid': string;
}

const TopUsersSignalCard: React.FC<TopUsersSignalCardProps> = ({
  items,
  maxInteractions,
  activeWindow,
  windowLabel,
  baselineLabel,
  'data-testid': testId,
}) => (
  <section
    className={styles.poSignalCard}
    aria-labelledby="po-signal-top-users-heading"
    data-testid={testId}
  >
    <div className={styles.poSignalHeader}>
      <div>
        <h3 id="po-signal-top-users-heading" className={styles.poSignalTitle}>
          <span className={styles.poSignalNumber}>1</span>
          Top users
        </h3>
        <p className={styles.poSignalSubtitle}>
          Most engaged users in {windowLabel} ({baselineLabel})
        </p>
      </div>
      <span className={`${styles.badge} ${styles.badgeUi}`}>{items.length} power users</span>
    </div>

    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">User</th>
            <th scope="col">Interactions</th>
            <th scope="col">Primary Module</th>
            <th scope="col">Trend</th>
          </tr>
        </thead>
        <tbody>
          {items.map((user) => {
            const delta = formatDelta(user.deltaPct);
            const pct = Math.min(100, Math.round((user.interactions / maxInteractions) * 100));
            return (
              <tr key={user.userId}>
                <td>
                  <strong>{user.displayName}</strong>
                  <div className={styles.cardSub}>
                    {user.role} · {user.sessions} sessions · {user.modulesUsed} modules
                  </div>
                </td>
                <td>
                  <strong>{user.interactions.toLocaleString()}</strong>
                  <div className={styles.progress}>
                    <div className={styles.progressFill} style={{ width: `${pct}%` }} />
                  </div>
                  <WindowComparisonStrip
                    values={user.windowComparison}
                    activeWindow={activeWindow}
                  />
                </td>
                <td>{user.topModule}</td>
                <td>
                  <span className={delta.positive ? styles.poDeltaPositive : styles.poDeltaNegative}>
                    {delta.text}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </section>
);

interface CommonExceptionsSignalCardProps {
  items: ObservabilityExceptionItem[];
  activeWindow: ObservabilityTrendWindow;
  windowLabel: string;
  baselineLabel: string;
  'data-testid': string;
}

const CommonExceptionsSignalCard: React.FC<CommonExceptionsSignalCardProps> = ({
  items,
  activeWindow,
  windowLabel,
  baselineLabel,
  'data-testid': testId,
}) => (
  <section
    className={styles.poSignalCard}
    aria-labelledby="po-signal-exceptions-heading"
    data-testid={testId}
  >
    <div className={styles.poSignalHeader}>
      <div>
        <h3 id="po-signal-exceptions-heading" className={styles.poSignalTitle}>
          <span className={styles.poSignalNumber}>2</span>
          Most common exceptions
        </h3>
        <p className={styles.poSignalSubtitle}>
          Recurring client &amp; API failure signatures in {windowLabel} ({baselineLabel})
        </p>
      </div>
      <span className={`${styles.badge} ${styles.badgeError}`}>
        {items.length} tracked signatures
      </span>
    </div>

    <div className={styles.poInsightList}>
      {items.map((exc) => {
        const delta = formatDelta(exc.deltaPct, true);
        return (
          <article key={exc.id} className={styles.poInsightItem}>
            <div className={styles.poInsightTop}>
              <span className={styles.poInsightItemTitle}>{exc.signature}</span>
              <span className={severityBadgeClass(exc.severity)}>
                {exc.severity.toUpperCase()} · HTTP {exc.statusCode}
              </span>
            </div>
            <p className={styles.poInsightDetail}>
              Module: <strong>{exc.module}</strong> (<code>{exc.routeTemplate}</code>) ·{' '}
              <strong>{exc.count.toLocaleString()}</strong> occurrences impacting{' '}
              <strong>{exc.affectedUsers}</strong> users (
              <span className={delta.positive ? styles.poDeltaPositive : styles.poDeltaNegative}>
                {delta.text}
              </span>
              )
            </p>
            <WindowComparisonStrip values={exc.windowComparison} activeWindow={activeWindow} />
          </article>
        );
      })}
    </div>
  </section>
);

interface RetentionDropsSignalCardProps {
  items: ObservabilityModuleRetentionDropItem[];
  activeWindow: ObservabilityTrendWindow;
  windowLabel: string;
  'data-testid': string;
}

const RetentionDropsSignalCard: React.FC<RetentionDropsSignalCardProps> = ({
  items,
  activeWindow,
  windowLabel,
  'data-testid': testId,
}) => (
  <section
    className={styles.poSignalCard}
    aria-labelledby="po-signal-retention-drops-heading"
    data-testid={testId}
  >
    <div className={styles.poSignalHeader}>
      <div>
        <h3 id="po-signal-retention-drops-heading" className={styles.poSignalTitle}>
          <span className={styles.poSignalNumber}>3</span>
          Retention dropped per module
        </h3>
        <p className={styles.poSignalSubtitle}>
          Cohort return-rate contraction by module in {windowLabel}
        </p>
      </div>
      <span className={`${styles.badge} ${styles.badgeError}`}>Cohort watch</span>
    </div>

    <div className={styles.poInsightList}>
      {items.map((drop) => (
        <article key={drop.module} className={styles.poInsightItem}>
          <div className={styles.poInsightTop}>
            <span className={styles.poInsightItemTitle}>
              {drop.module} (<code>{drop.routeTemplate}</code>)
            </span>
            <span className={styles.poDeltaNegative}>
              -{drop.dropPct}% ({drop.previousRetentionPct}% → {drop.currentRetentionPct}%)
            </span>
          </div>
          <p className={styles.poInsightDetail}>
            {drop.returningUsers} returning users · {drop.lostUsers} dropped users · Friction:{' '}
            {drop.primaryFriction}
          </p>
          <div className={styles.progress}>
            <div
              className={`${styles.progressFill} ${
                drop.currentRetentionPct < 66 ? styles.progressCritical : styles.progressWarn
              }`}
              style={{ width: `${drop.currentRetentionPct}%` }}
            />
          </div>
          <WindowComparisonStrip
            values={drop.windowComparison}
            activeWindow={activeWindow}
            suffix="%"
          />
        </article>
      ))}
    </div>
  </section>
);

interface DropReasonsAiSignalCardProps {
  summary: ObservabilityDropReasonsSummary;
  modelLabel: string;
  effort: EffortLevel;
  'data-testid': string;
}

const DropReasonsAiSignalCard: React.FC<DropReasonsAiSignalCardProps> = ({
  summary,
  modelLabel,
  effort,
  'data-testid': testId,
}) => (
  <section
    className={styles.poSignalCardAccent}
    aria-labelledby="po-signal-drop-reasons-heading"
    data-testid={testId}
  >
    <div className={styles.poSignalHeader}>
      <div>
        <h3 id="po-signal-drop-reasons-heading" className={styles.poSignalTitle}>
          <span className={styles.poSignalNumber}>4</span>
          AI summary of why there could be drops
        </h3>
        <p className={styles.poSignalSubtitle}>
          Root-cause telemetry synthesis · {modelLabel} ({effortLabel(effort)} effort)
        </p>
      </div>
      <span className={`${styles.badge} ${styles.badgeUi}`}>AI Diagnosis</span>
    </div>

    <div className={styles.poNarrativeBox}>
      <p className={styles.poNarrativeHeadline}>{summary.headline}</p>
      <p className={styles.poNarrativeCopy}>{summary.narrative}</p>
    </div>

    <div className={styles.poInsightList}>
      {summary.findings.map((finding) => (
        <article key={finding.id} className={styles.poInsightItem}>
          <div className={styles.poInsightTop}>
            <span className={styles.poInsightItemTitle}>
              {finding.module}: {finding.title}
            </span>
            <span className={`${styles.badge} ${styles.badgeUi}`}>
              {finding.confidence} confidence
            </span>
          </div>
          <p className={styles.poInsightDetail}>{finding.detail}</p>
          <div className={styles.poInsightMeta}>Evidence: {finding.evidence}</div>
        </article>
      ))}
    </div>
  </section>
);

interface TopModulesSignalCardProps {
  items: ObservabilityTopModuleItem[];
  activeWindow: ObservabilityTrendWindow;
  windowLabel: string;
  baselineLabel: string;
  'data-testid': string;
}

const TopModulesSignalCard: React.FC<TopModulesSignalCardProps> = ({
  items,
  activeWindow,
  windowLabel,
  baselineLabel,
  'data-testid': testId,
}) => (
  <section
    className={styles.poSignalCard}
    aria-labelledby="po-signal-top-modules-heading"
    data-testid={testId}
  >
    <div className={styles.poSignalHeader}>
      <div>
        <h3 id="po-signal-top-modules-heading" className={styles.poSignalTitle}>
          <span className={styles.poSignalNumber}>5</span>
          Top modules
        </h3>
        <p className={styles.poSignalSubtitle}>
          Module adoption, session share, and retention in {windowLabel} ({baselineLabel})
        </p>
      </div>
      <span className={`${styles.badge} ${styles.badgeApi}`}>{items.length} core modules</span>
    </div>

    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Module</th>
            <th scope="col">Interactions &amp; Share</th>
            <th scope="col">Retention</th>
            <th scope="col">Growth</th>
          </tr>
        </thead>
        <tbody>
          {items.map((mod) => {
            const delta = formatDelta(mod.deltaPct);
            return (
              <tr key={mod.module}>
                <td>
                  <strong>{mod.module}</strong>
                  <div className={styles.cardSub}>
                    <code>{mod.routeTemplate}</code> · {mod.activeUsers} active users
                  </div>
                </td>
                <td>
                  <strong>
                    {mod.interactions.toLocaleString()} ({mod.sharePct}% share)
                  </strong>
                  <div className={styles.progress}>
                    <div
                      className={styles.progressFill}
                      style={{ width: `${Math.min(100, mod.sharePct * 2.5)}%` }}
                    />
                  </div>
                  <WindowComparisonStrip
                    values={mod.windowComparison}
                    activeWindow={activeWindow}
                  />
                </td>
                <td>{mod.retentionPct}%</td>
                <td>
                  <span className={delta.positive ? styles.poDeltaPositive : styles.poDeltaNegative}>
                    {delta.text}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </section>
);

interface DriveAdoptionAiSignalCardProps {
  summary: ObservabilityAdoptionSummary;
  modelLabel: string;
  effort: EffortLevel;
  'data-testid': string;
}

const DriveAdoptionAiSignalCard: React.FC<DriveAdoptionAiSignalCardProps> = ({
  summary,
  modelLabel,
  effort,
  'data-testid': testId,
}) => (
  <section
    className={styles.poSignalCardAccent}
    aria-labelledby="po-signal-drive-adoption-heading"
    data-testid={testId}
  >
    <div className={styles.poSignalHeader}>
      <div>
        <h3 id="po-signal-drive-adoption-heading" className={styles.poSignalTitle}>
          <span className={styles.poSignalNumber}>6</span>
          AI summary of how we can drive adoption
        </h3>
        <p className={styles.poSignalSubtitle}>
          Actionable growth &amp; recovery plays · {modelLabel} ({effortLabel(effort)} effort)
        </p>
      </div>
      <span className={`${styles.badge} ${styles.badgeApi}`}>Growth Plays</span>
    </div>

    <div className={styles.poNarrativeBox}>
      <p className={styles.poNarrativeHeadline}>{summary.headline}</p>
      <p className={styles.poNarrativeCopy}>{summary.narrative}</p>
    </div>

    <div className={styles.poInsightList}>
      {summary.recommendations.map((play) => (
        <article key={play.id} className={styles.poInsightItem}>
          <div className={styles.poInsightTop}>
            <span className={styles.poInsightItemTitle}>
              {play.module}: {play.title}
            </span>
            <span className={impactBadgeClass(play.impact)}>{play.impact} impact</span>
          </div>
          <p className={styles.poInsightDetail}>{play.action}</p>
          <div className={styles.poInsightMeta}>Expected outcome: {play.expectedLift}</div>
        </article>
      ))}
    </div>
  </section>
);

export default ObservabilityWorkspace;
