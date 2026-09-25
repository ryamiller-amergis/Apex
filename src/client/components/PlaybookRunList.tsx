/**
 * One row per run, each expandable to its steps.
 *
 * Expansion fetches the run detail rather than the list carrying every step: the list is capped at
 * fifty and most rows are never opened, so loading all of them would be work nobody asked for on
 * every poll.
 *
 * The pinned version label is the point of PBI-002 as much as the step statuses are. BR-006 makes a
 * published version immutable and a run pins the version it started on, so "which version is this
 * run actually executing" is a question with a real answer — and one that becomes unanswerable the
 * moment a view shows the definition's current version instead.
 */
import React, { useState } from 'react';
import { PlaybookRunStepList } from './PlaybookRunStepList';
import { PlaybookRunActions } from './PlaybookRunActions';
import { PlaybookGateReviewPanel } from './PlaybookGateReviewPanel';
import { usePlaybookRun } from '../hooks/usePlaybookRuns';
import { absoluteTime, runStatusLabel } from './playbookStatusFormat';
import type { PlaybookRunSummary } from '../../shared/types/playbook';
import styles from './PlaybookStatusView.module.css';

interface PlaybookRunListProps {
  runs: PlaybookRunSummary[];
  project: string;
}

interface PlaybookRunRowProps {
  run: PlaybookRunSummary;
  project: string;
}

const PlaybookRunRow: React.FC<PlaybookRunRowProps> = ({ run, project }) => {
  const selectedRunId = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('run')
    : null;
  const [expanded, setExpanded] = useState(selectedRunId === run.runId);

  // Only fetched once opened; `usePlaybookRun` is disabled while `runId` is null.
  const detail = usePlaybookRun(project, expanded ? run.runId : null);

  const stepListId = `playbook-steps-${run.runId}`;

  return (
    <li className={styles.runRow} {...{ 'data-testid': 'playbook-run-row' }}>
      <button
        type="button"
        className={styles.runToggle}
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        aria-controls={stepListId}
        {...{ 'data-testid': 'playbook-run-expand-toggle' }}
      >
        <span className={styles.runName}>{run.definitionName}</span>

        {/*
          * The version the run pinned, not the definition's newest. Labelled rather than shown as a
          * bare number so "v3" cannot be mistaken for a run number or a step count.
          */}
        <span
          className={styles.pinnedVersion}
          {...{ 'data-testid': 'playbook-run-pinned-version' }}
        >
          pinned version v{run.versionNumber}
        </span>

        <span
          className={styles.runStatus}
          {...{ 'data-status': run.status, 'data-testid': 'playbook-run-status' }}
        >
          {runStatusLabel(run.status)}
        </span>

        <span className={styles.runMeta}>
          started {absoluteTime(run.startedAt)} by {run.initiatorUserId}
        </span>
      </button>

      {expanded ? (
        <div className={styles.runDetail}>
          {detail.isPending ? (
            <p className={styles.loading}>Loading steps…</p>
          ) : detail.isError ? (
            // The list stays rendered around this: one run failing to expand is not a reason to
            // take the other rows away.
            <p className={styles.error} role="status">
              Could not load this run&apos;s steps. {detail.error?.message}
            </p>
          ) : detail.data ? (
            <>
              <PlaybookRunStepList run={detail.data} id={stepListId} />
              <PlaybookGateReviewPanel
                project={project}
                run={detail.data}
                data-testid="playbook-gate-review-panel"
              />
              <PlaybookRunActions run={detail.data} />
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
};

export const PlaybookRunList: React.FC<PlaybookRunListProps> = ({ runs, project }) => (
  <ul className={styles.runList} {...{ 'data-testid': 'playbook-run-list' }}>
    {runs.map((run) => (
      <PlaybookRunRow key={run.runId} run={run} project={project} />
    ))}
  </ul>
);

export default PlaybookRunList;
