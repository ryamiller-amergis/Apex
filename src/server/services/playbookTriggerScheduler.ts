/**
 * Claims due Playbook schedules and retryable receipts.
 * A missed minute stays due until the next occurrence replaces it.
 * A slot from before the subscription was created does not.
 */
import { and, eq, inArray } from 'drizzle-orm';
import pool from '../db';
import { db } from '../db/drizzle';
import { playbookTriggerReceipts, playbookTriggerSubscriptions } from '../db/schema';
import {
  dispatchPlaybookTrigger,
  latestScheduleInstant,
  pendingReceiptIsStale,
  scheduleOccurrenceIsDue,
  storedPlaybookTriggerDispatch,
} from './playbookTriggerDispatchService';
import { renderPlaybookDedupeKey } from '../../shared/utils/playbookTriggerMapping';

const CHECK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Holds the sweep lock on one pooled connection. Drizzle queries use other connections,
 * so the lock and the unlock have to share this client or the lock stays checked out.
 */
export async function withPlaybookTriggerSweepLock(body: () => Promise<void>): Promise<void> {
  const client = await pool.connect();
  let locked = false;
  let unlockError: unknown;
  try {
    const result = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('playbook-trigger-sweep')) AS locked`,
    );
    locked = result.rows[0]?.locked === true;
    if (!locked) return;
    await body();
  } finally {
    if (locked) {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext('playbook-trigger-sweep'))`);
      } catch (error) {
        unlockError = error;
      }
    }
    const releaseError = unlockError instanceof Error
      ? unlockError
      : unlockError
        ? new Error('Playbook trigger sweep unlock failed')
        : undefined;
    client.release(releaseError);
  }
  if (unlockError) {
    throw unlockError instanceof Error ? unlockError : new Error('Playbook trigger sweep unlock failed');
  }
}

export async function sweepPlaybookTriggers(now = new Date()): Promise<void> {
  await withPlaybookTriggerSweepLock(() => sweepPlaybookTriggersUnlocked(now));
}

async function sweepPlaybookTriggersUnlocked(now: Date): Promise<void> {
  const schedules = await db.select().from(playbookTriggerSubscriptions).where(
      eq(playbookTriggerSubscriptions.kind, 'schedule'),
    );
    for (const subscription of schedules) {
      if (!subscription.enabled || subscription.scheduleHour == null || subscription.scheduleMinute == null) {
        continue;
      }
      const instant = latestScheduleInstant(now, subscription.scheduleHour, subscription.scheduleMinute);
      if (!scheduleOccurrenceIsDue(subscription.createdAt, instant)) continue;
      const idempotencyKey = renderPlaybookDedupeKey(subscription.dedupeKeyTemplate, {
        occurrence: instant.toISOString().slice(0, 16),
      });
      const [existing] = await db.select({ id: playbookTriggerReceipts.id }).from(playbookTriggerReceipts).where(and(
        eq(playbookTriggerReceipts.subscriptionId, subscription.id),
        eq(playbookTriggerReceipts.idempotencyKey, idempotencyKey),
        inArray(playbookTriggerReceipts.status, ['started', 'skipped', 'failed', 'dead_letter', 'pending']),
      ));
      if (existing) continue;
      await dispatchPlaybookTrigger({
        subscriptionId: subscription.id,
        source: 'schedule',
        idempotencyKey,
        event: { entityId: subscription.definitionId, actorUserId: subscription.initiatorUserId, data: {} },
      });
    }

    const retries = await db.select().from(playbookTriggerReceipts).where(
      inArray(playbookTriggerReceipts.status, ['retryable', 'pending']),
    );
    for (const receipt of retries) {
      if (receipt.status === 'pending' && !pendingReceiptIsStale(receipt.updatedAt, now.getTime())) continue;
      if (receipt.status === 'retryable' && receipt.nextRetryAt && Date.parse(receipt.nextRetryAt) > now.getTime()) continue;
      const payload = (receipt.payload ?? {}) as Record<string, unknown>;
      const stored = storedPlaybookTriggerDispatch(payload, receipt.source);
      await dispatchPlaybookTrigger({
        subscriptionId: receipt.subscriptionId,
        source: stored.source,
        idempotencyKey: receipt.idempotencyKey,
        event: stored.event,
      });
    }
}

async function sweep(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await sweepPlaybookTriggers();
  } catch (error) {
    console.error('[playbook-trigger] sweep failed', error instanceof Error ? error.message : error);
  } finally {
    running = false;
  }
}

export function startPlaybookTriggerScheduler(): void {
  if (timer) return;
  timer = setInterval(() => { void sweep(); }, CHECK_MS);
  timer.unref?.();
  void sweep();
}

export function stopPlaybookTriggerScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
