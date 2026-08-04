/**
 * FEAT-007 PBI-009 — Walkthrough publish notification fan-out and lazy reconciliation.
 * Audience resolution stays in walkthroughService; delivery uses notificationService.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { walkthroughNotificationDeliveries } from '../db/schema';
import type {
  WalkthroughNotificationFanoutResult,
  WalkthroughNotificationReconcileResult,
  WalkthroughPublishNotificationCommand,
} from '../../shared/types/walkthroughNotification';
import {
  WALKTHROUGH_LIST_DEEP_LINK,
  WALKTHROUGH_PUBLISH_NOTIFICATION_TYPE,
  walkthroughPublishDedupeKey,
} from '../../shared/types/walkthroughNotification';
import { createNotification } from './notificationService';
import { trackEvent } from './telemetry';
import {
  getWalkthroughAdmin,
  listLiveAudienceUserIds,
  listPublishedForUserInProject,
} from './walkthroughService';

const FANOUT_CONCURRENCY = 20;
const TITLE_MAX = 120;
const BODY_MAX = 200;

function sanitizeErrorClass(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name || 'Error';
    return name.slice(0, 64);
  }
  return 'UnknownError';
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function buildPayload(userTitle: string): {
  type: typeof WALKTHROUGH_PUBLISH_NOTIFICATION_TYPE;
  title: string;
  body: string;
  link: string;
} {
  return {
    type: WALKTHROUGH_PUBLISH_NOTIFICATION_TYPE,
    title: truncate('New walkthrough available', TITLE_MAX),
    body: truncate(userTitle, BODY_MAX),
    link: WALKTHROUGH_LIST_DEEP_LINK,
  };
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<'created' | 'duplicate' | 'failed'>,
): Promise<{ created: number; skippedDuplicate: number; failed: number }> {
  let created = 0;
  let skippedDuplicate = 0;
  let failed = 0;
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next;
      next += 1;
      try {
        const result = await fn(items[idx]);
        if (result === 'created') created += 1;
        else if (result === 'duplicate') skippedDuplicate += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return { created, skippedDuplicate, failed };
}

/**
 * Reserve a unique (walkthrough, revision, user) delivery opportunity.
 * Returns the delivery row id when this caller owns the attempt, or null when already delivered/owned.
 */
async function reserveDelivery(
  walkthroughId: string,
  revision: number,
  userId: string,
): Promise<{ deliveryId: string; owned: boolean } | 'duplicate'> {
  const now = new Date().toISOString();

  const inserted = await db
    .insert(walkthroughNotificationDeliveries)
    .values({
      walkthroughId,
      revision,
      userId,
      attemptState: 'pending',
      attemptCount: 0,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [
        walkthroughNotificationDeliveries.walkthroughId,
        walkthroughNotificationDeliveries.revision,
        walkthroughNotificationDeliveries.userId,
      ],
    })
    .returning({ id: walkthroughNotificationDeliveries.id });

  if (inserted[0]) {
    return { deliveryId: inserted[0].id, owned: true };
  }

  const existing = await db.query.walkthroughNotificationDeliveries.findFirst({
    where: and(
      eq(walkthroughNotificationDeliveries.walkthroughId, walkthroughId),
      eq(walkthroughNotificationDeliveries.revision, revision),
      eq(walkthroughNotificationDeliveries.userId, userId),
    ),
  });

  if (!existing) {
    return 'duplicate';
  }

  if (existing.attemptState === 'delivered') {
    return 'duplicate';
  }

  // Retry failed/pending rows — claim ownership for another attempt.
  if (existing.attemptState === 'failed' || existing.attemptState === 'pending') {
    return { deliveryId: existing.id, owned: true };
  }

  return 'duplicate';
}

async function markDelivered(deliveryId: string, notificationId: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(walkthroughNotificationDeliveries)
    .set({
      attemptState: 'delivered',
      notificationId,
      attemptCount: sql`${walkthroughNotificationDeliveries.attemptCount} + 1`,
      lastErrorClass: null,
      updatedAt: now,
    })
    .where(eq(walkthroughNotificationDeliveries.id, deliveryId));
}

async function markFailed(deliveryId: string, err: unknown): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(walkthroughNotificationDeliveries)
    .set({
      attemptState: 'failed',
      attemptCount: sql`${walkthroughNotificationDeliveries.attemptCount} + 1`,
      lastErrorClass: sanitizeErrorClass(err),
      updatedAt: now,
    })
    .where(eq(walkthroughNotificationDeliveries.id, deliveryId));
}

async function deliverToUser(
  walkthroughId: string,
  revision: number,
  userId: string,
  userTitle: string,
): Promise<'created' | 'duplicate' | 'failed'> {
  const reserved = await reserveDelivery(walkthroughId, revision, userId);
  if (reserved === 'duplicate') {
    return 'duplicate';
  }

  try {
    const notification = await createNotification(userId, buildPayload(userTitle), {
      dedupeKey: walkthroughPublishDedupeKey(walkthroughId, revision, userId),
    });
    await markDelivered(reserved.deliveryId, notification.id);
    return 'created';
  } catch (err) {
    await markFailed(reserved.deliveryId, err).catch(() => {});
    trackEvent('walkthrough.notification_delivery.failed', {
      channel: 'in-app',
      errorClass: sanitizeErrorClass(err),
    });
    return 'failed';
  }
}

/**
 * Post-commit fan-out for fresh publish or reshow. Silent updates must not call this.
 */
export async function notifyPublishedAudience(
  command: WalkthroughPublishNotificationCommand,
): Promise<WalkthroughNotificationFanoutResult> {
  const started = Date.now();
  if (command.mode !== 'fresh' && command.mode !== 'reshow') {
    return { targeted: 0, created: 0, skippedDuplicate: 0, failed: 0 };
  }

  const walkthrough = await getWalkthroughAdmin(command.walkthroughId);
  if (walkthrough.lifecycle !== 'published') {
    return { targeted: 0, created: 0, skippedDuplicate: 0, failed: 0 };
  }

  const revision = command.revision;
  const userIds = await listLiveAudienceUserIds(command.walkthroughId);
  const counts = await mapPool(userIds, FANOUT_CONCURRENCY, (userId) =>
    deliverToUser(command.walkthroughId, revision, userId, walkthrough.userTitle),
  );

  const result: WalkthroughNotificationFanoutResult = {
    targeted: userIds.length,
    ...counts,
  };

  trackEvent(
    'walkthrough.notification_fanout.completed',
    {
      walkthroughId: command.walkthroughId,
      revision: String(revision),
      mode: command.mode,
    },
    {
      targeted: result.targeted,
      created: result.created,
      skippedDuplicate: result.skippedDuplicate,
      failed: result.failed,
      duration_ms: Date.now() - started,
    },
  );

  return result;
}

/**
 * Lazy reconciliation when an authenticated user hits eligibility or replay.
 * Creates at most one durable notification per published revision for newly included users.
 */
export async function reconcileForUser(
  userId: string,
  projectId: string,
): Promise<WalkthroughNotificationReconcileResult> {
  const memberships = await listPublishedForUserInProject(userId, projectId);
  let created = 0;
  let skippedDuplicate = 0;
  let failed = 0;

  for (const m of memberships) {
    const outcome = await deliverToUser(m.id, m.revision, userId, m.userTitle);
    if (outcome === 'created') created += 1;
    else if (outcome === 'duplicate') skippedDuplicate += 1;
    else failed += 1;
  }

  if (created > 0 || failed > 0) {
    trackEvent('walkthrough.notification_reconciled', {
      result: created > 0 ? 'created' : 'failed',
    }, {
      created,
      skippedDuplicate,
      failed,
    });
  }

  return { created, skippedDuplicate, failed };
}
