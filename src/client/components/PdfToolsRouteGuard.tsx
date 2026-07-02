import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
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
  const navigate = useNavigate();
  const { can, isLoading: permLoading } = useMyPermissions();
  const { enabledViews, isLoading: menuLoading } = useProjectMenuConfig(selectedProject);

  const isLoading = permLoading || menuLoading;
  const hasPermission = isSuperAdmin || can('pdf-assembly:use');
  const isMenuVisible = isSuperAdmin || enabledViews.includes('pdf-tools');
  const isAuthorized = hasPermission && isMenuVisible;

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthorized) {
      navigate('/home', { replace: true });
    }
  }, [isLoading, isAuthorized, navigate]);

  if (isLoading) return null;
  if (!isAuthorized) return null;

  return <div data-testid="pdf-tools-route-guard">{children}</div>;
};
