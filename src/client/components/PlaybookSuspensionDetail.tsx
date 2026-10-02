/**
 * Why a run is parked, and until when.
 *
 * The missing-deadline branch is the whole reason this is its own component. PBI-003's third
 * criterion is emphatic that a suspended step with no recorded deadline must surface a visible
 * warning rather than quietly omitting the field — because a suspension with no deadline is
 * invisible to the reconciliation sweep, so nothing will ever end it. Hiding the gap is what turns
 * a bug into a run that waits forever and nobody investigates.
 */
import React from 'react';
import { formatDeadline, suspendReasonLabel } from './playbookStatusFormat';
import type { PlaybookSuspensionDetail as SuspensionDetail } from '../../shared/types/playbook';
import styles from './PlaybookStatusView.module.css';

interface PlaybookSuspensionDetailProps {
  suspension: SuspensionDetail;
}

export const PlaybookSuspensionDetail: React.FC<PlaybookSuspensionDetailProps> = ({
  suspension,
}) => {
  const deadline = suspension.deadline ? formatDeadline(suspension.deadline) : null;

  return (
    <div className={styles.suspension} {...{ 'data-testid': 'playbook-suspension' }}>
      <p className={styles.suspensionCause} {...{ 'data-testid': 'playbook-suspension-cause' }}>
        {suspendReasonLabel(suspension.reason)}
      </p>

      {deadline ? (
        <p className={styles.suspensionDeadline} {...{ 'data-testid': 'playbook-suspension-deadline' }}>
          {/*
            * Both forms, always. The absolute value is the accessible label and the title, so a
            * screen reader and a hover both get the precise time rather than "in 2 hours".
            */}
          <span aria-label={`Deadline ${deadline.absolute}`} title={deadline.absolute}>
            Deadline {deadline.absolute}
          </span>{' '}
          <span className={styles.relative}>({deadline.relative})</span>
        </p>
      ) : (
        <p
          className={styles.deadlineMissing}
          role="status"
          {...{ 'data-testid': 'playbook-deadline-missing-warning' }}
        >
          No deadline recorded for this suspension. This is a data error — the reconciliation sweep
          cannot see a suspension without a deadline, so this step will not time out on its own.
        </p>
      )}
    </div>
  );
};

export default PlaybookSuspensionDetail;
