/**
 * AI Cost Allocation Service
 *
 * Distributes the authoritative Cursor chargedCents (from cursor_usage_events)
 * across ai_usage_events (cursor rows) within matching time-buckets,
 * proportional to estimated tokens. Result always sums to the Cursor bill.
 *
 * Run hourly after the billing sync completes.
 *
 * NOTE: Model names in Cursor billing events (e.g. "composer-2.5-fast") often
 * differ from the model IDs used by the SDK (e.g. "composer-2"). We therefore
 * allocate by TIME BUCKET only (not model), distributing the total hourly Apex
 * cost across all Apex runs in that hour proportional to token estimates.
 */
import { db } from '../db/drizzle';
import { aiUsageEvents } from '../db/schema';
import { and, eq, gte, lte, sql } from 'drizzle-orm';

const BUCKET_HOURS = 1;

export async function runCostAllocation(): Promise<void> {
  // Find cursor_usage_events ingested in the last 3 hours
  const windowStart = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

  // Get distinct hour buckets with Apex billing data
  const useSaFilter = !!process.env.CURSOR_SERVICE_ACCOUNT_ID?.trim();
  const saId = process.env.CURSOR_SERVICE_ACCOUNT_ID?.trim();

  const buckets = await db.execute<{
    bucket: string;
    total_charged_cents: string;
  }>(sql`
    SELECT
      date_trunc('hour', ts) AS bucket,
      SUM(charged_cents::numeric) AS total_charged_cents
    FROM cursor_usage_events
    WHERE ingested_at >= ${windowStart}
      ${useSaFilter ? sql`AND service_account_id = ${saId}` : sql`AND is_headless = true`}
    GROUP BY date_trunc('hour', ts)
  `);

  for (const row of buckets.rows) {
    const bucketStart = new Date(row.bucket).toISOString();
    const bucketEnd = new Date(new Date(row.bucket).getTime() + BUCKET_HOURS * 60 * 60 * 1000).toISOString();
    const totalChargedCents = parseFloat(row.total_charged_cents ?? '0');
    if (totalChargedCents <= 0) continue;

    // Get all Apex cursor usage events in this hour bucket
    const events = await db
      .select({
        id: aiUsageEvents.id,
        inputTokens: aiUsageEvents.inputTokens,
        outputTokens: aiUsageEvents.outputTokens,
      })
      .from(aiUsageEvents)
      .where(
        and(
          eq(aiUsageEvents.provider, 'cursor'),
          gte(aiUsageEvents.createdAt, bucketStart),
          lte(aiUsageEvents.createdAt, bucketEnd),
        ),
      );

    if (events.length === 0) continue;

    const totalTokens = events.reduce(
      (sum, e) => sum + (e.inputTokens ?? 0) + (e.outputTokens ?? 0),
      0,
    );

    const totalChargedUsd = totalChargedCents / 100;

    for (const ev of events) {
      const evTokens = (ev.inputTokens ?? 0) + (ev.outputTokens ?? 0);
      const share = totalTokens > 0 ? evTokens / totalTokens : 1 / events.length;
      const allocatedUsd = totalChargedUsd * share;

      await db
        .update(aiUsageEvents)
        .set({
          costUsd: String(allocatedUsd.toFixed(8)),
          costSource: 'allocated',
        })
        .where(eq(aiUsageEvents.id, ev.id));
    }

    console.log(`[aiCostAllocation] Bucket ${row.bucket}: distributed $${totalChargedUsd.toFixed(4)} across ${events.length} event(s)`);
  }

  console.log('[aiCostAllocation] Allocation complete');
}
