/**
 * The Playbook status view — the only client surface in Epic 1.
 *
 * Its data path runs entirely against the Apex-owned projection, which is what makes the view
 * itself the evidence for BR-001 rather than a claim about it: if this renders correctly with every
 * engine table dropped, nothing outside the wrapper needed the engine's store. Exit criterion E4
 * drops them and asks again.
 *
 * The expanded detail adds only Phase 1's cancel/retry controls. The status projection remains the
 * source of truth; action mutations invalidate and re-read it rather than editing cached rows.
 */
import React from 'react';
import { PlaybookDefinitionPanel } from './PlaybookDefinitionPanel';
import { PlaybookRunList } from './PlaybookRunList';
import { usePlaybookRuns } from '../hooks/usePlaybookRuns';
import styles from './PlaybookStatusView.module.css';

interface PlaybookStatusViewProps {
  selectedProject: string;
}

export const PlaybookStatusView: React.FC<PlaybookStatusViewProps> = ({ selectedProject }) => {
  const { data, isPending, isError, error, refetch } = usePlaybookRuns(selectedProject);

  return (
    <div className={styles.view} {...{ 'data-testid': 'playbook-status-view' }}>
      <header className={styles.header}>
        <h1 className={styles.title}>Playbook runs</h1>
        <p className={styles.hint}>
          Live step status for {selectedProject}, read from Apex&apos;s own tables.
        </p>
      </header>

      <PlaybookDefinitionPanel
        project={selectedProject}
        {...{ 'data-testid': 'playbook-definitions-panel' }}
      />

      {isPending ? (
        <p className={styles.loading} {...{ 'data-testid': 'playbook-runs-loading' }}>
          Loading Playbook runs…
        </p>
      ) : isError ? (
        <div className={styles.error} role="status" {...{ 'data-testid': 'playbook-runs-error' }}>
          <p>Could not load Playbook runs. {error?.message}</p>
          <button
            type="button"
            className={styles.retry}
            onClick={() => void refetch()}
            {...{ 'data-testid': 'playbook-runs-retry' }}
          >
            Try again
          </button>
        </div>
      ) : data && data.runs.length > 0 ? (
        <>
          <PlaybookRunList runs={data.runs} project={selectedProject} />

          {/*
            * Shown only when rows are actually hidden. The PRD's data-volume requirement is that
            * the total above the cap is accurate — a view claiming "20 runs" when there are 300 is
            * worse than one showing 20 and saying so.
            */}
          {data.total > data.runs.length ? (
            <p className={styles.total} {...{ 'data-testid': 'playbook-runs-total' }}>
              Showing {data.runs.length} of {data.total} runs.
            </p>
          ) : null}
        </>
      ) : (
        // An empty project is a normal state, not a failure. PBI-002's third criterion exists
        // because rendering an error here is the easy mistake.
        <p className={styles.empty} {...{ 'data-testid': 'playbook-runs-empty-state' }}>
          No Playbook runs in this project yet.
        </p>
      )}
    </div>
  );
};

export default PlaybookStatusView;
