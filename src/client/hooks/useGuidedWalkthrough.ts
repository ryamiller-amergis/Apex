/**
 * FEAT-005 + FEAT-006 — App-shell wiring: eligibility + overlay arbitration + progress/miss.
 */
import { useCallback, useMemo, useState } from 'react';
import type {
  UpdateWalkthroughProgressRequest,
  WalkthroughAnchorMiss,
  WalkthroughDefinition,
  WalkthroughProgressStatus,
  WalkthroughRendererCallbacks,
} from '../../shared/types/walkthrough';
import { toWalkthroughRendererDefinition } from '../utils/toWalkthroughRendererDefinition';
import { useAutomaticOverlayCoordinator } from './useAutomaticOverlayCoordinator';
import { useUpdateWalkthroughProgress } from './useWalkthroughReplay';
import { useWalkthroughEligibility } from './useWalkthroughEligibility';

export interface UseGuidedWalkthroughOptions {
  projectId: string | null | undefined;
  userId: string | null | undefined;
  enabled?: boolean;
  whatsNewSettled: boolean;
  whatsNewBlocksWalkthrough: boolean;
}

async function postAnchorMiss(
  projectId: string,
  miss: WalkthroughAnchorMiss,
): Promise<void> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/walkthroughs/${encodeURIComponent(miss.walkthroughId)}/steps/${encodeURIComponent(miss.stepId)}/anchor-misses`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: miss.revision,
        anchorKey: miss.anchorKey,
        targetRoute: miss.targetRoute,
        reason: miss.reason,
      }),
    },
  );
  // Fail-open for UX: miss recording must not block centered fallback (PBI-006 AC-1 / BR-014).
  if (!res.ok) {
    // swallow — caller already fell back
  }
}

export interface GuidedProgressFailure {
  walkthroughId: string;
  body: UpdateWalkthroughProgressRequest;
}

export interface UseGuidedWalkthroughResult {
  activeDefinition: WalkthroughDefinition | null;
  rendererDefinition: ReturnType<typeof toWalkthroughRendererDefinition> | null;
  rendererCallbacks: WalkthroughRendererCallbacks;
  clearActive: () => void;
  progressFailure: GuidedProgressFailure | null;
  progressSubmitting: boolean;
  retryProgressFailure: () => void;
  dismissProgressFailureWithoutAck: () => void;
}

export function useGuidedWalkthrough({
  projectId,
  userId,
  enabled = true,
  whatsNewSettled,
  whatsNewBlocksWalkthrough,
}: UseGuidedWalkthroughOptions): UseGuidedWalkthroughResult {
  const eligibility = useWalkthroughEligibility({
    projectId,
    userId,
    enabled: enabled && Boolean(projectId) && Boolean(userId),
  });

  const coordinator = useAutomaticOverlayCoordinator({
    whatsNewSettled,
    whatsNewBlocksWalkthrough,
    eligibilitySettled: eligibility.isSettled,
    eligibilityError: eligibility.isError,
    candidate: eligibility.candidate,
    enabled,
  });

  const progressMutation = useUpdateWalkthroughProgress(projectId);
  const [progressFailure, setProgressFailure] = useState<GuidedProgressFailure | null>(null);

  const active = coordinator.activeWalkthrough;
  const clearActive = coordinator.clearActiveWalkthrough;

  const persistStatus = useCallback(
    async (
      walkthroughId: string,
      status: WalkthroughProgressStatus,
      revision: number,
      stepId: string,
      opts?: { surfaceFailure?: boolean; closeOnSuccess?: boolean },
    ) => {
      if (!projectId) return;
      const body: UpdateWalkthroughProgressRequest = {
        status,
        revision,
        lastStepId: stepId,
      };
      try {
        await progressMutation.mutateAsync({ walkthroughId, body });
        setProgressFailure(null);
        if (opts?.closeOnSuccess) clearActive();
      } catch {
        if (opts?.surfaceFailure) {
          setProgressFailure({ walkthroughId, body });
        }
      }
    },
    [projectId, progressMutation, clearActive],
  );

  const rendererCallbacks: WalkthroughRendererCallbacks = {
    onSeen: ({ walkthroughId, revision, stepId }) => {
      void persistStatus(walkthroughId, 'seen', revision, stepId);
    },
    onStepChange: ({ walkthroughId, revision, stepId }) => {
      void persistStatus(walkthroughId, 'seen', revision, stepId);
    },
    onComplete: ({ walkthroughId, revision, stepId }) => {
      void persistStatus(walkthroughId, 'completed', revision, stepId, {
        surfaceFailure: true,
        closeOnSuccess: true,
      });
    },
    onDismiss: ({ walkthroughId, revision, stepId }) => {
      void persistStatus(walkthroughId, 'dismissed', revision, stepId, {
        surfaceFailure: true,
        closeOnSuccess: true,
      });
    },
    onAnchorMiss: (payload) => {
      if (!projectId) return;
      void postAnchorMiss(projectId, payload);
    },
  };

  const rendererDefinition = useMemo(
    () => (active ? toWalkthroughRendererDefinition(active) : null),
    [active],
  );

  const retryProgressFailure = useCallback(() => {
    if (!progressFailure) return;
    void persistStatus(
      progressFailure.walkthroughId,
      progressFailure.body.status,
      progressFailure.body.revision,
      progressFailure.body.lastStepId ?? '',
      { surfaceFailure: true, closeOnSuccess: true },
    );
  }, [persistStatus, progressFailure]);

  const dismissProgressFailureWithoutAck = useCallback(() => {
    setProgressFailure(null);
    clearActive();
  }, [clearActive]);

  return {
    activeDefinition: active,
    rendererDefinition,
    rendererCallbacks,
    clearActive,
    progressFailure,
    progressSubmitting: progressMutation.isPending,
    retryProgressFailure,
    dismissProgressFailureWithoutAck,
  };
}
