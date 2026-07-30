import React from 'react';
import { useMyPermissions } from '../hooks/useRbac';
import { useProjectMenuConfig } from '../hooks/useProjectMenuConfig';

interface LoadTestsRouteGuardProps {
  children: React.ReactNode;
  selectedProject: string;
  isSuperAdmin?: boolean;
}

export const LoadTestsRouteGuard: React.FC<LoadTestsRouteGuardProps> = ({
  children,
  selectedProject,
  isSuperAdmin = false,
}) => {
  const { can, isLoading: permLoading } = useMyPermissions(selectedProject);
  const { enabledViews, isLoading: menuLoading } = useProjectMenuConfig(selectedProject);

  const isLoading = permLoading || menuLoading;
  if (isLoading) return null;

  const hasPermission = isSuperAdmin || can('load-test:view');
  const isMenuVisible = isSuperAdmin || enabledViews.includes('load-tests');
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
