import React from 'react';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import { useAppShell } from '../hooks/useAppShell';
import { RELEASE_CAB_REQUEST_FLAG } from '../utils/cabReleaseKickoff';

interface ReleaseCabRequestActionProps {
  project: string;
  onClick: () => void;
  'data-testid'?: string;
}

export const ReleaseCabRequestAction: React.FC<ReleaseCabRequestActionProps> = ({
  project,
  onClick,
  'data-testid': dataTestId = 'release-create-cab-action',
}) => {
  const flagEnabled = useFeatureFlag(RELEASE_CAB_REQUEST_FLAG, project);
  const { can, isInAnyGroup, permissionsLoaded } = useAppShell();

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
