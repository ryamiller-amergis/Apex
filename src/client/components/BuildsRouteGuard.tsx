import React from 'react';
import { Navigate } from 'react-router-dom';
import { canAccessBuilds } from '../utils/canAccessBuilds';

interface BuildsRouteGuardProps {
  children: React.ReactNode;
  can: (key: string) => boolean;
  isSuperAdmin: boolean;
  enabledViews: string[];
  flagEnabled: boolean;
  /** True while the flag, menu or permissions are still loading. */
  isLoading: boolean;
  fallbackPath: string;
}

export const BuildsRouteGuard: React.FC<BuildsRouteGuardProps> = ({
  children,
  can,
  isSuperAdmin,
  enabledViews,
  flagEnabled,
  isLoading,
  fallbackPath,
}) => {
  if (isLoading) return null;
  if (!canAccessBuilds({ can, isSuperAdmin, enabledViews, flagEnabled })) {
    return <Navigate to={fallbackPath} replace />;
  }
  return <>{children}</>;
};

export default BuildsRouteGuard;
