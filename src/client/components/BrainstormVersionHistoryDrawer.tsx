import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { BrainstormArtifactOrigin } from '../../shared/types/brainstormArtifact';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { BrainstormApiError } from '../hooks/useBrainstormSessions';
import { useBrainstormCompare, useBrainstormVersions, useRollbackArtifact } from '../hooks/useBrainstormArtifact';
import { computeUnifiedDiff } from '../utils/diff';
import { DiffView } from './DiffView';
import styles from './BrainstormVersionHistoryDrawer.module.css';

const ORIGIN_LABELS: Record<BrainstormArtifactOrigin, string> = {
  ai_change: 'Collaborator change',
  type_switch: 'Type switch',
  rollback: 'Rollback',
};

export const STALE_ROLLBACK_MESSAGE = 'The artifact changed. Review the current version, then try again.';

interface BrainstormVersionHistoryDrawerProps {
  project: string;
  sessionId: string;
  currentVersion: number;
  canMutate: boolean;
  turnRunning: boolean;
  onClose: () => void;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export const BrainstormVersionHistoryDrawer: React.FC<BrainstormVersionHistoryDrawerProps> = ({
  project,
  sessionId,
  currentVersion,
  canMutate,
  turnRunning,
  onClose,
}) => {
  const { isMobile } = useBreakpoint();
  const versions = useBrainstormVersions(project, sessionId, true);
  const rollback = useRollbackArtifact(project, sessionId);
  const [selected, setSelected] = useState<number[]>([]);
  const [comparing, setComparing] = useState<[number, number] | null>(null);
  const [changesOnly, setChangesOnly] = useState(false);
  const [rollbackError, setRollbackError] = useState<{ sequence: number; message: string; stale: boolean } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const compare = useBrainstormCompare(project, sessionId, comparing);

  const diffCounts = useMemo(() => {
    if (!compare.data) return { added: 0, removed: 0 };
    const lines = computeUnifiedDiff(compare.data.from.markdown, compare.data.to.markdown);
    return {
      added: lines.filter((line) => line.type === 'added').length,
      removed: lines.filter((line) => line.type === 'removed').length,
    };
  }, [compare.data]);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const rows = versions.data?.versions ?? [];
  const nothingToCompare = versions.isSuccess && rows.length < 2;

  const toggle = (sequence: number) => {
    setComparing(null);
    setSelected((current) => {
      if (current.includes(sequence)) return current.filter((item) => item !== sequence);
      return [...current, sequence].slice(-2);
    });
  };

  const handleRollback = async (sequence: number) => {
    setRollbackError(null);
    try {
      await rollback.mutateAsync({ toSequence: sequence, expectedVersion: currentVersion });
    } catch (err) {
      const code = err instanceof BrainstormApiError ? err.code : null;
      if (code === 'ARTIFACT_VERSION_CONFLICT') {
        setRollbackError({ sequence, message: STALE_ROLLBACK_MESSAGE, stale: true });
      } else if (code === 'TURN_IN_PROGRESS') {
        setRollbackError({ sequence, message: 'Wait for the collaborator to finish, then try again.', stale: false });
      } else {
        setRollbackError({ sequence, message: 'We could not roll back. Try again.', stale: false });
      }
    }
  };

  let list: React.ReactNode;
  if (versions.isLoading) {
    list = (
      <div aria-busy="true" aria-label="Loading versions">
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
      </div>
    );
  } else if (versions.isError) {
    list = (
      <div className={styles.error} role="alert">
        <p>We could not load the version history.</p>
        <button type="button" className={styles.button} onClick={() => { void versions.refetch(); }} {...{ 'data-testid': 'brainstorm-history-retry' }}>
          Retry
        </button>
      </div>
    );
  } else if (rows.length === 0) {
    list = <p className={styles.empty}>No versions yet</p>;
  } else {
    list = (
      <ul className={styles.list} aria-label="Versions, newest first">
        {rows.map((row) => {
          const checkboxId = `brainstorm-version-${sessionId}-${row.sequence}`;
          const isCurrent = row.sequence === currentVersion;
          return (
            <li key={row.sequence} className={styles.row} {...{ 'data-testid': `brainstorm-version-row-${row.sequence}` }}>
              <div className={styles.rowMain}>
                <input
                  id={checkboxId}
                  type="checkbox"
                  checked={selected.includes(row.sequence)}
                  onChange={() => toggle(row.sequence)}
                  aria-label={`Select version ${row.sequence} to compare`}
                  {...{ 'data-testid': `brainstorm-version-select-${row.sequence}` }}
                />
                <label htmlFor={checkboxId} className={styles.rowText}>
                  <span className={styles.rowTitle}>
                    Version {row.sequence}
                    {isCurrent && <span className={styles.current}> (current)</span>}
                  </span>
                  {row.checkpointName && <span className={styles.checkpoint}>{row.checkpointName}</span>}
                  <span className={styles.meta}>
                    {ORIGIN_LABELS[row.origin]} · {formatTime(row.createdAt)}
                  </span>
                </label>
                {canMutate && !isCurrent && (
                  <button
                    type="button"
                    className={styles.button}
                    disabled={rollback.isPending || turnRunning}
                    onClick={() => { void handleRollback(row.sequence); }}
                    {...{ 'data-testid': `brainstorm-rollback-${row.sequence}` }}
                  >
                    Roll back
                  </button>
                )}
              </div>
              {rollbackError?.sequence === row.sequence && (
                <p
                  className={styles.rowError}
                  role="alert"
                  {...(rollbackError.stale ? { 'data-testid': 'brainstorm-rollback-stale' } : {})}
                >
                  {rollbackError.message}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className={styles.backdrop}>
      <button
        type="button"
        className={styles.backdropButton}
        aria-label="Close version history"
        tabIndex={-1}
        onClick={onClose}
        {...{ 'data-testid': 'brainstorm-history-backdrop' }}
      />
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- dialog drawer handles Escape to close */}
      <aside
        className={[
          styles.drawer,
          isMobile ? styles.sheet : '',
          comparing && !isMobile ? styles.drawerComparing : '',
        ].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="false"
        aria-labelledby={`brainstorm-history-title-${sessionId}`}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
        {...{ 'data-testid': 'brainstorm-history-drawer' }}
      >
        <div className={styles.header}>
          <div>
            <h2 id={`brainstorm-history-title-${sessionId}`} ref={headingRef} tabIndex={-1} className={styles.title}>
              Version history
            </h2>
            <p className={styles.subtitle}>
              Select any two versions and click Compare to inspect changes, or roll back to an earlier draft.
            </p>
          </div>
          <button type="button" className={styles.button} onClick={onClose} {...{ 'data-testid': 'brainstorm-history-close' }}>
            Close
          </button>
        </div>
        <div className={`${styles.bodyLayout} ${comparing && !isMobile ? styles.bodySplit : ''}`}>
          <div className={styles.versionsColumn}>
            {list}
            <div className={styles.compareBar}>
              {nothingToCompare ? (
                <p className={styles.empty} {...{ 'data-testid': 'brainstorm-compare-empty' }}>
                  There is nothing to compare yet
                </p>
              ) : (
                <button
                  type="button"
                  className={`${styles.button} ${selected.length === 2 ? styles.primaryButton : ''}`}
                  disabled={selected.length !== 2}
                  onClick={() => setComparing([Math.min(...selected), Math.max(...selected)] as [number, number])}
                  {...{ 'data-testid': 'brainstorm-version-compare' }}
                >
                  {selected.length === 2
                    ? `Compare v${Math.min(...selected)} → v${Math.max(...selected)}`
                    : 'Compare (select 2)'}
                </button>
              )}
            </div>
          </div>
          {comparing && (
            <section className={styles.compare} aria-label={`Changes from version ${comparing[0]} to version ${comparing[1]}`}>
              {compare.isLoading && <div className={styles.skeletonRow} aria-busy="true" />}
              {compare.isError && (
                compare.error instanceof BrainstormApiError && compare.error.code === 'NOTHING_TO_COMPARE' ? (
                  <p className={styles.empty} {...{ 'data-testid': 'brainstorm-compare-empty' }}>
                    There is nothing to compare yet
                  </p>
                ) : (
                  <div className={styles.error} role="alert">
                    <p>We could not load the comparison.</p>
                    <button
                      type="button"
                      className={styles.button}
                      onClick={() => { void compare.refetch(); }}
                      {...{ 'data-testid': 'brainstorm-compare-retry' }}
                    >
                      Retry
                    </button>
                  </div>
                )
              )}
              {compare.data && (
                <div className={styles.compareCard} {...{ 'data-testid': 'brainstorm-compare-view' }}>
                  <div className={styles.compareToolbar}>
                    <div className={styles.compareSummary}>
                      <span className={styles.compareTitle}>
                        Version {compare.data.from.sequence} to version {compare.data.to.sequence}
                      </span>
                      <span className={styles.diffStatAdd}>+{diffCounts.added}</span>
                      <span className={styles.diffStatRemove}>−{diffCounts.removed}</span>
                      <span className={styles.meta}>Added lines start with +, removed lines with −.</span>
                    </div>
                    <label className={styles.changesToggle}>
                      <input
                        type="checkbox"
                        checked={changesOnly}
                        onChange={(event) => setChangesOnly(event.target.checked)}
                        {...{ 'data-testid': 'brainstorm-compare-changes-only' }}
                      />
                      <span>Changes only</span>
                    </label>
                  </div>
                  <div className={styles.diffViewport}>
                    {/* data-testid-exempt — DiffView renders inside brainstorm-compare-view */}
                    <DiffView
                      oldText={compare.data.from.markdown}
                      newText={compare.data.to.markdown}
                      changesOnly={changesOnly}
                    />
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      </aside>
    </div>
  );
};
