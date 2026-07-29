/**
 * FEAT-005 — Additive app-shell host for automatic guided Walkthrough launch.
 * FEAT-006 — Surfaces custom progress-failure modal on complete/dismiss persistence errors.
 */
import React from 'react';
import { WalkthroughRenderer } from '../components/WalkthroughRenderer';
import { WalkthroughProgressError } from '../components/WalkthroughProgressError';
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

  return (
    <>
      {guided.rendererDefinition ? (
        <div {...{ 'data-testid': 'guided-walkthrough-host' }}>
          <WalkthroughRenderer
            definition={guided.rendererDefinition}
            open
            {...guided.rendererCallbacks}
          />
        </div>
      ) : null}
      <WalkthroughProgressError
        open={Boolean(guided.progressFailure)}
        submitting={guided.progressSubmitting}
        onRetry={guided.retryProgressFailure}
        onCloseWithoutAcknowledgement={guided.dismissProgressFailureWithoutAck}
      />
    </>
  );
};
