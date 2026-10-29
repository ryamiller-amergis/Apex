/**
 * Claims due Playbook schedules and retryable receipts.
 * A missed minute stays due until the next occurrence replaces it.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { playbookTriggerReceipts, playbookTriggerSubscriptions } from '../db/schema';
import {
  dispatchPlaybookTrigger,
  latestScheduleInstant,
  storedPlaybookTriggerDispatch,
} from './playbookTriggerDispatchService';
import { renderPlaybookDedupeKey } from '../../shared/utils/playbookTriggerMapping';

const CHECK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function sweepPlaybookTriggers(now = new Date()): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_lock(hashtext('playbook-trigger-sweep'))`);
  try {
    const schedules = await db.select().from(playbookTriggerSubscriptions).where(
      eq(playbookTriggerSubscriptions.kind, 'schedule'),
    );
    for (const subscription of schedules) {
      if (!subscription.enabled || subscription.scheduleHour == null || subscription.scheduleMinute == null) {
        continue;
      }
      const instant = latestScheduleInstant(now, subscription.scheduleHour, subscription.scheduleMinute);
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
      eq(playbookTriggerReceipts.status, 'retryable'),
    );
    for (const receipt of retries) {
      if (receipt.nextRetryAt && Date.parse(receipt.nextRetryAt) > now.getTime()) continue;
      const payload = (receipt.payload ?? {}) as Record<string, unknown>;
      const stored = storedPlaybookTriggerDispatch(payload, receipt.source);
      await dispatchPlaybookTrigger({
        subscriptionId: receipt.subscriptionId,
        source: stored.source,
        idempotencyKey: receipt.idempotencyKey,
        event: stored.event,
      });
    }
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(hashtext('playbook-trigger-sweep'))`);
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
