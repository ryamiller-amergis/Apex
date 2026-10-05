import React from 'react';
import { DEV_ENV_ACCESS_DENIED_MESSAGE } from '../../shared/types/devEnvAllowlist';
import styles from './DevEnvAccessDenied.module.css';

interface DevEnvAccessDeniedProps {
  onLogout: () => void;
}

export const DevEnvAccessDenied: React.FC<DevEnvAccessDeniedProps> = ({ onLogout }) => {
  return (
    <div className={styles.page}>
      <div className={styles.card} role="alert" {...{ 'data-testid': 'dev-env-access-denied' }}>
        <h1 className={styles.title}>Dev access required</h1>
        <p className={styles.body}>
          {DEV_ENV_ACCESS_DENIED_MESSAGE} Ask a platform admin to add your email, then sign in again.
        </p>
        <button
          type="button"
          className={styles.button}
          onClick={onLogout}
          {...{ 'data-testid': 'dev-env-access-denied-sign-out' }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
};
