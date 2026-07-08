import React from 'react';
import { useMyPermissions } from '../hooks/useRbac';
import { useProjectMenuConfig } from '../hooks/useProjectMenuConfig';

interface PdfToolsRouteGuardProps {
  children: React.ReactNode;
  selectedProject: string;
  isSuperAdmin?: boolean;
}

export const PdfToolsRouteGuard: React.FC<PdfToolsRouteGuardProps> = ({
  children,
  selectedProject,
  isSuperAdmin = false,
}) => {
  const { can, isLoading: permLoading } = useMyPermissions();
  const { enabledViews, isLoading: menuLoading } = useProjectMenuConfig(selectedProject);

  const isLoading = permLoading || menuLoading;

  if (isLoading) return null;

  const hasPermission = isSuperAdmin || can('pdf-assembly:use');
  const isMenuVisible = isSuperAdmin || enabledViews.includes('pdf-tools');
  const isAuthorized = hasPermission && isMenuVisible;

  if (!isAuthorized) return null;

  return <div data-testid="pdf-tools-route-guard">{children}</div>;
};
