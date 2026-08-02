/**
 * FEAT-002 / TBI-004 — Resolve a walkthrough anchor target from enriched catalog metadata.
 * Prefers serve-time `testId` / `useCenteredFallback` on the step anchor so playback
 * does not need a separate catalog request. Falls back to centered modal + miss
 * telemetry for inactive/deleted/missing/unregistered keys.
 *
 * Phase 1 auto-open: when the target is absent, click serve-time `openers` in order
 * before waiting for the target (modals / menus / tabs).
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
  WalkthroughAnchorOpener,
} from '../../shared/types/walkthrough';

export type AnchorTargetStatus =
  | 'idle'
  | 'validating'
  | 'navigating'
  | 'revealing'
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

function waitForTestId(
  testId: string,
  waitMs: number,
  isStale: () => boolean,
): Promise<Element | null> {
  const immediate = queryByTestId(testId);
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    let settled = false;
    let observer: MutationObserver | null = null;
    let timerId: number | null = null;

    const finish = (el: Element | null) => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      if (timerId != null) window.clearTimeout(timerId);
      resolve(isStale() ? null : el);
    };

    if (typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(() => {
        if (isStale()) {
          finish(null);
          return;
        }
        const found = queryByTestId(testId);
        if (found) finish(found);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    timerId = window.setTimeout(() => {
      finish(queryByTestId(testId));
    }, waitMs) as unknown as number;
  });
}

async function clickOpenersInOrder(
  openers: readonly WalkthroughAnchorOpener[],
  waitMs: number,
  isStale: () => boolean,
): Promise<'ok' | 'opener_missing'> {
  for (const opener of openers) {
    if (isStale()) return 'opener_missing';
    const testId = opener.testId?.trim();
    if (!testId) return 'opener_missing';
    const el = await waitForTestId(testId, waitMs, isStale);
    if (!el || isStale()) return 'opener_missing';
    if (typeof (el as HTMLElement).click === 'function') {
      (el as HTMLElement).click();
    }
  }
  return 'ok';
}

function isWalkthroughDialog(dialog: Element): boolean {
  return dialog.closest('[data-testid="walkthrough-renderer"]') != null;
}

function containingAppDialog(target: Element): HTMLElement | null {
  const dialog = target.closest<HTMLElement>('[role="dialog"][aria-modal="true"]');
  return dialog && !isWalkthroughDialog(dialog) ? dialog : null;
}

function findDialogCloseControl(dialog: HTMLElement): HTMLElement | null {
  return dialog.querySelector<HTMLElement>(
    [
      '[data-testid$="-close"]',
      'button[aria-label="Close"]',
      'button[aria-label^="Close "]',
      '[data-testid$="-cancel"]',
    ].join(', '),
  );
}

function waitForDetached(
  element: Element,
  waitMs: number,
  isStale: () => boolean,
): Promise<boolean> {
  if (!element.isConnected) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    let observer: MutationObserver | null = null;
    let timerId: number | null = null;
    const finish = (detached: boolean) => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      if (timerId != null) window.clearTimeout(timerId);
      resolve(!isStale() && detached);
    };

    if (typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(() => {
        if (isStale()) {
          finish(false);
        } else if (!element.isConnected) {
          finish(true);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    timerId = window.setTimeout(() => finish(!element.isConnected), waitMs);
  });
}

/**
 * A modal that does not contain the next target obscures that target. Close it
 * before resolving the coachmark. This is direction-independent, so Back and
 * Next transitions use the same cleanup path.
 */
async function closeObscuringDialogs(
  target: Element,
  walkthroughOpenedDialogs: Set<HTMLElement>,
  waitMs: number,
  isStale: () => boolean,
): Promise<void> {
  for (const dialog of Array.from(walkthroughOpenedDialogs)) {
    if (!dialog.isConnected) {
      walkthroughOpenedDialogs.delete(dialog);
      continue;
    }
    if (
      dialog.hidden ||
      dialog.getAttribute('aria-hidden') === 'true' ||
      dialog.contains(target)
    ) {
      continue;
    }
    if (isStale()) return;
    const closeControl = findDialogCloseControl(dialog);
    if (!closeControl) continue;
    closeControl.click();
    const detached = await waitForDetached(dialog, waitMs, isStale);
    if (detached) walkthroughOpenedDialogs.delete(dialog);
  }
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
  const walkthroughOpenedDialogsRef = useRef<Set<HTMLElement>>(new Set());

  const anchorKey = anchor?.key ?? null;
  const anchorRoute = anchor?.targetRoute ?? null;
  const anchorPlacement = anchor?.placement ?? null;
  const enrichedTestId = anchor?.testId ?? null;
  const useCenteredFallback = anchor?.useCenteredFallback === true;
  const catalogFallbackReason = anchor?.catalogFallbackReason ?? null;
  const openers = anchor?.openers ?? null;
  const openersKey = JSON.stringify(
    (openers ?? []).map((o) => ({ key: o.key, testId: o.testId })),
  );
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

    const finishTimeout = (reason: WalkthroughAnchorMissReason = 'timeout') => {
      if (isStale()) return;
      setTargetElement(null);
      setMissReason(reason);
      setStatus('fallback');
    };

    let cancelled = false;
    let observer: MutationObserver | null = null;
    let timerId: number | null = null;
    let openerSequenceRan = false;

    const trackWalkthroughOpenedDialog = (el: Element) => {
      if (!openerSequenceRan) return;
      const openedDialog = containingAppDialog(el);
      if (openedDialog) walkthroughOpenedDialogsRef.current.add(openedDialog);
    };

    const startTargetWait = () => {
      if (isStale() || cancelled) return;
      const foundNow = queryByTestId(resolvedTestId);
      if (foundNow) {
        trackWalkthroughOpenedDialog(foundNow);
        finishResolved(foundNow);
        return;
      }

      setStatus('waiting');

      if (typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver(() => {
          if (isStale() || cancelled) return;
          const found = queryByTestId(resolvedTestId);
          if (found) {
            observer?.disconnect();
            if (timerId != null) window.clearTimeout(timerId);
            trackWalkthroughOpenedDialog(found);
            finishResolved(found);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }

      timerId = window.setTimeout(() => {
        observer?.disconnect();
        finishTimeout('timeout');
      }, waitMs) as unknown as number;
    };

    void (async () => {
      // AC-0: target already visible → resolve without openers / without nav.
      const immediate = queryByTestId(resolvedTestId);
      if (immediate) {
        await closeObscuringDialogs(
          immediate,
          walkthroughOpenedDialogsRef.current,
          waitMs,
          () => isStale() || cancelled,
        );
        if (isStale() || cancelled) return;
        finishResolved(queryByTestId(resolvedTestId) ?? immediate);
        return;
      }

      const openerList = Array.isArray(openers)
        ? openers.filter((o) => o && typeof o.testId === 'string' && o.testId.trim())
        : [];

      // AC-1: click openers in order when target is missing.
      if (openerList.length > 0) {
        if (isStale() || cancelled) return;
        setStatus('revealing');
        const openerResult = await clickOpenersInOrder(openerList, waitMs, () =>
          isStale() || cancelled,
        );
        if (isStale() || cancelled) return;
        if (openerResult === 'opener_missing') {
          // AC-2
          finishTimeout('opener_missing');
          return;
        }
        openerSequenceRan = true;
        const afterOpeners = queryByTestId(resolvedTestId);
        if (afterOpeners) {
          trackWalkthroughOpenedDialog(afterOpeners);
          await closeObscuringDialogs(
            afterOpeners,
            walkthroughOpenedDialogsRef.current,
            waitMs,
            () => isStale() || cancelled,
          );
          if (isStale() || cancelled) return;
          finishResolved(afterOpeners);
          return;
        }
      }

      const currentPath = location.pathname;
      const needsNav = currentPath !== anchorRoute;
      if (needsNav) {
        setStatus('navigating');
        navigate(anchorRoute);
      }

      startTargetWait();
    })();

    return () => {
      cancelled = true;
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
    openersKey,
    enabled,
    navigate,
    waitMs,
  ]);

  // After navigation completes, re-query once path matches (without resetting generation).
  useEffect(() => {
    if (status !== 'waiting' && status !== 'navigating' && status !== 'revealing') return;
    if (!testId || !anchorKey || !anchorRoute) return;
    if (location.pathname !== anchorRoute) return;
    const found = queryByTestId(testId);
    if (found) {
      setTargetElement(found);
      setMissReason(null);
      setStatus('resolved');
    }
  }, [location.pathname, status, testId, anchorKey, anchorRoute]);

  // AC-3: revealing counts as locating
  const locating =
    status === 'validating' ||
    status === 'navigating' ||
    status === 'revealing' ||
    status === 'waiting';

  return {
    status,
    targetElement,
    testId,
    missReason,
    locating,
  };
}
