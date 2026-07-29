/**
 * FEAT-005 — App-shell wiring: eligibility + overlay arbitration + progress/miss mutations.
 */
import { useCallback, useMemo } from 'react';
import type {
  UpdateWalkthroughProgressRequest,
  WalkthroughAnchorMiss,
  WalkthroughDefinition,
  WalkthroughRendererCallbacks,
} from '../../shared/types/walkthrough';
import { toWalkthroughRendererDefinition } from '../utils/toWalkthroughRendererDefinition';
import { useAutomaticOverlayCoordinator } from './useAutomaticOverlayCoordinator';
import { useWalkthroughEligibility } from './useWalkthroughEligibility';

export interface UseGuidedWalkthroughOptions {
  projectId: string | null | undefined;
  userId: string | null | undefined;
  enabled?: boolean;
  whatsNewSettled: boolean;
  whatsNewBlocksWalkthrough: boolean;
}

async function putProgress(
  projectId: string,
  walkthroughId: string,
  body: UpdateWalkthroughProgressRequest,
): Promise<void> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/walkthroughs/${encodeURIComponent(walkthroughId)}/progress`,
    {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(`Progress update failed (${res.status})`);
  }
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

export interface UseGuidedWalkthroughResult {
  activeDefinition: WalkthroughDefinition | null;
  rendererDefinition: ReturnType<typeof toWalkthroughRendererDefinition> | null;
  rendererCallbacks: WalkthroughRendererCallbacks;
  clearActive: () => void;
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

  const active = coordinator.activeWalkthrough;
  const clearActive = coordinator.clearActiveWalkthrough;

  const persistSeen = useCallback(
    (walkthroughId: string, revision: number, stepId: string) => {
      if (!projectId) return;
      void putProgress(projectId, walkthroughId, {
        status: 'seen',
        revision,
        lastStepId: stepId,
      }).catch(() => {
        // Observable failure only — do not eject the user from the Step range.
      });
    },
    [projectId],
  );

  const persistLastStep = useCallback(
    (walkthroughId: string, revision: number, stepId: string) => {
      if (!projectId) return;
      void putProgress(projectId, walkthroughId, {
        status: 'seen',
        revision,
        lastStepId: stepId,
      }).catch(() => {
        /* non-blocking */
      });
    },
    [projectId],
  );

  // Fresh callback object each render — avoids React Compiler memoization mismatch.
  const rendererCallbacks: WalkthroughRendererCallbacks = {
    onSeen: ({ walkthroughId, revision, stepId }) => {
      persistSeen(walkthroughId, revision, stepId);
    },
    onStepChange: ({ walkthroughId, revision, stepId }) => {
      persistLastStep(walkthroughId, revision, stepId);
    },
    onComplete: () => {
      // Full complete/dismiss mutation belongs to FEAT-006; close overlay for this load.
      clearActive();
    },
    onDismiss: () => {
      clearActive();
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

  return {
    activeDefinition: active,
    rendererDefinition,
    rendererCallbacks,
    clearActive,
  };
}
