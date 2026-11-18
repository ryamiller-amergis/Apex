import { useCallback, useEffect, useState } from 'react';

export const REORDER_TIP_STORAGE_KEY = 'apex.quickLinks.reorderTip';
/** Visits that show the "drag to reorder" tip before it hides on its own. */
export const REORDER_TIP_MAX_VISITS = 3;
/** Opening Apex again within this window is the same visit, so several tabs in a day count once. */
export const REORDER_TIP_VISIT_GAP_MS = 8 * 60 * 60 * 1000;

interface ReorderTipState {
  visits: number;
  lastVisitAt: number;
  dismissed: boolean;
}

const EMPTY: ReorderTipState = { visits: 0, lastVisitAt: 0, dismissed: false };

function read(): ReorderTipState {
  try {
    const raw = window.localStorage.getItem(REORDER_TIP_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<ReorderTipState>) : {};
    return {
      visits: typeof parsed.visits === 'number' ? parsed.visits : 0,
      lastVisitAt: typeof parsed.lastVisitAt === 'number' ? parsed.lastVisitAt : 0,
      dismissed: parsed.dismissed === true,
    };
  } catch {
    return EMPTY;
  }
}

function write(state: ReorderTipState): void {
  try {
    window.localStorage.setItem(REORDER_TIP_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be full or blocked; the tip then shows for this page load only.
  }
}

/**
 * The "New: drag to reorder" tip for My links. It shows on the user's first
 * REORDER_TIP_MAX_VISITS visits in this browser, or until they dismiss it or reorder something.
 * Visits are counted only while `eligible`, so users without links to reorder keep their views.
 */
export function useQuickLinksReorderTip(eligible: boolean) {
  const [state, setState] = useState<ReorderTipState>(read);

  useEffect(() => {
    if (!eligible) return;
    const current = read();
    const now = Date.now();
    if (current.dismissed || now - current.lastVisitAt < REORDER_TIP_VISIT_GAP_MS) {
      setState(current);
      return;
    }
    const next = { ...current, visits: current.visits + 1, lastVisitAt: now };
    write(next);
    setState(next);
  }, [eligible]);

  const dismiss = useCallback(() => {
    setState((prev) => {
      if (prev.dismissed) return prev;
      const next = { ...prev, dismissed: true };
      write(next);
      return next;
    });
  }, []);

  const visible = eligible && !state.dismissed && state.visits > 0 && state.visits <= REORDER_TIP_MAX_VISITS;
  return { visible, dismiss };
}
