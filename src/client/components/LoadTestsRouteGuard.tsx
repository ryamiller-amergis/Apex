import React from 'react';
import { useMyPermissions } from '../hooks/useRbac';
import { useProjectMenuConfig } from '../hooks/useProjectMenuConfig';

interface LoadTestsRouteGuardProps {
  children: React.ReactNode;
  selectedProject: string;
  isSuperAdmin?: boolean;
  /** When provided (e.g. restricted users), overrides project menu config. */
  menuEnabledViews?: string[];
}

export const LoadTestsRouteGuard: React.FC<LoadTestsRouteGuardProps> = ({
  children,
  selectedProject,
  isSuperAdmin = false,
  menuEnabledViews,
}) => {
  const { can, isLoading: permLoading } = useMyPermissions(selectedProject);
  const { enabledViews, isLoading: menuLoading } = useProjectMenuConfig(
    menuEnabledViews ? null : selectedProject,
  );

  const isLoading = permLoading || (menuEnabledViews ? false : menuLoading);
  if (isLoading) return null;

  const views = menuEnabledViews ?? enabledViews;
  const hasPermission = isSuperAdmin || can('load-test:view');
  const isMenuVisible = isSuperAdmin || views.includes('load-tests');
  const isAuthorized = hasPermission && isMenuVisible;

  if (!isAuthorized) return null;

  return (
    <div
      data-testid="load-tests-route-guard"
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
    >
      {children}
    </div>
  );
};

export default LoadTestsRouteGuard;
