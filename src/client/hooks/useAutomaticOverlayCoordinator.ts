/**
 * FEAT-005 / PBI-005 — One load-time arbitration across What's New and Walkthroughs.
 * Makes a single decision per browser document; never stacks or chains overlays.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WalkthroughDefinition } from '../../shared/types/walkthrough';
import { trackEvent } from '../services/telemetry';

export type OverlayCoordinatorDecision =
  | { status: 'pending' }
  | { status: 'suppressed'; reason: 'whats_new' | 'already_decided' | 'no_candidate' | 'eligibility_error' }
  | { status: 'launch'; walkthrough: WalkthroughDefinition };

export interface UseAutomaticOverlayCoordinatorOptions {
  /** What's New bootstrap + changelog evaluation finished. */
  whatsNewSettled: boolean;
  /** What's New will or did auto-open on this load. */
  whatsNewBlocksWalkthrough: boolean;
  /** Eligibility query settled (success or failure). */
  eligibilitySettled: boolean;
  /** True when eligibility failed/timed out/malformed. */
  eligibilityError: boolean;
  /** At most one eligible definition, or null. */
  candidate: WalkthroughDefinition | null;
  enabled?: boolean;
}

export interface UseAutomaticOverlayCoordinatorResult {
  decision: OverlayCoordinatorDecision;
  activeWalkthrough: WalkthroughDefinition | null;
  /** Clear the active renderer without re-arming automatic launch. */
  clearActiveWalkthrough: () => void;
}

/**
 * Waits for What's New + eligibility to settle, then consumes exactly one launch opportunity.
 */
export function useAutomaticOverlayCoordinator({
  whatsNewSettled,
  whatsNewBlocksWalkthrough,
  eligibilitySettled,
  eligibilityError,
  candidate,
  enabled = true,
}: UseAutomaticOverlayCoordinatorOptions): UseAutomaticOverlayCoordinatorResult {
  const decidedRef = useRef(false);
  const [decision, setDecision] = useState<OverlayCoordinatorDecision>({ status: 'pending' });
  const [activeWalkthrough, setActiveWalkthrough] = useState<WalkthroughDefinition | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (decidedRef.current) return;
    if (!whatsNewSettled || !eligibilitySettled) return;

    decidedRef.current = true;

    if (whatsNewBlocksWalkthrough) {
      trackEvent('walkthrough.auto_launch_suppressed', { reason: 'whats_new' });
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot load-time overlay arbitration; must not re-run on later candidate changes
      setDecision({ status: 'suppressed', reason: 'whats_new' });
      setActiveWalkthrough(null);
      return;
    }

    if (eligibilityError) {
      trackEvent('walkthrough.auto_launch_suppressed', { reason: 'eligibility_error' });
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot load-time overlay arbitration
      setDecision({ status: 'suppressed', reason: 'eligibility_error' });
      setActiveWalkthrough(null);
      return;
    }

    if (!candidate) {
      trackEvent('walkthrough.auto_launch_suppressed', { reason: 'no_candidate' });
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot load-time overlay arbitration
      setDecision({ status: 'suppressed', reason: 'no_candidate' });
      setActiveWalkthrough(null);
      return;
    }

    trackEvent('walkthrough.auto_launched', {
      walkthroughId: candidate.id,
      revision: String(candidate.revision),
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot load-time overlay arbitration
    setDecision({ status: 'launch', walkthrough: candidate });
    setActiveWalkthrough(candidate);
  }, [
    enabled,
    whatsNewSettled,
    whatsNewBlocksWalkthrough,
    eligibilitySettled,
    eligibilityError,
    candidate,
  ]);

  const clearActiveWalkthrough = useCallback(() => {
    setActiveWalkthrough(null);
  }, []);

  return {
    decision,
    activeWalkthrough,
    clearActiveWalkthrough,
  };
}
