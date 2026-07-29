/**
 * FEAT-005 — Additive app-shell host for automatic guided Walkthrough launch.
 * Owns eligibility + overlay arbitration + renderer callbacks; mounts beside Changelog.
 */
import React from 'react';
import { WalkthroughRenderer } from '../components/WalkthroughRenderer';
import { useGuidedWalkthrough } from '../hooks/useGuidedWalkthrough';

export interface GuidedWalkthroughHostProps {
  projectId: string | null | undefined;
  userId: string | null | undefined;
  enabled?: boolean;
  whatsNewSettled: boolean;
  whatsNewBlocksWalkthrough: boolean;
}

export const GuidedWalkthroughHost: React.FC<GuidedWalkthroughHostProps> = ({
  projectId,
  userId,
  enabled = true,
  whatsNewSettled,
  whatsNewBlocksWalkthrough,
}) => {
  const guided = useGuidedWalkthrough({
    projectId,
    userId,
    enabled,
    whatsNewSettled,
    whatsNewBlocksWalkthrough,
  });

  if (!guided.rendererDefinition) return null;

  return (
    <div {...{ 'data-testid': 'guided-walkthrough-host' }}>
      <WalkthroughRenderer
        definition={guided.rendererDefinition}
        open
        {...guided.rendererCallbacks}
      />
    </div>
  );
};
