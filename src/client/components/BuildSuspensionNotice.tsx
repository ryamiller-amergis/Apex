import React from 'react';
import type { BuildStageView, BuildSupportContactView } from '../../shared/types/buildView';
import { exceptionCopy } from './buildStatusFormat';
import styles from './BuildRunView.module.css';

interface BuildSuspensionNoticeProps {
  stage: BuildStageView;
  supportContacts: BuildSupportContactView[];
}

/** Cause, then who to contact, for a build in an exception state. Renders nothing while running. */
export const BuildSuspensionNotice: React.FC<BuildSuspensionNoticeProps> = ({ stage, supportContacts }) => {
  const copy = exceptionCopy(stage, supportContacts);
  if (!copy) return null;

  return (
    <div className={styles.notice} {...{ 'data-testid': 'build-run-exception' }}>
      <p {...{ 'data-testid': 'build-run-exception-cause' }}>{copy.cause}</p>
      {copy.contact && <p {...{ 'data-testid': 'build-run-exception-contacts' }}>{copy.contact}</p>}
      {copy.resume && <p {...{ 'data-testid': 'build-run-exception-resume' }}>{copy.resume}</p>}
    </div>
  );
};
