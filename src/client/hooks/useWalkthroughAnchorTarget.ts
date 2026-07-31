/**
 * FEAT-002 / TBI-004 — Resolve a walkthrough anchor target from enriched catalog metadata.
 * Prefers serve-time `testId` / `useCenteredFallback` on the step anchor so playback
 * does not need a separate catalog request. Falls back to centered modal + miss
 * telemetry for inactive/deleted/missing/unregistered keys.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ANCHOR_WAIT_MS,
  isValidInAppWalkthroughRoute,
} from '../../shared/walkthroughAnchors';
import type {
  WalkthroughAnchor,
  WalkthroughAnchorCatalogFallbackReason,
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
  /** First-class step destination (unanchored steps). Falls back to anchor.targetRoute. */
  stepRoute?: string | null;
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

function looksLikeSelectorSyntax(value: string): boolean {
  return /[#.[\]>+~*=]|^\s*\/\//.test(value) || value.includes(' ');
}

function catalogFallbackToMissReason(
  reason: WalkthroughAnchorCatalogFallbackReason,
): WalkthroughAnchorMissReason {
  return reason;
}

export function useWalkthroughAnchorTarget({
  walkthroughId: _walkthroughId,
  revision: _revision,
  stepId: _stepId,
  anchor,
  stepRoute,
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
  const enrichedTestId = anchor?.testId ?? null;
  const useCenteredFallback = anchor?.useCenteredFallback === true;
  const catalogFallbackReason = anchor?.catalogFallbackReason ?? null;
  const effectiveStepRoute = stepRoute ?? null;

  // Route-first navigation for unanchored steps that carry a route destination.
  useEffect(() => {
    if (!enabled || anchorKey || !effectiveStepRoute) return;
    if (!isValidInAppWalkthroughRoute(effectiveStepRoute)) return;
    if (location.pathname === effectiveStepRoute) return;
    setStatus('navigating');
    navigate(effectiveStepRoute);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activationKey, enabled, anchorKey, effectiveStepRoute, navigate]);

  // Settle navigating → idle once the path matches for unanchored route-only steps.
  useEffect(() => {
    if (!enabled || anchorKey || !effectiveStepRoute) return;
    if (status !== 'navigating') return;
    if (location.pathname === effectiveStepRoute) {
      setStatus('idle');
    }
  }, [enabled, anchorKey, effectiveStepRoute, status, location.pathname]);

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

    setStatus('validating');

    if (looksLikeSelectorSyntax(anchorKey)) {
      if (isStale()) return;
      setMissReason('unregistered');
      setStatus('fallback');
      return;
    }

    if (useCenteredFallback) {
      if (isStale()) return;
      setMissReason(
        catalogFallbackReason
          ? catalogFallbackToMissReason(catalogFallbackReason)
          : 'missing',
      );
      setStatus('fallback');
      return;
    }

    if (!isValidInAppWalkthroughRoute(anchorRoute)) {
      if (isStale()) return;
      setMissReason('invalid_route');
      setStatus('fallback');
      return;
    }

    const resolvedTestId = typeof enrichedTestId === 'string' && enrichedTestId.trim()
      ? enrichedTestId.trim()
      : null;

    if (!resolvedTestId) {
      // No serve-time enrichment — treat as missing catalog resolution.
      if (isStale()) return;
      setMissReason('missing');
      setStatus('fallback');
      return;
    }

    setTestId(resolvedTestId);

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

    // Resolve against the CURRENT route first. Persistent chrome (e.g. the sidebar
    // nav) renders on every page, so if the anchored element is already on screen we
    // must NOT auto-navigate to the anchor's home route — doing so hijacks the user's
    // location (e.g. yanking them to /design-module during step 1 instead of leaving
    // that to the step's CTA). Only navigate when the element is absent here.
    const immediate = queryByTestId(resolvedTestId);
    if (immediate) {
      finishResolved(immediate);
      return;
    }

    const currentPath = location.pathname;
    const needsNav = currentPath !== anchorRoute;
    if (needsNav) {
      setStatus('navigating');
      navigate(anchorRoute);
    }

    setStatus('waiting');

    let observer: MutationObserver | null = null;
    let timerId: number | null = null;

    if (typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(() => {
        if (isStale()) return;
        const found = queryByTestId(resolvedTestId);
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
  }, [
    activationKey,
    anchorKey,
    anchorRoute,
    anchorPlacement,
    enrichedTestId,
    useCenteredFallback,
    catalogFallbackReason,
    enabled,
    navigate,
    waitMs,
  ]);

  // After navigation completes, re-query once path matches (without resetting generation).
  useEffect(() => {
    if (status !== 'waiting' && status !== 'navigating') return;
    if (!testId || !anchorKey || !anchorRoute) return;
    if (location.pathname !== anchorRoute) return;
    const found = queryByTestId(testId);
    if (found) {
      setTargetElement(found);
      setMissReason(null);
      setStatus('resolved');
    }
  }, [location.pathname, status, testId, anchorKey, anchorRoute]);

  const locating = status === 'validating' || status === 'navigating' || status === 'waiting';

  return {
    status,
    targetElement,
    testId,
    missReason,
    locating,
  };
}

