/**
 * Statistics for Skill Learning: judge–human agreement, confidence intervals and
 * the minimum sample before a comparison is shown as meaningful. Pure functions.
 */

import type { SkillLearningTrustBand } from '../../shared/types/skillHealth';

/** Pairs needed before an agreement figure is used to trust or distrust the judge. */
export const MIN_AGREEMENT_PAIRS = 20;
/** Documents needed per version before a version comparison is shown as meaningful. */
export const MIN_VERSION_SAMPLE = 10;

export const TRUST_BAND_GATE_KAPPA = 0.6;
export const TRUST_BAND_ADVISORY_KAPPA = 0.4;

const SCALE_MIN = 1;
const SCALE_MAX = 5;

/**
 * Quadratic weighted Cohen's kappa for paired 1–5 ratings. Returns null with
 * fewer than two pairs or when the ratings leave no room for disagreement by
 * chance (both raters used one identical score throughout).
 */
export function quadraticWeightedKappa(pairs: ReadonlyArray<readonly [number, number]>): number | null {
  const valid = pairs.filter(([a, b]) => isScaleScore(a) && isScaleScore(b));
  if (valid.length < 2) return null;
  const k = SCALE_MAX - SCALE_MIN + 1;
  const observed = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const rowTotals = new Array<number>(k).fill(0);
  const colTotals = new Array<number>(k).fill(0);
  for (const [a, b] of valid) {
    const i = a - SCALE_MIN;
    const j = b - SCALE_MIN;
    observed[i][j] += 1;
    rowTotals[i] += 1;
    colTotals[j] += 1;
  }
  const n = valid.length;
  let observedDisagreement = 0;
  let expectedDisagreement = 0;
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < k; j += 1) {
      const weight = ((i - j) ** 2) / ((k - 1) ** 2);
      observedDisagreement += weight * observed[i][j];
      expectedDisagreement += weight * (rowTotals[i] * colTotals[j]) / n;
    }
  }
  if (expectedDisagreement === 0) return null;
  return 1 - observedDisagreement / expectedDisagreement;
}

export function trustBand(kappa: number | null, pairs: number): SkillLearningTrustBand {
  if (kappa === null || pairs < MIN_AGREEMENT_PAIRS) return 'insufficient_data';
  if (kappa >= TRUST_BAND_GATE_KAPPA) return 'gate';
  if (kappa >= TRUST_BAND_ADVISORY_KAPPA) return 'advisory';
  return 'untrusted';
}

export interface Interval {
  low: number;
  high: number;
}

/** 95% Wilson score interval for a proportion; null when there are no trials. */
export function wilsonInterval(successes: number, trials: number): Interval | null {
  if (trials <= 0) return null;
  const z = 1.96;
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = (p + (z * z) / (2 * trials)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / denominator;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

/** Two-sided 95% Student t critical values for 1–30 degrees of freedom. */
const T_CRITICAL_95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
  2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

/** 95% interval for a mean (Student t); null with fewer than two values. */
export function meanInterval(values: readonly number[]): Interval | null {
  if (values.length < 2) return null;
  const n = values.length;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1);
  const df = n - 1;
  const t = df <= T_CRITICAL_95.length ? T_CRITICAL_95[df - 1] : 1.96;
  const margin = t * Math.sqrt(variance / n);
  return { low: mean - margin, high: mean + margin };
}

function isScaleScore(value: number): boolean {
  return Number.isInteger(value) && value >= SCALE_MIN && value <= SCALE_MAX;
}
