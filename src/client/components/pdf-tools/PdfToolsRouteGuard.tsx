import React from 'react';
import { Navigate } from 'react-router-dom';

interface PdfToolsRouteGuardProps {
  can: (key: string) => boolean;
  isMenuEnabled: boolean;
  permissionsLoaded: boolean;
  children: React.ReactNode;
}

export const PdfToolsRouteGuard: React.FC<PdfToolsRouteGuardProps> = ({
  can,
  isMenuEnabled,
  permissionsLoaded,
  children,
}) => {
  if (!permissionsLoaded) return null;

  if (!can('pdf-assembly:use') || !isMenuEnabled) {
    return <Navigate to="/unauthorized" replace />;
  }

  return <>{children}</>;
};
