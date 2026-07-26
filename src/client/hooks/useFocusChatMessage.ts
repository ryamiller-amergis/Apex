import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Transient highlight duration for jump-to-match (BR-007 / assumptions default). */
export const FOCUS_MESSAGE_HIGHLIGHT_MS = 2000;

/**
 * Scrolls to and briefly highlights a message by id (consume-once).
 * Returns the message id that currently has the transient highlight, or null.
 *
 * - Missing id after messages are present → no highlight (PBI-003 AC-1)
 * - No focus id → no scroll/highlight (PBI-003 AC-2 / AC-3)
 * - Defers until `messageIds` is non-empty so late mounts still jump
 */
export function useFocusChatMessage(
  focusMessageId: string | null | undefined,
  messageIds: string[],
): string | null {
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const appliedFocusIdRef = useRef<string | null>(null);
  const messageIdsKey = messageIds.join('\0');

  useLayoutEffect(() => {
    if (!focusMessageId) {
      appliedFocusIdRef.current = null;
      return;
    }
    if (appliedFocusIdRef.current === focusMessageId) return;
    if (messageIds.length === 0) return;

    appliedFocusIdRef.current = focusMessageId;

    if (!messageIds.includes(focusMessageId)) {
      return;
    }

    const safeId = focusMessageId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const el = document.querySelector(
      `[data-message-id="${safeId}"]`,
    ) as HTMLElement | null;
    if (!el) return;

    el.scrollIntoView({ block: 'start' });
    setHighlightedId(focusMessageId);
  // messageIdsKey stands in for messageIds contents (stable across referential churn)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional key stabilization
  }, [focusMessageId, messageIdsKey]);

  useEffect(() => {
    if (!highlightedId) return;
    const timerId = window.setTimeout(() => {
      setHighlightedId(null);
    }, FOCUS_MESSAGE_HIGHLIGHT_MS);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [highlightedId]);

  return highlightedId;
}
