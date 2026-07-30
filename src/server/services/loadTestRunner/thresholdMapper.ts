import type { Threshold, ThresholdResult } from '../../../shared/types/loadTest';

type K6MetricLike = {
  thresholds?: Record<string, { ok?: boolean } | boolean>;
  values?: Record<string, number>;
  type?: string;
  contains?: string;
  [key: string]: unknown;
};

type K6SummaryLike = {
  metrics?: Record<string, K6MetricLike>;
};

const NON_VALUE_KEYS = new Set(['thresholds', 'type', 'contains', 'values']);

/**
 * k6 --summary-export (v0.54 / legacy) stores trend/rate stats as flat fields on
 * the metric (`avg`, `p(95)`, `rate`, …) and threshold results as bare booleans
 * where `true` means "threshold exceeded" (failed).
 *
 * handleSummary / newer machine-readable summaries nest stats under `.values`
 * and use `{ ok: boolean }` (ok=true means passed).
 *
 * Normalize both shapes into { values, thresholds: { expr: { ok } } }.
 */
export function normalizeK6Metric(metric: K6MetricLike | undefined): {
  values: Record<string, number>;
  thresholds: Record<string, { ok: boolean }>;
} {
  if (!metric || typeof metric !== 'object') {
    return { values: {}, thresholds: {} };
  }

  const values: Record<string, number> = {};
  if (metric.values && typeof metric.values === 'object') {
    for (const [k, v] of Object.entries(metric.values)) {
      if (typeof v === 'number' && Number.isFinite(v)) values[k] = v;
    }
  } else {
    // Legacy --summary-export: numeric fields live on the metric itself.
    for (const [k, v] of Object.entries(metric)) {
      if (NON_VALUE_KEYS.has(k)) continue;
      if (typeof v === 'number' && Number.isFinite(v)) values[k] = v;
    }
  }

  const thresholds: Record<string, { ok: boolean }> = {};
  const rawThresholds = metric.thresholds;
  if (rawThresholds && typeof rawThresholds === 'object') {
    for (const [expr, raw] of Object.entries(rawThresholds)) {
      if (typeof raw === 'boolean') {
        // Legacy: true = exceeded (failed) → ok is the inverse.
        thresholds[expr] = { ok: !raw };
      } else if (raw && typeof raw === 'object' && typeof raw.ok === 'boolean') {
        thresholds[expr] = { ok: raw.ok };
      }
    }
  }

  return { values, thresholds };
}

/** Pull the observed value that matches the threshold expression when possible. */
export function extractObservedValue(
  expression: string,
  values: Record<string, number> | undefined,
): number | undefined {
  if (!values) return undefined;

  const percentile = expression.match(/p\(\s*\d+\s*\)/i)?.[0]?.replace(/\s+/g, '');
  if (percentile) {
    const key = Object.keys(values).find(
      (k) => k.replace(/\s+/g, '').toLowerCase() === percentile.toLowerCase(),
    );
    if (key != null && values[key] != null) return values[key];
  }

  if (/\brate\b/i.test(expression) && values.rate != null) return values.rate;
  if (/\bavg\b/i.test(expression) && values.avg != null) return values.avg;
  if (/\bmed\b/i.test(expression) && values.med != null) return values.med;
  if (/\bmax\b/i.test(expression) && values.max != null) return values.max;
  if (/\bmin\b/i.test(expression) && values.min != null) return values.min;
  if (/\bvalue\b/i.test(expression) && values.value != null) return values.value;

  return (
    values.rate ??
    values['p(95)'] ??
    values['p(99)'] ??
    values.value ??
    values.avg
  );
}

export function summaryHasMetrics(summary: K6SummaryLike | null | undefined): boolean {
  const metrics = summary?.metrics;
  return Boolean(metrics && Object.keys(metrics).length > 0);
}

/**
 * Map Apex client_thresholds + k6 summary JSON into ThresholdResult[].
 * Accepts both legacy --summary-export and handleSummary shapes.
 * Missing ok flags are marked evaluated:false — callers must treat that as
 * incomplete data (errored), not an SLO Fail.
 */
export function mapK6ThresholdResults(
  clientThresholds: Threshold[],
  summary: K6SummaryLike | null | undefined,
): ThresholdResult[] {
  return clientThresholds.map((t) => {
    const normalized = normalizeK6Metric(summary?.metrics?.[t.metric]);
    const thresholdOk = normalized.thresholds[t.expression]?.ok;
    const observed = extractObservedValue(t.expression, normalized.values);
    const evaluated = typeof thresholdOk === 'boolean';

    return {
      metric: t.metric,
      expression: t.expression,
      passed: thresholdOk === true,
      observed,
      evaluated,
    };
  });
}
