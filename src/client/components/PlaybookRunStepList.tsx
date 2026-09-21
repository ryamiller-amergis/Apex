/**
 * The steps of one run, in execution order, with the suspension detail attached to the parked one.
 *
 * Renders status as text (PBI-002's accessibility requirement) with colour applied on top by class,
 * never instead. The distinction matters for the demo audience as much as for accessibility: a row
 * of coloured dots does not tell anyone what "waiting" is waiting for.
 *
 * Step *output* is deliberately absent. Outputs can carry agent transcripts confidential to a
 * project, and Phase 0 has no redaction story, so the view shows that a step completed rather than
 * what it produced.
 */
import React from 'react';
import { PlaybookSuspensionDetail } from './PlaybookSuspensionDetail';
import { absoluteTime, stepStatusLabel } from './playbookStatusFormat';
import type {
  PlaybookRunDetail,
  PlaybookStepRun,
} from '../../shared/types/playbook';
import styles from './PlaybookStatusView.module.css';

interface PlaybookRunStepListProps {
  run: PlaybookRunDetail;
  /** The DOM id the run row's `aria-controls` points at. */
  id: string;
}

function stepTiming(step: PlaybookStepRun): string {
  if (step.completedAt) return `Finished ${absoluteTime(step.completedAt)}`;
  if (step.startedAt) return `Started ${absoluteTime(step.startedAt)}`;
  return 'Not started yet';
}

export const PlaybookRunStepList: React.FC<PlaybookRunStepListProps> = ({ run, id }) => {
  if (run.steps.length === 0) {
    return (
      <div className={styles.stepList} id={id} {...{ 'data-testid': 'playbook-step-list' }}>
        <p className={styles.empty}>No steps recorded yet.</p>
      </div>
    );
  }

  return (
    <ul className={styles.stepList} id={id} {...{ 'data-testid': 'playbook-step-list' }}>
      {run.steps.map((step) => {
        const isSuspended = step.status === 'suspended';

        return (
          <li
            key={step.id}
            className={styles.stepRow}
            {...{ 'data-testid': 'playbook-step-row' }}
          >
            <div className={styles.stepHeader}>
              <span className={styles.stepName}>{step.stepId}</span>
              <span className={styles.stepType}>{step.stepType}</span>
              {/*
                * `data-status` drives colour from CSS; the text is the status itself. Removing the
                * attribute would lose the colour and change nothing a person reads, which is the
                * test of whether colour is carrying meaning on its own.
                */}
              <span
                className={styles.stepStatus}
                data-status={step.status}
                {...{ 'data-testid': 'playbook-step-status' }}
              >
                {stepStatusLabel(step.status)}
              </span>
            </div>

            <p className={styles.stepTiming}>{stepTiming(step)}</p>

            {/* Only on the parked step, which is PBI-003's fourth criterion: a run with no
                suspension shows no suspension detail anywhere. */}
            {isSuspended && run.suspension && run.suspension.stepId === step.stepId ? (
              <PlaybookSuspensionDetail suspension={run.suspension} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
};

export default PlaybookRunStepList;
