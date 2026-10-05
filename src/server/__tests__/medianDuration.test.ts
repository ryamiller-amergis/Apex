/**
 * Unit tests for the shared median-duration helper (FEAT-001 / TBI-002).
 * Pure function — no database, no mocks.
 */

import { computeMedianDays } from '../services/medianDuration';

const sample = (createdAt: string, doneAt: string) => ({ createdAt, doneAt });

describe('medianDuration.computeMedianDays', () => {
  it('TBI-002 DoD-0 returns the middle span for an odd-length sample', () => {
    const result = computeMedianDays([
      sample('2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z'), // 1 day
      sample('2026-08-01T00:00:00Z', '2026-08-04T00:00:00Z'), // 3 days
      sample('2026-08-01T00:00:00Z', '2026-08-11T00:00:00Z'), // 10 days
    ]);

    expect(result).toBe(3);
  });

  it('TBI-002 DoD-0 averages the two middle spans for an even-length sample', () => {
    const result = computeMedianDays([
      sample('2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z'), // 1 day
      sample('2026-08-01T00:00:00Z', '2026-08-03T00:00:00Z'), // 2 days
      sample('2026-08-01T00:00:00Z', '2026-08-04T00:00:00Z'), // 3 days
      sample('2026-08-01T00:00:00Z', '2026-08-05T00:00:00Z'), // 4 days
    ]);

    expect(result).toBe(2.5);
  });

  it('TBI-002 DoD-0 orders spans before picking the median', () => {
    const result = computeMedianDays([
      sample('2026-08-01T00:00:00Z', '2026-08-11T00:00:00Z'), // 10 days
      sample('2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z'), // 1 day
      sample('2026-08-01T00:00:00Z', '2026-08-04T00:00:00Z'), // 3 days
    ]);

    expect(result).toBe(3);
  });

  it('TBI-002 DoD-1 returns null for an empty sample', () => {
    expect(computeMedianDays([])).toBeNull();
  });

  it('TBI-002 DoD-1 returns null when every span is unusable', () => {
    const result = computeMedianDays([
      sample('not-a-date', '2026-08-02T00:00:00Z'),
      sample('2026-08-05T00:00:00Z', '2026-08-01T00:00:00Z'), // done before created
    ]);

    expect(result).toBeNull();
  });

  it('TBI-002 DoD-0 rounds sub-day spans to one decimal place', () => {
    const result = computeMedianDays([
      sample('2026-08-01T00:00:00Z', '2026-08-01T06:00:00Z'), // 0.25 day
    ]);

    expect(result).toBe(0.3);
  });
});
