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

/**
 * Map Apex client_thresholds + k6 summary JSON into ThresholdResult[].
 * Prefer k6's own threshold ok flags when present; otherwise mark failed closed.
 */
export function mapK6ThresholdResults(
  clientThresholds: Threshold[],
  summary: K6SummaryLike | null | undefined,
): ThresholdResult[] {
  return clientThresholds.map((t) => {
    const metric = summary?.metrics?.[t.metric];
    const thresholdOk = metric?.thresholds?.[t.expression]?.ok;
    const observed =
      metric?.values?.rate ??
      metric?.values?.['p(95)'] ??
      metric?.values?.['p(99)'] ??
      metric?.values?.value ??
      metric?.values?.avg;

    return {
      metric: t.metric,
      expression: t.expression,
      passed: thresholdOk === true,
      observed,
    };
  });
}
