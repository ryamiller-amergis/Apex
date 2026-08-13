import React, { useEffect, useRef } from 'react';
import type { RunGroundingStatus } from '../../shared/types/runGrounding';
import styles from './ReGroundConfirmDialog.module.css';

interface GroundingHandoffDialogProps {
  parentLabel: string;
  status: RunGroundingStatus;
  isPending: boolean;
  error: Error | null;
  onInherit: () => void;
  onUseLatest: () => void;
  onClose: () => void;
  'data-testid'?: string;
}

function formatAge(groundedAt: string): string {
  const ageMs = Math.max(0, Date.now() - Date.parse(groundedAt));
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

export const GroundingHandoffDialog: React.FC<GroundingHandoffDialogProps> = ({
  parentLabel,
  status,
  isPending,
  error,
  onInherit,
  onUseLatest,
  onClose,
  'data-testid': testId = 'grounding-handoff-dialog',
}) => {
  const inheritRef = useRef<HTMLButtonElement>(null);
  const latestRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    inheritRef.current?.focus();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && !isPending) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const first = latestRef.current;
    const last = inheritRef.current;
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-labelledby="grounding-handoff-title"
      {...{ 'data-testid': testId }}
    >
      <section className={styles.dialog}>
        <h2 id="grounding-handoff-title">Which code should this use?</h2>
        <p>
          {parentLabel} is pinned to <code>{status.groundedShaShort}</code>{' '}
          ({formatAge(status.groundedAt)}
          {status.commitsBehind > 0
            ? `, ${status.commitsBehind} commit${status.commitsBehind === 1 ? '' : 's'} behind`
            : ''}
          ). Using that snapshot keeps this document aligned with the conversation.
        </p>
        {error ? (
          <p className={styles.error} role="alert">
            {error.message}
          </p>
        ) : null}
        <div className={styles.actions}>
          <button
            ref={latestRef}
            type="button"
            className={styles.secondary}
            disabled={isPending}
            onClick={onUseLatest}
            onKeyDown={handleKeyDown}
            {...{ 'data-testid': 'grounding-handoff-latest' }}
          >
            Use latest
          </button>
          <button
            ref={inheritRef}
            type="button"
            className={styles.primary}
            disabled={isPending}
            onClick={onInherit}
            onKeyDown={handleKeyDown}
            {...{ 'data-testid': 'grounding-handoff-inherit' }}
          >
            Use {parentLabel}&apos;s code
          </button>
        </div>
      </section>
    </div>
  );
};
