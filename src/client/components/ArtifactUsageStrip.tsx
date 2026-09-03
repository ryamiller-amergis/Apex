import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchEntityUsage } from '../hooks/useArtifactUsage';
import type { EntityUsageRollup } from '../../shared/types/aiCostAnalytics';
import styles from './ArtifactUsageStrip.module.css';

export function formatUsageTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatUsageDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin ? `${hours}h ${remMin}m` : `${hours}h`;
}

export function formatUsageCost(usd: number): string {
  if (usd <= 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

interface ArtifactUsageStripProps {
  endpoint: string;
  visible: boolean;
}

const RUNS_HELP =
  'Each finished agent call is one run. Generate, test cases, and validation can use different models — expand for the per-run model and cost.';

export const ArtifactUsageStrip: React.FC<ArtifactUsageStripProps> = ({ endpoint, visible }) => {
  const [expanded, setExpanded] = useState(false);
  const query = useQuery<EntityUsageRollup>({
    queryKey: ['artifact-usage', endpoint],
    queryFn: () => fetchEntityUsage(endpoint),
    enabled: visible && Boolean(endpoint),
    staleTime: 30_000,
    refetchInterval: (q) => ((q.state.data?.pendingSteps?.length ?? 0) > 0 ? 5_000 : false),
  });

  if (!visible) return null;
  const rollup = query.data;
  if (!rollup || rollup.interactions === 0) return null;
  const pendingSteps = rollup.pendingSteps ?? [];
  const pendingNote = pendingSteps.length > 0 ? `${pendingSteps.join(', ')} in progress` : null;

  return (
    <div className={styles.strip} {...{ 'data-testid': 'artifact-usage-strip' }}>
      <span className={styles.metric}>
        <span className={styles.label}>Tokens</span>
        <span className={styles.value}>{formatUsageTokens(rollup.totalTokens)}</span>
      </span>
      <span className={styles.metric}>
        <span className={styles.label}>Time</span>
        <span className={styles.value}>{formatUsageDuration(rollup.durationMs)}</span>
      </span>
      <span className={styles.metric}>
        <span className={styles.label}>Cost</span>
        <span className={styles.value}>{formatUsageCost(rollup.costUsd)}</span>
      </span>
      {rollup.runs.length > 0 ? (
        <button
          type="button"
          className={`${styles.metric} ${styles.metricToggle}`}
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          title={expanded ? 'Hide run breakdown' : RUNS_HELP}
          {...{ 'data-testid': 'artifact-usage-toggle' }}
        >
          <span className={styles.label}>Runs</span>
          <span className={styles.value}>{rollup.interactions}</span>
          <svg
            className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
      ) : (
        <span className={styles.metric} title={RUNS_HELP}>
          <span className={styles.label}>Runs</span>
          <span className={styles.value}>{rollup.interactions}</span>
        </span>
      )}
      {pendingNote && (
        <span className={styles.incomplete} {...{ 'data-testid': 'artifact-usage-pending' }}>
          {pendingNote}
        </span>
      )}
      {rollup.incomplete && (
        <span className={styles.incomplete} {...{ 'data-testid': 'artifact-usage-incomplete' }}>
          Cost pending
        </span>
      )}
      {expanded && (
        <ul className={styles.runs} {...{ 'data-testid': 'artifact-usage-runs' }}>
          {rollup.runs.map((run, index) => (
            <li
              key={`${run.label}-${run.modelId}-${run.createdAt}-${index}`}
              className={styles.run}
              {...{ 'data-testid': `artifact-usage-run-${index}` }}
            >
              <span className={styles.runLabel}>{run.label || 'Agent run'}</span>
              {' · '}
              {run.modelId} ·{' '}
              {formatUsageTokens(run.inputTokens + run.outputTokens + run.cacheReadTokens)} tokens
              {run.durationMs != null ? ` · ${formatUsageDuration(run.durationMs)}` : ''}
              {` · ${formatUsageCost(run.costUsd)}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
