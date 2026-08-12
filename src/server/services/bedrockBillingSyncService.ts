/**
 * Bedrock Billing Sync Service
 *
 * Pulls Apex-scoped Amazon Bedrock spend from AWS Cost Explorer, filtered by
 * the IAM principal cost-allocation tag Application=Apex (configurable).
 * Upserts daily totals into bedrock_billing_daily for allocation onto
 * ai_usage_events (provider=bedrock).
 *
 * Ops prerequisite: tag the Apex Bedrock-calling IAM role Application=Apex,
 * activate that tag in Billing, grant ce:GetCostAndUsage.
 */
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  type Expression,
  type ResultByTime,
} from '@aws-sdk/client-cost-explorer';
import { db } from '../db/drizzle';
import { bedrockBillingDaily } from '../db/schema';
import { sql } from 'drizzle-orm';
import type { AiCostSyncProviderResult } from '../../shared/types/aiCostAnalytics';

const LOOKBACK_DAYS = 14;

function tagKey(): string {
  return (process.env.BEDROCK_COST_TAG_KEY?.trim() || 'Application');
}

function tagValue(): string {
  return (process.env.BEDROCK_COST_TAG_VALUE?.trim() || 'Apex');
}

function resolveCeRegion(): string {
  // Cost Explorer is a global endpoint served from us-east-1
  return process.env.AWS_CE_REGION?.trim() || 'us-east-1';
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function buildFilter(): Expression {
  const key = tagKey();
  const value = tagValue();
  // IAM principal cost-allocation tags appear under Cost Explorer's Tags
  // dimension after activation in Billing (key is typically "Application").
  return {
    And: [
      {
        Dimensions: {
          Key: 'SERVICE',
          Values: ['Amazon Bedrock'],
        },
      },
      {
        Tags: {
          Key: key,
          Values: [value],
        },
      },
    ],
  };
}

/** Pure helper — maps CE ResultByTime rows into daily USD amounts. */
export function mapCostExplorerResults(
  results: ResultByTime[] | undefined,
): Array<{ usageDate: string; amountUsd: number; raw: Record<string, unknown> }> {
  const out: Array<{ usageDate: string; amountUsd: number; raw: Record<string, unknown> }> = [];
  for (const row of results ?? []) {
    const start = row.TimePeriod?.Start;
    if (!start) continue;
    const usageDate = start.slice(0, 10);
    let amountUsd = 0;
    for (const group of row.Groups ?? []) {
      amountUsd += parseFloat(group.Metrics?.UnblendedCost?.Amount ?? '0');
    }
    if (!row.Groups?.length) {
      amountUsd = parseFloat(row.Total?.UnblendedCost?.Amount ?? '0');
    }
    out.push({
      usageDate,
      amountUsd,
      raw: {
        timePeriod: row.TimePeriod ?? null,
        estimated: row.Estimated ?? false,
        total: row.Total ?? null,
        groups: row.Groups ?? [],
      },
    });
  }
  return out;
}

export async function runBedrockBillingSync(): Promise<AiCostSyncProviderResult> {
  const end = new Date();
  const start = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const startStr = ymd(start);
  const endStr = ymd(new Date(end.getTime() + 24 * 60 * 60 * 1000)); // CE end exclusive

  const client = new CostExplorerClient({ region: resolveCeRegion() });

  try {
    const filter = buildFilter();
    const res = await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: startStr, End: endStr },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost'],
        Filter: filter,
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      }),
    );

    const days = mapCostExplorerResults(res.ResultsByTime);
    let upserted = 0;

    for (const day of days) {
      const dedupeKey = `bedrock|${day.usageDate}|${tagKey()}=${tagValue()}`;
      await db
        .insert(bedrockBillingDaily)
        .values({
          usageDate: day.usageDate,
          amountUsd: String(day.amountUsd.toFixed(8)),
          currency: 'USD',
          raw: day.raw,
          dedupeKey,
          ingestedAt: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: bedrockBillingDaily.dedupeKey,
          set: {
            amountUsd: String(day.amountUsd.toFixed(8)),
            currency: 'USD',
            raw: day.raw,
            ingestedAt: new Date().toISOString(),
          },
        });
      upserted++;
    }

    console.log(
      `[bedrockBillingSync] Upserted ${upserted} day(s) for tag ${tagKey()}=${tagValue()} (${startStr}..${endStr})`,
    );
    return { ok: true, days: upserted, inserted: upserted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Missing creds / AccessDenied — skip cleanly so Sync Now can still do Cursor
    const skippable =
      /CredentialsProviderError|Could not load credentials|AccessDenied|UnrecognizedClient|NotAuthorized/i.test(
        message,
      );
    if (skippable) {
      console.warn(`[bedrockBillingSync] Skipped: ${message}`);
      return { ok: false, skipped: true, error: message };
    }
    console.error(`[bedrockBillingSync] Failed: ${message}`);
    return { ok: false, error: message };
  }
}

/** Sum billed USD for a date range (inclusive dates as ISO strings). */
export async function sumBedrockBilledUsd(from: string, to: string): Promise<number> {
  const fromDay = from.slice(0, 10);
  const toDay = to.slice(0, 10);
  const rows = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(amount_usd::numeric), 0) AS total
    FROM bedrock_billing_daily
    WHERE usage_date >= ${fromDay} AND usage_date <= ${toDay}
  `);
  return parseFloat(rows.rows[0]?.total ?? '0');
}
