/**
 * FEAT-002 / TBI-004 — Resolve a curated walkthrough anchor target.
 * Validates registry membership, navigates to targetRoute, waits up to ANCHOR_WAIT_MS
 * via immediate query + MutationObserver, and cancels on step/close/unmount.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ANCHOR_WAIT_MS,
  getWalkthroughAnchor,
  isValidInAppWalkthroughRoute,
  validateRegisteredAnchor,
} from '../../shared/walkthroughAnchors';
import type {
  WalkthroughAnchor,
  WalkthroughAnchorMissReason,
} from '../../shared/types/walkthrough';

export type AnchorTargetStatus =
  | 'idle'
  | 'validating'
  | 'navigating'
  | 'waiting'
  | 'resolved'
  | 'fallback';

export interface UseWalkthroughAnchorTargetArgs {
  walkthroughId: string;
  revision: number;
  stepId: string;
  anchor: WalkthroughAnchor | null | undefined;
  /** Bumps when the active step or walkthrough playback changes. */
  activationKey: string;
  enabled?: boolean;
  /** Override bounded wait (tests); defaults to ANCHOR_WAIT_MS. */
  waitMs?: number;
}

export interface UseWalkthroughAnchorTargetResult {
  status: AnchorTargetStatus;
  targetElement: Element | null;
  testId: string | null;
  missReason: WalkthroughAnchorMissReason | null;
  locating: boolean;
}

function queryByTestId(testId: string): Element | null {
  if (typeof document === 'undefined') return null;
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(testId)
      : testId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return document.querySelector(`[data-testid="${escaped}"]`);
}

export function useWalkthroughAnchorTarget({
  walkthroughId: _walkthroughId,
  revision: _revision,
  stepId: _stepId,
  anchor,
  activationKey,
  enabled = true,
  waitMs = ANCHOR_WAIT_MS,
}: UseWalkthroughAnchorTargetArgs): UseWalkthroughAnchorTargetResult {
  const navigate = useNavigate();
  const location = useLocation();
  const [status, setStatus] = useState<AnchorTargetStatus>('idle');
  const [targetElement, setTargetElement] = useState<Element | null>(null);
  const [testId, setTestId] = useState<string | null>(null);
  const [missReason, setMissReason] = useState<WalkthroughAnchorMissReason | null>(null);
  const generationRef = useRef(0);

  const anchorKey = anchor?.key ?? null;
  const anchorRoute = anchor?.targetRoute ?? null;
  const anchorPlacement = anchor?.placement ?? null;

  useEffect(() => {
    const generation = ++generationRef.current;
    const isStale = () => generation !== generationRef.current;

    setTargetElement(null);
    setTestId(null);
    setMissReason(null);

    if (!enabled || !anchorKey || !anchorRoute || !anchorPlacement) {
      setStatus('idle');
      return;
    }

    const anchorValue: NonNullable<WalkthroughAnchor> = {
      key: anchorKey,
      targetRoute: anchorRoute,
      placement: anchorPlacement,
    };

    setStatus('validating');
    const validated = validateRegisteredAnchor(anchorValue);
    if (!validated.ok) {
      const code = validated.errors[0]?.code;
      let reason: WalkthroughAnchorMissReason = 'unregistered';
      if (code === 'INVALID_ROUTE' || code === 'ROUTE_REQUIRED') reason = 'invalid_route';
      else if (code === 'ROUTE_MISMATCH') reason = 'route_mismatch';
      else if (code === 'UNSUPPORTED_PLACEMENT') reason = 'unsupported_placement';
      if (isStale()) return;
      setMissReason(reason);
      setStatus('fallback');
      return;
    }
    if (validated.anchor === null) {
      if (isStale()) return;
      setStatus('idle');
      return;
    }

    const entry = validated.entry;
    if (!isValidInAppWalkthroughRoute(validated.anchor.targetRoute)) {
      if (isStale()) return;
      setMissReason('invalid_route');
      setStatus('fallback');
      return;
    }

    setTestId(entry.testId);

    const currentPath = location.pathname;
    const needsNav = currentPath !== entry.targetRoute;
    if (needsNav) {
      setStatus('navigating');
      navigate(entry.targetRoute);
    }

    setStatus('waiting');

    const finishResolved = (el: Element) => {
      if (isStale()) return;
      setTargetElement(el);
      setMissReason(null);
      setStatus('resolved');
    };

    const finishTimeout = () => {
      if (isStale()) return;
      setTargetElement(null);
      setMissReason('timeout');
      setStatus('fallback');
    };

    const immediate = queryByTestId(entry.testId);
    if (immediate) {
      finishResolved(immediate);
      return;
    }

    let observer: MutationObserver | null = null;
    let timerId: number | null = null;

    if (typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(() => {
        if (isStale()) return;
        const found = queryByTestId(entry.testId);
        if (found) {
          observer?.disconnect();
          if (timerId != null) window.clearTimeout(timerId);
          finishResolved(found);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    timerId = window.setTimeout(() => {
      observer?.disconnect();
      finishTimeout();
    }, waitMs) as unknown as number;

    return () => {
      observer?.disconnect();
      if (timerId != null) window.clearTimeout(timerId);
    };
    // location.pathname intentionally omitted — navigation is initiated here;
    // remount/activationKey drives re-resolution after route change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activationKey, anchorKey, anchorRoute, anchorPlacement, enabled, navigate, waitMs]);

  // After navigation completes, re-query once path matches (without resetting generation).
  useEffect(() => {
    if (status !== 'waiting' && status !== 'navigating') return;
    if (!testId || !anchorKey) return;
    const entry = getWalkthroughAnchor(anchorKey);
    if (!entry) return;
    if (location.pathname !== entry.targetRoute) return;
    const found = queryByTestId(testId);
    if (found) {
      setTargetElement(found);
      setMissReason(null);
      setStatus('resolved');
    }
  }, [location.pathname, status, testId, anchorKey]);

  const locating = status === 'validating' || status === 'navigating' || status === 'waiting';

  return {
    status,
    targetElement,
    testId,
    missReason,
    locating,
  };
}
