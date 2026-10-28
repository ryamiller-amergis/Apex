import React from 'react';
import { useNavigate } from 'react-router-dom';
import { BUILD_FROM_PROMPT_FLAG } from '../../shared/types/featureFlags';
import { BUILDS_RUN } from '../../shared/types/buildAccess';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import { useProjectMenuConfig } from '../hooks/useProjectMenuConfig';
import { useAppShell } from '../hooks/useAppShell';
import { useActiveBuildCount } from '../hooks/useBuilds';
import styles from './BuildAgentHomePill.module.css';

interface BuildAgentHomePillProps {
  project?: string;
}

export const BuildAgentHomePill: React.FC<BuildAgentHomePillProps> = ({ project }) => {
  const navigate = useNavigate();
  const flagEnabled = useFeatureFlag(BUILD_FROM_PROMPT_FLAG, project);
  const { enabledViews } = useProjectMenuConfig(project ?? null);
  const { can, isSuperAdmin } = useAppShell();
  const menuOn = enabledViews.includes('builds');
  const allowed = flagEnabled && menuOn && (isSuperAdmin || can(BUILDS_RUN));
  const count = useActiveBuildCount(project, allowed);
  if (!allowed) return null;

  const total = count.data?.total ?? 0;
  const badge = count.isError || total < 1
    ? null
    : total === 1
      ? '1 build running'
      : `${total} builds running`;

  return (
    <button
      type="button"
      className={styles.pill}
      onClick={() => navigate('/builds/new')}
      {...{ 'data-testid': 'agent-home-build-pill' }}
    >
      Build
      {badge && (
        <span className={styles.badge} aria-live="polite" {...{ 'data-testid': 'agent-home-build-pill-badge' }}>
          {badge}
        </span>
      )}
    </button>
  );
};
