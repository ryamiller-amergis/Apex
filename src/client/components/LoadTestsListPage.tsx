import React from 'react';
import styles from './LoadTestsListPage.module.css';

interface LoadTestsListPageProps {
  project: string;
  canView: boolean;
}

export const LoadTestsListPage: React.FC<LoadTestsListPageProps> = ({ project: _project, canView }) => {
  if (!canView) {
    return (
      <div className={styles.forbidden} data-testid="load-tests-forbidden">
        <p>You do not have permission to view Load Tests.</p>
      </div>
    );
  }

  return (
    <div className={styles.page} data-testid="load-tests-list-page">
      <div className={styles.header}>
        <h1 className={styles.title}>Load Tests</h1>
      </div>
      <div className={styles.empty}>
        <p className={styles.emptyText}>No load tests yet.</p>
        <p className={styles.emptyHint}>
          Load test definitions and run results will appear here once the feature is fully available.
        </p>
      </div>
    </div>
  );
};
