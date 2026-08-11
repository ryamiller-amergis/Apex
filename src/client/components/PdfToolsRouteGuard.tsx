import React from 'react';
import { useMyPermissions } from '../hooks/useRbac';
import { useProjectMenuConfig } from '../hooks/useProjectMenuConfig';

interface PdfToolsRouteGuardProps {
  children: React.ReactNode;
  selectedProject: string;
  isSuperAdmin?: boolean;
  /** When provided (e.g. restricted users), overrides project menu config. */
  menuEnabledViews?: string[];
}

export const PdfToolsRouteGuard: React.FC<PdfToolsRouteGuardProps> = ({
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
  const hasPermission = isSuperAdmin || can('pdf-assembly:use');
  const isMenuVisible = isSuperAdmin || views.includes('pdf-tools');
  const isAuthorized = hasPermission && isMenuVisible;

  if (!isAuthorized) return null;

  return <div data-testid="pdf-tools-route-guard" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>{children}</div>;
};
