import React, { useCallback, useRef, useState } from 'react';
import type { BuildRunStatus } from '../../shared/types/build';
import { useBuildVerification } from '../hooks/useBuilds';
import {
  BuildEvidenceDialog,
  type BuildEvidenceDialogTarget,
} from './BuildEvidenceDialog';
import { BuildVerificationMatrix } from './BuildVerificationMatrix';
import styles from './BuildVerificationTab.module.css';

interface BuildVerificationTabProps {
  project: string;
  buildId: string;
  buildStatus?: BuildRunStatus;
}

const REVISION_SELECT_ID = 'build-verification-revision-select';

export const BuildVerificationTab: React.FC<BuildVerificationTabProps> = ({
  project,
  buildId,
  buildStatus,
}) => {
  const [selectedRevision, setSelectedRevision] = useState<number | undefined>(undefined);
  const [activeEvidence, setActiveEvidence] = useState<BuildEvidenceDialogTarget | null>(null);
  const lastTriggerRef = useRef<HTMLButtonElement | null>(null);

  const { data, isLoading, isError, refetch } = useBuildVerification(project, buildId, {
    revision: selectedRevision,
    buildStatus,
  });

  const handleOpenEvidence = useCallback(
    (target: BuildEvidenceDialogTarget, trigger: HTMLButtonElement) => {
      lastTriggerRef.current = trigger;
      setActiveEvidence(target);
    },
    [],
  );

  const handleCloseEvidence = useCallback(() => {
    setActiveEvidence(null);
    const trigger = lastTriggerRef.current;
    if (trigger) {
      trigger.focus();
    }
  }, []);

  const handleRevisionChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const next = Number(event.target.value);
      if (! data?.revisionNumbers.includes(next)) return;
      setSelectedRevision(next);
    },
    [data?.revisionNumbers],
  );

  if (isLoading) {
    return (
      <div className={styles.root} {...{ 'data-testid': 'build-verification-tab' }}>
        <BuildVerificationMatrix
          revisionNumber={selectedRevision ?? 1}
          rows={[]}
          isLoading
          onOpenEvidence={handleOpenEvidence}
        />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className={styles.root} {...{ 'data-testid': 'build-verification-tab' }}>
        <div
          className={styles.banner}
          role="alert"
          {...{ 'data-testid': 'build-verification-error' }}
        >
          <span>We could not load the verification results.</span>
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              void refetch();
            }}
            {...{ 'data-testid': 'build-verification-retry' }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const revisionOptions = [...data.revisionNumbers].sort((a, b) => b - a);
  const currentRevision = selectedRevision ?? data.revisionNumber;
  const { summary } = data;

  return (
    <div className={styles.root} {...{ 'data-testid': 'build-verification-tab' }}>
      <div className={styles.toolbar}>
        <div
          role="status"
          aria-live="polite"
          className={styles.summary}
          {...{ 'data-testid': 'build-verification-summary' }}
        >
          {`${summary.total} requirements: ${summary.pass} passed, ${summary.fail} failing, ${summary.deferred} deferred, ${summary.retired} retired.`}
        </div>
        {revisionOptions.length > 0 && (
          <label htmlFor={REVISION_SELECT_ID} className={styles.revisionControl}>
            <span>Revision</span>
            <select
              id={REVISION_SELECT_ID}
              className={styles.select}
              value={currentRevision}
              onChange={handleRevisionChange}
              {...{ 'data-testid': 'build-verification-revision-select' }}
            >
              {revisionOptions.map((rev) => (
                <option key={rev} value={rev}>
                  {`Revision ${rev}`}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {data.rows.length === 0 ? (
        <p className={styles.empty} {...{ 'data-testid': 'build-verification-empty' }}>
          No verification results yet. Results appear when an agent finishes a task.
        </p>
      ) : (
        <BuildVerificationMatrix
          revisionNumber={currentRevision}
          rows={data.rows}
          onOpenEvidence={handleOpenEvidence}
        />
      )}

      {activeEvidence && (
        // data-testid-exempt
        <BuildEvidenceDialog
          project={project}
          buildId={buildId}
          target={activeEvidence}
          onClose={handleCloseEvidence}
        />
      )}
    </div>
  );
};
