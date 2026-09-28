import React from 'react';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import { useAppShell } from '../hooks/useAppShell';
import { useProjectSkillConfig } from '../hooks/useProjectSkillConfig';
import { useSkillList } from '../hooks/useChatThreads';
import {
  CAB_RELEASE_SKILL_NAME,
  CAB_RELEASE_SKILL_PATH,
  RELEASE_CAB_REQUEST_FLAG,
} from '../utils/cabReleaseKickoff';

interface ReleaseCabRequestActionProps {
  project: string;
  onClick: () => void;
  'data-testid'?: string;
}

function hasCabReleaseSkill(skills: { name?: string; path?: string }[]): boolean {
  return skills.some((skill) => {
    const path = (skill.path ?? '').replace(/\\/g, '/').toLowerCase();
    const name = (skill.name ?? '').toLowerCase();
    return name === CAB_RELEASE_SKILL_NAME
      || path.endsWith('/cab-release/skill.md')
      || path.includes(CAB_RELEASE_SKILL_PATH.toLowerCase());
  });
}

export const ReleaseCabRequestAction: React.FC<ReleaseCabRequestActionProps> = ({
  project,
  onClick,
  'data-testid': dataTestId = 'release-create-cab-action',
}) => {
  const flagEnabled = useFeatureFlag(RELEASE_CAB_REQUEST_FLAG, project);
  const { can, isInAnyGroup, permissionsLoaded } = useAppShell();
  const { data: skillConfig } = useProjectSkillConfig(project);
  const { data: skills = [] } = useSkillList(
    project,
    skillConfig?.skillRepo ?? null,
    skillConfig?.skillBranch,
    skillConfig?.skillProvider,
  );

  // @feature-flag:release-cab-request start winner=enabled
  if (!flagEnabled) {
    // @feature-flag:release-cab-request disabled-start
    return null;
    // @feature-flag:release-cab-request disabled-end
  }

  // @feature-flag:release-cab-request enabled-start
  if (!permissionsLoaded) return null;
  if (!can('planning:releases') || !can('chat:create')) return null;
  if (!isInAnyGroup(['BA'])) return null;
  if (!hasCabReleaseSkill(skills)) return null;

  return (
    <button
      type="button"
      className="action-menu-item"
      onClick={onClick}
      {...{ 'data-testid': dataTestId }}
    >
      Create CAB request
    </button>
  );
  // @feature-flag:release-cab-request enabled-end
  // @feature-flag:release-cab-request end
};

export default ReleaseCabRequestAction;
