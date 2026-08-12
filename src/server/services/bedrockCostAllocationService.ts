/**
 * Bedrock Cost Allocation Service
 *
 * Distributes daily Apex-scoped Bedrock billed USD (bedrock_billing_daily)
 * across ai_usage_events (provider=bedrock) for that UTC day, proportional
 * to token counts. Sets costSource='allocated'.
 *
 * Days with no billing row leave existing computed catalog costs untouched.
 */
import { db } from '../db/drizzle';
import { aiUsageEvents, bedrockBillingDaily } from '../db/schema';
import { and, eq, gte, lte } from 'drizzle-orm';

const LOOKBACK_DAYS = 14;

export async function runBedrockCostAllocation(): Promise<{ daysAllocated: number }> {
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const days = await db
    .select({
      usageDate: bedrockBillingDaily.usageDate,
      amountUsd: bedrockBillingDaily.amountUsd,
    })
    .from(bedrockBillingDaily)
    .where(gte(bedrockBillingDaily.usageDate, cutoff));

  let daysAllocated = 0;

  for (const day of days) {
    const amountUsd = parseFloat(day.amountUsd ?? '0');
    if (!(amountUsd > 0)) continue;

    const dayStart = `${day.usageDate}T00:00:00.000Z`;
    const dayEnd = `${day.usageDate}T23:59:59.999Z`;

    const events = await db
      .select({
        id: aiUsageEvents.id,
        inputTokens: aiUsageEvents.inputTokens,
        outputTokens: aiUsageEvents.outputTokens,
        cacheReadTokens: aiUsageEvents.cacheReadTokens,
        cacheWriteTokens: aiUsageEvents.cacheWriteTokens,
      })
      .from(aiUsageEvents)
      .where(
        and(
          eq(aiUsageEvents.provider, 'bedrock'),
          gte(aiUsageEvents.createdAt, dayStart),
          lte(aiUsageEvents.createdAt, dayEnd),
        ),
      );

    if (events.length === 0) {
      console.log(
        `[bedrockCostAllocation] ${day.usageDate}: $${amountUsd.toFixed(4)} billed but no bedrock usage rows`,
      );
      continue;
    }

    const totalTokens = events.reduce(
      (sum, e) =>
        sum +
        (e.inputTokens ?? 0) +
        (e.outputTokens ?? 0) +
        (e.cacheReadTokens ?? 0) +
        (e.cacheWriteTokens ?? 0),
      0,
    );

    for (const ev of events) {
      const evTokens =
        (ev.inputTokens ?? 0) +
        (ev.outputTokens ?? 0) +
        (ev.cacheReadTokens ?? 0) +
        (ev.cacheWriteTokens ?? 0);
      const share = totalTokens > 0 ? evTokens / totalTokens : 1 / events.length;
      const allocatedUsd = amountUsd * share;

      await db
        .update(aiUsageEvents)
        .set({
          costUsd: String(allocatedUsd.toFixed(8)),
          costSource: 'allocated',
        })
        .where(eq(aiUsageEvents.id, ev.id));
    }

    daysAllocated++;
    console.log(
      `[bedrockCostAllocation] ${day.usageDate}: distributed $${amountUsd.toFixed(4)} across ${events.length} event(s)`,
    );
  }

  console.log(`[bedrockCostAllocation] Complete — ${daysAllocated} day(s) allocated`);
  return { daysAllocated };
}
