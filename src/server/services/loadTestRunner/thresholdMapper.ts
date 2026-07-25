import type { Threshold, ThresholdResult } from '../../../shared/types/loadTest';

type K6SummaryLike = {
  metrics?: Record<
    string,
    {
      thresholds?: Record<string, { ok?: boolean }>;
      values?: Record<string, number>;
    }
  >;
};

/** Pull the observed value that matches the threshold expression when possible. */
export function extractObservedValue(
  expression: string,
  values: Record<string, number> | undefined,
): number | undefined {
  if (!values) return undefined;

  const percentile = expression.match(/p\(\s*\d+\s*\)/i)?.[0]?.replace(/\s+/g, '');
  if (percentile) {
    const key = Object.keys(values).find((k) => k.replace(/\s+/g, '').toLowerCase() === percentile.toLowerCase());
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
 * Prefer k6's own threshold ok flags when present.
 * Missing ok flags are marked evaluated:false — callers must treat that as
 * incomplete data (errored), not an SLO Fail.
 */
export function mapK6ThresholdResults(
  clientThresholds: Threshold[],
  summary: K6SummaryLike | null | undefined,
): ThresholdResult[] {
  return clientThresholds.map((t) => {
    const metric = summary?.metrics?.[t.metric];
    const thresholdOk = metric?.thresholds?.[t.expression]?.ok;
    const observed = extractObservedValue(t.expression, metric?.values);
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
