import React from 'react';
import type { GroundingSurface } from '../../shared/types/runGrounding';

interface RunGroundingStatusProps {
  surface: GroundingSurface;
  domainRunId: string;
  project: string;
}

/**
 * Manual SHA badge / re-ground controls are retired. Pins stay fresh via the
 * overnight idle re-ground pass (`nightlyIdleReGroundService`).
 */
export const RunGroundingStatus: React.FC<RunGroundingStatusProps> = () =>
  null;
