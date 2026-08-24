import React from 'react';
import type { RunGroundingStatus } from '../../shared/types/runGrounding';
import styles from './GroundingResumeCard.module.css';

interface GroundingResumeCardProps {
  status: RunGroundingStatus;
  isPending: boolean;
  error: Error | null;
  onContinue: () => void;
  onUpdateToLatest: () => void;
  'data-testid'?: string;
}

function formatAge(groundedAt: string): string {
  const ageMs = Math.max(0, Date.now() - Date.parse(groundedAt));
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

export const GroundingResumeCard: React.FC<GroundingResumeCardProps> = ({
  status,
  isPending,
  error,
  onContinue,
  onUpdateToLatest,
  'data-testid': testId = 'grounding-resume-card',
}) => {
  const loud = status.stalenessState === 'hard-checkpoint';
  const title =
    loud
      ? 'This snapshot is a hard checkpoint'
      : 'This conversation is still on an older snapshot';

  return (
    <section
      className={styles.card}
      data-loud={loud ? 'true' : 'false'}
      aria-label="Repository snapshot choice"
      {...{ 'data-testid': testId }}
    >
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.body}>
        Pinned commit <code>{status.groundedShaShort}</code> from{' '}
        {formatAge(status.groundedAt)}. Continue on that snapshot, or update to
        the latest code before sending.
      </p>
      <p className={styles.meta}>
        {status.commitsBehind} commit{status.commitsBehind === 1 ? '' : 's'} behind
        {status.changedFileCount > 0
          ? ` · ${status.changedFileCount} file${status.changedFileCount === 1 ? '' : 's'} changed`
          : ''}
      </p>
      {error ? (
        <p className={styles.error} role="alert">
          {error.message}
        </p>
      ) : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.secondary}
          disabled={isPending}
          onClick={() => void onUpdateToLatest()}
          {...{ 'data-testid': 'grounding-resume-update' }}
        >
          {isPending ? 'Updating…' : 'Update to latest'}
        </button>
        <button
          type="button"
          className={styles.primary}
          disabled={isPending}
          onClick={onContinue}
          {...{ 'data-testid': 'grounding-resume-continue' }}
        >
          Continue on this snapshot
        </button>
      </div>
    </section>
  );
};
