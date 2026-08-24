import React, { useRef, useState } from 'react';
import type {
  GroundingSurface,
  RunGroundingStatus as RunGroundingStatusDto,
} from '../../shared/types/runGrounding';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import { useRunGrounding } from '../hooks/useRunGrounding';
import { ReGroundConfirmDialog } from './ReGroundConfirmDialog';
import styles from './RunGroundingStatus.module.css';

interface RunGroundingStatusProps {
  surface: GroundingSurface;
  domainRunId: string;
  project: string;
}

const GroundingStatusEnabled: React.FC<RunGroundingStatusProps> = ({
  surface,
  domainRunId,
}) => {
  const [confirming, setConfirming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const {
    statuses,
    isLoading,
    isError,
    reGround,
    isReGrounding,
    reGroundError,
  } = useRunGrounding(surface, domainRunId);

  if (isLoading) {
    return <span className={styles.loading}>Loading grounding status…</span>;
  }
  if (isError) {
    return (
      <span className={styles.unavailable}>Grounding status unavailable.</span>
    );
  }

  const target = statuses.find(
    (item): item is RunGroundingStatusDto => item.role === 'target'
  );
  if (!target) return null;

  const groundedDate = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
  }).format(new Date(target.groundedAt));
  const ownerExplanationId = `run-grounding-owner-${domainRunId}`;

  const confirmReGround = async () => {
    try {
      await reGround(target.role);
      setConfirming(false);
    } catch {
      // The mutation exposes the inline error; keep the dialog open for retry.
    }
  };

  return (
    <>
      <section
        className={styles.status}
        aria-label="Repository grounding status"
        {...{ 'data-testid': 'run-grounding-status' }}
      >
        <span
          className={styles.badge}
          title={`Pinned commit ${target.groundedSha}, grounded ${groundedDate}`}
          aria-label={`Pinned commit ${target.groundedSha}, grounded ${groundedDate}`}
          {...{ 'data-testid': 'run-grounding-sha' }}
        >
          {target.groundedShaShort} · {groundedDate}
        </span>
        {target.driftState !== 'grounded' ? (
          <p
            className={styles.notice}
            role="status"
            aria-live="polite"
            {...{ 'data-testid': 'run-grounding-drift-notice' }}
          >
            <span aria-hidden="true">⚠</span>{' '}
            {target.driftState === 'source-changed'
              ? 'Source changed — re-evaluate when ready.'
              : 'Pinned source unavailable locally — using remote fallback.'}
          </p>
        ) : null}
        {target.stalenessState !== 'fresh' ? (
          <p
            className={styles.notice}
            role="status"
            aria-live="polite"
            {...{ 'data-testid': 'run-grounding-staleness-notice' }}
          >
            {target.stalenessState === 'hard-checkpoint'
              ? 'Hard checkpoint — this pin is 14+ days old.'
              : 'This pin is aging (7+ days or 50+ commits behind).'}
            {target.commitsBehind > 0
              ? ` ${target.commitsBehind} commit${target.commitsBehind === 1 ? '' : 's'} behind.`
              : ''}
          </p>
        ) : null}
        <button
          ref={triggerRef}
          type="button"
          className={styles.action}
          disabled={!target.canReGround}
          aria-describedby={target.canReGround ? undefined : ownerExplanationId}
          onClick={() => setConfirming(true)}
          {...{ 'data-testid': 'run-grounding-reground-button' }}
        >
          Re-ground
        </button>
        {!target.canReGround ? (
          <span id={ownerExplanationId} className={styles.explanation}>
            Only the run owner can re-ground.
          </span>
        ) : null}
      </section>
      {confirming ? (
        <ReGroundConfirmDialog
          triggerRef={triggerRef}
          isPending={isReGrounding}
          error={reGroundError}
          onConfirm={() => void confirmReGround()}
          onClose={() => setConfirming(false)}
          {...{ 'data-testid': 'run-grounding-reground-dialog' }}
        />
      ) : null}
    </>
  );
};

export const RunGroundingStatus: React.FC<RunGroundingStatusProps> = (
  props
) => {
  const enabled = useFeatureFlag(
    'repo-grounding-workspace-profile',
    props.project
  );

  // Retain the enabled branch after two stable sprints at full rollout.
  // @feature-flag:repo-grounding-workspace-profile start winner=enabled
  if (!enabled) {
    // @feature-flag:repo-grounding-workspace-profile disabled-start
    const disabledResult = null;
    // @feature-flag:repo-grounding-workspace-profile disabled-end
    return disabledResult;
  }

  // @feature-flag:repo-grounding-workspace-profile enabled-start
  const result = <GroundingStatusEnabled {...props} />;
  // @feature-flag:repo-grounding-workspace-profile enabled-end
  // @feature-flag:repo-grounding-workspace-profile end
  return result;
};
