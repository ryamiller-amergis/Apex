/**
 * Median duration helper for artifact cycle time (FEAT-001 / TBI-002).
 *
 * Pure: the caller supplies each artifact's creation instant and its frozen done
 * event, so a recomputation over the same events always returns the same median.
 */

export interface DurationSample {
  createdAt: string;
  /** Frozen done event — see `artifactDoneEvents`. */
  doneAt: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Days between creation and the done event, or null when the span is unusable. */
export function spanInDays(sample: DurationSample): number | null {
  const start = Date.parse(sample.createdAt);
  const end = Date.parse(sample.doneAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const ms = end - start;
  if (ms < 0) return null;
  return ms / MS_PER_DAY;
}

/**
 * Median span in days, rounded to one decimal. Returns null for an empty sample
 * (no completed items in the window) so the caller can render an explicit empty
 * state instead of a misleading 0.
 */
export function computeMedianDays(samples: DurationSample[]): number | null {
  const days = samples
    .map(spanInDays)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  if (days.length === 0) return null;

  const mid = Math.floor(days.length / 2);
  const median = days.length % 2 === 1 ? days[mid] : (days[mid - 1] + days[mid]) / 2;

  return Math.round(median * 10) / 10;
}
