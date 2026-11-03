import React from 'react';
import { useNavigate } from 'react-router-dom';
import { BRAINSTORM_FLAG, BRAINSTORM_VIEW, BRAINSTORM_CREATE } from '../../shared/types/brainstorm';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import { useProjectMenuConfig } from '../hooks/useProjectMenuConfig';
import { useAppShell } from '../hooks/useAppShell';
import { useCreateBrainstormSession } from '../hooks/useBrainstormSessions';
import styles from './BrainstormHomeEntry.module.css';

interface BrainstormHomeEntryProps {
  project?: string;
}

export const BrainstormHomeEntry: React.FC<BrainstormHomeEntryProps> = ({ project }) => {
  const flagEnabled = useFeatureFlag(BRAINSTORM_FLAG, project);
  const { enabledViews } = useProjectMenuConfig(project ?? null);
  const { can, isSuperAdmin } = useAppShell();

  // @feature-flag:brainstorm start winner=enabled
  if (!flagEnabled) {
    // @feature-flag:brainstorm disabled-start
    return null;
    // @feature-flag:brainstorm disabled-end
  }
  // @feature-flag:brainstorm enabled-start
  const allowed = Boolean(project)
    && enabledViews.includes('brainstorm')
    && (isSuperAdmin || (can(BRAINSTORM_VIEW) && can(BRAINSTORM_CREATE)));
  if (!allowed || !project) return null;
  // data-testid-exempt — BrainstormHomeCard owns brainstorm-home-entry
  return <BrainstormHomeCard project={project} />;
  // @feature-flag:brainstorm enabled-end
  // @feature-flag:brainstorm end
};

const BrainstormHomeCard: React.FC<{ project: string }> = ({ project }) => {
  const navigate = useNavigate();
  const create = useCreateBrainstormSession(project);

  const start = () => {
    create.mutate(undefined, {
      onSuccess: (session) => navigate(`/brainstorm/${encodeURIComponent(session.id)}`),
    });
  };

  return (
    <div className={styles.wrapper}>
      <section className={styles.card} aria-labelledby="brainstorm-home-title" {...{ 'data-testid': 'brainstorm-home-entry' }}>
        <div className={styles.copy}>
          <h2 id="brainstorm-home-title" className={styles.title}>Brainstorm</h2>
          <p className={styles.line}>Explore an idea in open chat</p>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            onClick={start}
            disabled={create.isPending}
            aria-disabled={create.isPending || undefined}
            {...{ 'data-testid': 'brainstorm-start-session' }}
          >
            {create.isPending ? 'Starting…' : 'Start session'}
          </button>
          <button
            type="button"
            className={styles.link}
            onClick={() => navigate('/brainstorm')}
            {...{ 'data-testid': 'brainstorm-view-sessions' }}
          >
            Open Brainstorm
          </button>
        </div>
      </section>
      {create.isError && (
        <div className={styles.error} role="alert" {...{ 'data-testid': 'brainstorm-start-error' }}>
          <span>We could not start a session.</span>
          <button
            type="button"
            className={styles.link}
            onClick={start}
            {...{ 'data-testid': 'brainstorm-start-retry' }}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
};
