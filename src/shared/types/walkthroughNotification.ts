/**
 * FEAT-007 — Walkthrough publish notification contracts.
 * Notification type is `system` (operator decision A). Deep link matches FEAT-006 live Help open.
 */

/**
 * Canonical in-app Help / Walkthrough list deep link.
 * Query-only navigation preserves the active project route instead of returning
 * the user to the root project selector.
 */
export const WALKTHROUGH_LIST_DEEP_LINK = '?help=walkthroughs';

/** In-app / Teams preference type for Walkthrough publication events. */
export const WALKTHROUGH_PUBLISH_NOTIFICATION_TYPE = 'system' as const;

export type WalkthroughPublishNotificationMode = 'fresh' | 'reshow';

export type WalkthroughPublishNotificationCommand = {
  walkthroughId: string;
  revision: number;
  mode: WalkthroughPublishNotificationMode;
};

export type WalkthroughNotificationFanoutResult = {
  targeted: number;
  created: number;
  skippedDuplicate: number;
  failed: number;
};

export type WalkthroughNotificationReconcileResult = {
  created: number;
  skippedDuplicate: number;
  failed: number;
};

export function walkthroughPublishDedupeKey(
  walkthroughId: string,
  revision: number,
  userId: string,
): string {
  return `walkthrough-publish:${walkthroughId}:${revision}:${userId}`;
}

export function isWalkthroughPublishNotificationLink(link: string | null | undefined): boolean {
  if (!link) return false;
  return link.includes('help=walkthroughs');
}
