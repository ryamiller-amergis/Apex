import React from 'react';
import { Link } from 'react-router-dom';
import type { BuildDetailResponse } from '../../shared/types/buildView';
import { absoluteTime } from './playbookStatusFormat';
import { capLines, elapsedLabel, stageText, targetText } from './buildStatusFormat';
import { BuildSuspensionNotice } from './BuildSuspensionNotice';
import styles from './BuildRunView.module.css';

interface BuildRunHeaderProps {
  detail: BuildDetailResponse;
  /** Set when the last refresh failed and `detail` is the last known data. */
  staleSince: string | null;
  onRetry: () => void;
  actions: React.ReactNode;
}

export const BuildRunHeader: React.FC<BuildRunHeaderProps> = ({ detail, staleSince, onRetry, actions }) => {
  const { build, stage, timing, caps } = detail;
  const lines = capLines(caps);
  const text = stageText(stage, detail.currentRevision?.repairAttempts ?? 0);

  return (
    <header className={styles.header} {...{ 'data-testid': 'build-run-header' }}>
      <div className={styles.stage}>
        <div role="status" aria-live="polite" {...{ 'data-testid': 'build-run-stage' }}>
          <span {...{ 'data-testid': 'build-run-stage-text' }}>{text}</span>
        </div>
        {stage.key === 'queued' && stage.queuePosition !== null && (
          <span className={styles.taskDetail} {...{ 'data-testid': 'build-run-queue-position' }}>
            {`Position ${stage.queuePosition} in the queue`}
          </span>
        )}
        {stage.key === 'intake' && build.intakeInterviewId && (
          <Link
            to={`/builds/${encodeURIComponent(build.id)}/intake`}
            className={styles.back}
            {...{ 'data-testid': 'build-run-intake-link' }}
          >
            Open the conversation
          </Link>
        )}
      </div>
      <div className={styles.meta}>
        <span {...{ 'data-testid': 'build-run-elapsed' }}>{elapsedLabel(timing)}</span>
        <span
          className={timing.state === 'over' ? styles.over : undefined}
          {...{ 'data-testid': 'build-run-target' }}
        >
          {targetText(timing)}
        </span>
      </div>
      <ul className={styles.caps} aria-label="Limits used" {...{ 'data-testid': 'build-run-caps' }}>
        <li {...{ 'data-testid': 'build-run-cap-cost' }}>{lines.cost}</li>
        <li {...{ 'data-testid': 'build-run-cap-revisions' }}>{lines.revisions}</li>
        <li {...{ 'data-testid': 'build-run-cap-elapsed' }}>{lines.elapsed}</li>
        <li {...{ 'data-testid': 'build-run-cap-parallelism' }}>{lines.parallelism}</li>
      </ul>
      {staleSince && (
        <div className={styles.stale} role="status" {...{ 'data-testid': 'build-run-stale-indicator' }}>
          <span>{`Last updated ${absoluteTime(staleSince)}. Could not refresh. Retrying.`}</span>
          <button type="button" className={styles.button} onClick={onRetry} {...{ 'data-testid': 'build-run-stale-retry' }}>
            Try again
          </button>
        </div>
      )}
      <BuildSuspensionNotice stage={stage} supportContacts={detail.supportContacts} />
      {actions && <div {...{ 'data-testid': 'build-run-actions' }}>{actions}</div>}
    </header>
  );
};
