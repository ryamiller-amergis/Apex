import React from 'react';
import styles from './agentChat.module.css';

export interface AgentPreparationStateProps {
  /** Whether this is an error state (shows error icon instead of spinner). */
  isError?: boolean;
  /** Title text. Default: "Preparing your session" / "Unable to prepare this session". */
  title?: string;
  /** Detail / progress message below the title. */
  detail?: string;
  /** Additional CSS class. */
  className?: string;
}

export const AgentPreparationState: React.FC<AgentPreparationStateProps> = ({
  isError = false,
  title,
  detail,
  className,
}) => {
  const defaultTitle = isError ? 'Unable to prepare this session' : 'Preparing your session';
  const defaultDetail = isError
    ? 'Preparation was interrupted. Try sending your message again.'
    : 'Getting the latest requirements so your session starts with current context…';

  return (
    <div
      className={`${styles.preparationState} ${className ?? ''}`}
      role={isError ? 'alert' : 'status'}
      aria-live="polite"
      {...{ 'data-testid': 'agent-preparation-state' }}
    >
      {isError ? (
        <div className={styles.preparationErrorIcon}>!</div>
      ) : (
        <div className={styles.preparationSpinner} />
      )}
      <h2 className={styles.preparationTitle}>{title ?? defaultTitle}</h2>
      <p className={styles.preparationDetail}>{detail ?? defaultDetail}</p>
    </div>
  );
};
