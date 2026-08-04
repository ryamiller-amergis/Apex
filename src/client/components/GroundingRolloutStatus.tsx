import React from 'react';
import type {
  GroundingGateResult,
  GroundingGateStatus,
  GroundingRolloutStage,
} from '../../shared/types/groundingOperations';
import { useGroundingRolloutStatus } from '../hooks/useGroundingRolloutStatus';
import styles from './GroundingRolloutStatus.module.css';

interface GroundingRolloutStatusProps {
  stage: GroundingRolloutStage;
  project?: string;
  onAdvance: () => void;
}

const STATUS_PRESENTATION: Record<
  GroundingGateStatus,
  { icon: string; label: string }
> = {
  pass: { icon: '✓', label: 'Pass' },
  fail: { icon: '×', label: 'Fail' },
  unknown: { icon: '?', label: 'Unknown' },
};

function stageLabel(stage: GroundingRolloutStage): string {
  switch (stage) {
    case 'design-module':
      return 'Design Module';
    case 'interviews-documents':
      return 'Interviews and documents';
    case 'assistants-walkthroughs':
      return 'Assistants and walkthroughs';
    case 'convergence':
      return 'Remote-search convergence';
  }
}

function formatMetric(gate: GroundingGateResult): string {
  if (gate.value === null) return 'No data';
  if (gate.id === 'fallback-rate' || gate.id === 'mirror-hit-rate') {
    return `${(gate.value * 100).toFixed(1)}%`;
  }
  if (
    gate.id === 'warm-materialization-p95' ||
    gate.id === 'cold-materialization-p95'
  ) {
    return gate.value >= 1_000
      ? `${(gate.value / 1_000).toFixed(1)}s`
      : `${gate.value.toFixed(0)}ms`;
  }
  return gate.value.toLocaleString();
}

function formatThreshold(gate: GroundingGateResult): string {
  const threshold = formatMetric({ ...gate, value: gate.threshold });
  return `${gate.comparison} ${threshold}`;
}

export const GroundingRolloutStatus: React.FC<
  GroundingRolloutStatusProps
> = ({ stage, project, onAdvance }) => {
  const query = useGroundingRolloutStatus(stage, project);

  if (query.isLoading) {
    return (
      <section
        className={styles.card}
        aria-labelledby="grounding-rollout-status-title"
        {...{ 'data-testid': 'grounding-rollout-status' }}
      >
        <h3 id="grounding-rollout-status-title" className={styles.title}>
          Grounding rollout status
        </h3>
        <div
          className={styles.skeletonList}
          role="status"
          aria-label="Loading grounding rollout status"
        >
          {Array.from({ length: 5 }, (_, index) => (
            <div
              key={index}
              className={styles.skeletonRow}
              {...{ 'data-testid': 'grounding-gate-row' }}
            />
          ))}
        </div>
      </section>
    );
  }

  if (query.isError || !query.data) {
    const message =
      query.error instanceof Error
        ? query.error.message
        : 'Unable to load rollout status';
    return (
      <section
        className={styles.card}
        aria-labelledby="grounding-rollout-status-title"
        {...{ 'data-testid': 'grounding-rollout-status' }}
      >
        <h3 id="grounding-rollout-status-title" className={styles.title}>
          Grounding rollout status
        </h3>
        <div className={styles.error} role="alert">
          <span>{message}</span>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => void query.refetch()}
            {...{ 'data-testid': 'grounding-rollout-retry' }}
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  const evaluation = query.data;
  const insufficientSample =
    evaluation.sampleSize < evaluation.minimumSampleSize;
  const overallStatus = evaluation.eligible
    ? 'Eligible'
    : insufficientSample ||
        evaluation.gates.every((gate) => gate.status === 'unknown')
      ? 'Unknown'
      : 'Blocked';
  const overallIcon =
    overallStatus === 'Eligible' ? '✓' : overallStatus === 'Blocked' ? '×' : '?';

  return (
    <section
      className={styles.card}
      aria-labelledby="grounding-rollout-status-title"
      {...{ 'data-testid': 'grounding-rollout-status' }}
    >
      <div className={styles.header}>
        <div>
          <h3 id="grounding-rollout-status-title" className={styles.title}>
            Grounding rollout status
          </h3>
          <p className={styles.subtitle}>
            {stageLabel(stage)}
            {project ? ` · ${project}` : ' · All projects'}
          </p>
        </div>
        <span
          className={`${styles.overallStatus} ${
            styles[`status${overallStatus}`]
          }`}
          {...{ 'data-testid': 'grounding-gate-status' }}
        >
          <span aria-hidden="true">{overallIcon}</span> {overallStatus}
        </span>
      </div>

      <p className={styles.sample}>
        <strong>{evaluation.sampleSize.toLocaleString()} runs</strong>
        {' · '}
        Minimum {evaluation.minimumSampleSize.toLocaleString()}
      </p>

      {insufficientSample && (
        <p className={styles.emptyState}>
          Insufficient sample — gates unknown
        </p>
      )}

      <ul className={styles.gateList}>
        {evaluation.gates.map((gate) => {
          const presentation = STATUS_PRESENTATION[gate.status];
          return (
            <li
              key={gate.id}
              className={styles.gateRow}
              {...{ 'data-testid': 'grounding-gate-row' }}
            >
              <div>
                <span className={styles.gateLabel}>{gate.label}</span>
                <span className={styles.threshold}>
                  Required {formatThreshold(gate)}
                </span>
              </div>
              <span className={styles.metric}>{formatMetric(gate)}</span>
              <span
                className={`${styles.gateStatus} ${
                  styles[`gateStatus${presentation.label}`]
                }`}
              >
                <span aria-hidden="true">{presentation.icon}</span>{' '}
                {presentation.label}
              </span>
            </li>
          );
        })}
      </ul>

      <div className={styles.actions}>
        <p className={styles.manualNote}>
          Advancement is manual and updates the existing audited Feature Flag
          targeting rules.
        </p>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={!evaluation.eligible}
          onClick={onAdvance}
          {...{ 'data-testid': 'grounding-advance-button' }}
        >
          Review advancement controls
        </button>
      </div>
    </section>
  );
};

export default GroundingRolloutStatus;
