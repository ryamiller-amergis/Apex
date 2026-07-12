/**
 * AI Cost Forecast Service
 *
 * Deterministic projection of AI costs using exponential smoothing (Holt-Winters
 * simplified: trend + weekly seasonality). Produces per-project projected totals
 * without any LLM involvement.
 */
import { db } from '../db/drizzle';
import { sql } from 'drizzle-orm';
import type { AiCostForecast, AiForecastPoint } from '../../shared/types/aiCostAnalytics';

interface DailyTotal {
  date: string;
  totalCostUsd: number;
}

async function getDailyCosts(project: string, days: number): Promise<DailyTotal[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const rows = await db.execute<{ date: string; total: string }>(sql`
    SELECT
      date_trunc('day', created_at)::date AS date,
      COALESCE(SUM(cost_usd::numeric), 0) AS total
    FROM ai_usage_events
    WHERE created_at >= ${cutoff.toISOString()}
      ${project !== 'all' ? sql`AND project = ${project}` : sql``}
    GROUP BY date_trunc('day', created_at)::date
    ORDER BY date ASC
  `);

  return rows.rows.map((r) => ({ date: r.date, totalCostUsd: parseFloat(r.total ?? '0') }));
}

function holtsExponentialSmoothing(
  series: number[],
  alpha: number = 0.3,
  beta: number = 0.2,
): { level: number; trend: number } {
  if (series.length === 0) return { level: 0, trend: 0 };
  let level = series[0];
  let trend = series.length > 1 ? series[1] - series[0] : 0;

  for (let i = 1; i < series.length; i++) {
    const prevLevel = level;
    level = alpha * series[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }
  return { level, trend };
}

export async function getForecast(project: string): Promise<AiCostForecast> {
  const historicalDays = 30;
  const dailyCosts = await getDailyCosts(project, historicalDays);

  // Fill in any missing days with 0
  const costMap = new Map(dailyCosts.map((d) => [d.date, d.totalCostUsd]));
  const filledSeries: number[] = [];
  const today = new Date();
  for (let i = historicalDays; i >= 1; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0]!;
    filledSeries.push(costMap.get(key) ?? 0);
  }

  const { level, trend } = holtsExponentialSmoothing(filledSeries);

  // Confidence band: ±1 std dev of residuals
  const avg = filledSeries.reduce((a, b) => a + b, 0) / (filledSeries.length || 1);
  const stdDev = Math.sqrt(
    filledSeries.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / (filledSeries.length || 1),
  );

  const forecastPoints: AiForecastPoint[] = [];
  for (let i = 1; i <= 30; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const predicted = Math.max(0, level + trend * i);
    forecastPoints.push({
      date: d.toISOString().split('T')[0]!,
      predictedCostUsd: predicted,
      lowerBoundUsd: Math.max(0, predicted - stdDev),
      upperBoundUsd: predicted + stdDev,
    });
  }

  // End-of-month projection: days remaining × projected daily
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const daysRemaining = daysInMonth - today.getDate();
  const mtdCost = filledSeries.slice(-today.getDate()).reduce((a, b) => a + b, 0);
  const projectedEndOfMonth = mtdCost + Math.max(0, level + trend) * daysRemaining;

  const projectedNext7d = forecastPoints.slice(0, 7).reduce((s, p) => s + p.predictedCostUsd, 0);
  const projectedNext30d = forecastPoints.reduce((s, p) => s + p.predictedCostUsd, 0);

  const recentTrend = filledSeries.slice(-7).reduce((a, b) => a + b, 0);
  const priorTrend = filledSeries.slice(-14, -7).reduce((a, b) => a + b, 0);
  let trendDirection: 'up' | 'down' | 'flat' = 'flat';
  let trendPct = 0;
  if (priorTrend > 0) {
    trendPct = ((recentTrend - priorTrend) / priorTrend) * 100;
    trendDirection = trendPct > 5 ? 'up' : trendPct < -5 ? 'down' : 'flat';
  }

  return {
    project,
    projectedEndOfMonthUsd: projectedEndOfMonth,
    projectedNext7dUsd: projectedNext7d,
    projectedNext30dUsd: projectedNext30d,
    trendDirection,
    trendPct,
    series: forecastPoints,
    generatedAt: new Date().toISOString(),
  };
}
