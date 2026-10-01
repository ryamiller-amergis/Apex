import { sql } from 'drizzle-orm';
import { db } from '../db/drizzle';

const BASELINE_FEATURES = ['interview', 'prd', 'design-prototype', 'design-doc'] as const;

export interface RfpProposalAiBaseline {
  expectedMonthlyUsd: number;
  observedThrough: string;
  pricedOperationCount: number;
  features: Array<{
    feature: string;
    averageOperationUsd: number;
    operationCount: number;
  }>;
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] } | undefined)?.rows ?? [];
}

/**
 * Uses current catalog rates to reprice observed workflow tokens. The baseline
 * is one average operation for each workflow stage, used as a monthly proxy
 * until an individual request has runtime telemetry.
 */
export async function loadRfpProposalAiBaseline(): Promise<RfpProposalAiBaseline | null> {
  const result = await db.execute(sql`
    WITH current_prices AS (
      SELECT DISTINCT ON (provider, model_id)
        provider,
        model_id,
        input_price_per_mtok::numeric AS input_rate,
        output_price_per_mtok::numeric AS output_rate,
        cache_read_price_per_mtok::numeric AS cache_read_rate,
        cache_write_price_per_mtok::numeric AS cache_write_rate
      FROM ai_pricing
      WHERE effective_to IS NULL
      ORDER BY provider, model_id, effective_from DESC
    ),
    priced_events AS (
      SELECT
        usage.feature,
        usage.created_at,
        CASE
          WHEN usage.feature = 'design-prototype' THEN usage.id::text
          ELSE COALESCE(usage.thread_id, usage.entity_id, usage.run_id, usage.id::text)
        END AS operation_id,
        (
          usage.input_tokens * prices.input_rate
          + usage.output_tokens * prices.output_rate
          + usage.cache_read_tokens * prices.cache_read_rate
          + usage.cache_write_tokens * prices.cache_write_rate
        ) / 1000000 AS event_cost
      FROM ai_usage_events usage
      INNER JOIN current_prices prices
        ON prices.provider = usage.provider
       AND prices.model_id = usage.model_id
      WHERE usage.status = 'success'
        AND usage.feature IN (${sql.join(BASELINE_FEATURES.map((feature) => sql`${feature}`), sql`, `)})
    ),
    operations AS (
      SELECT feature, operation_id, SUM(event_cost) AS operation_cost, MAX(created_at) AS observed_at
      FROM priced_events
      GROUP BY feature, operation_id
    )
    SELECT
      feature,
      COUNT(*)::int AS operation_count,
      AVG(operation_cost)::float8 AS average_operation_usd,
      MAX(observed_at) AS observed_through
    FROM operations
    GROUP BY feature
    ORDER BY feature
  `);

  const rows = resultRows<{
    feature: string;
    operation_count: number | string;
    average_operation_usd: number | string;
    observed_through: string | Date;
  }>(result);
  if (rows.length === 0) return null;

  const features = rows.map((row) => ({
    feature: row.feature,
    averageOperationUsd: Number(row.average_operation_usd),
    operationCount: Number(row.operation_count),
  })).filter((row) => Number.isFinite(row.averageOperationUsd) && row.averageOperationUsd >= 0);
  if (features.length === 0) return null;

  const observedThrough = rows.reduce((latest, row) => {
    const value = new Date(row.observed_through).toISOString();
    return value > latest ? value : latest;
  }, '');

  return {
    expectedMonthlyUsd: features.reduce((sum, row) => sum + row.averageOperationUsd, 0),
    observedThrough,
    pricedOperationCount: features.reduce((sum, row) => sum + row.operationCount, 0),
    features,
  };
}
