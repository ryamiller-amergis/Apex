import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useMyPermissions } from '../hooks/useRbac';
import { BUILDS_RUN } from '../../shared/types/buildAccess';
import styles from './BuildsView.module.css';

interface BuildsViewProps {
  project: string;
  isSuperAdmin?: boolean;
}

/** Page shell for Builds. FEAT-004 adds the builds list body and the New build form. */
export const BuildsView: React.FC<BuildsViewProps> = ({ project, isSuperAdmin = false }) => {
  const navigate = useNavigate();
  const { can } = useMyPermissions(project);
  const canRun = isSuperAdmin || can(BUILDS_RUN);

  return (
    <div className={styles.page} {...{ 'data-testid': 'builds-view' }}>
      <div className={styles.header}>
        <h1 className={styles.title}>Builds</h1>
        {canRun && (
          <button
            type="button"
            className={styles.newBuildButton}
            onClick={() => navigate('/builds/new')}
            {...{ 'data-testid': 'builds-new-build-btn' }}
          >
            New build
          </button>
        )}
      </div>
      <p className={styles.emptyState} {...{ 'data-testid': 'builds-empty-state' }}>No builds yet.</p>
    </div>
  );
};

export default BuildsView;
