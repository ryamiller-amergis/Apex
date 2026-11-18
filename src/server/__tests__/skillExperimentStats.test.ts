import { describe, expect, it } from '@jest/globals';
import {
  decideExperiment,
  HOLDOUT_SHARE,
  MIN_EXPERIMENT_PAIRS,
  overallFromCriteria,
  splitForCase,
  splitResult,
  type ScoredExperimentRun,
} from '../services/skillExperimentStats';
import type { SkillExperimentCriteriaScores } from '../../shared/types/skillExperiment';

const flat = (score: number): SkillExperimentCriteriaScores => ({
  intent_alignment: score,
  requirements_coverage: score,
  scope_alignment: score,
  acceptance_criteria: score,
  readiness: score,
});

function pair(
  caseKey: string,
  baseline: number,
  candidate: number,
  split: 'dev' | 'holdout' = 'dev',
): ScoredExperimentRun[] {
  return [
    { caseKey, split, arm: 'baseline', overallScore: baseline, criteriaScores: flat(baseline), failed: false },
    { caseKey, split, arm: 'candidate', overallScore: candidate, criteriaScores: flat(candidate), failed: false },
  ];
}

const devPairs = (n: number, baseline: number, candidates: number[]) =>
  Array.from({ length: n }, (_, i) => pair(`case-${i}`, baseline, candidates[i % candidates.length])).flat();

describe('splitForCase', () => {
  it('always puts the same case in the same split and holds out about a fifth', () => {
    expect(splitForCase('prd:abc')).toBe(splitForCase('prd:abc'));
    const keys = Array.from({ length: 2000 }, (_, i) => `case-${i}`);
    const holdout = keys.filter((key) => splitForCase(key) === 'holdout').length / keys.length;
    expect(Math.abs(holdout - HOLDOUT_SHARE)).toBeLessThan(0.04);
  });
});

describe('overallFromCriteria', () => {
  it('averages the five criteria', () => {
    expect(overallFromCriteria({ ...flat(4), readiness: 2 })).toBeCloseTo(3.6);
  });
});

describe('splitResult', () => {
  it('pairs only cases scored on both arms and counts wins, losses and ties', () => {
    const runs = [
      ...pair('a', 3, 4),
      ...pair('b', 3, 2),
      ...pair('c', 3, 3.05),
      { caseKey: 'd', split: 'dev' as const, arm: 'baseline' as const, overallScore: 3, criteriaScores: null, failed: false },
    ];
    const result = splitResult(runs, 'dev');
    expect(result.pairs).toBe(3);
    expect([result.wins, result.losses, result.ties]).toEqual([1, 1, 1]);
  });
});

describe('decideExperiment', () => {
  it('waits for enough scored dev pairs', () => {
    const result = decideExperiment(devPairs(MIN_EXPERIMENT_PAIRS - 1, 3, [4]));
    expect(result.verdict).toBe('insufficient_data');
  });

  it('recommends promotion when dev clearly improves and holdout holds', () => {
    const runs = [...devPairs(8, 3, [3.8, 4, 4.2]), ...pair('h1', 3, 3.2, 'holdout'), ...pair('h2', 3, 3, 'holdout')];
    const result = decideExperiment(runs);
    expect(result.verdict).toBe('promote');
    expect(result.dev.diffInterval?.low).toBeGreaterThan(0);
  });

  it('keeps the current Skill when the improvement could be noise', () => {
    const result = decideExperiment(devPairs(8, 3, [4.5, 2, 3.5, 2.5]));
    expect(result.verdict).toBe('keep_current');
    expect(result.reasons[0]).toMatch(/includes no change|did not improve/);
  });

  it('keeps the current Skill when holdout cases drop', () => {
    const runs = [...devPairs(8, 3, [3.8, 4, 4.2]), ...pair('h1', 4, 3, 'holdout'), ...pair('h2', 4, 3.4, 'holdout')];
    const result = decideExperiment(runs);
    expect(result.verdict).toBe('keep_current');
    expect(result.reasons.join(' ')).toMatch(/Holdout cases dropped/);
  });

  it('keeps the current Skill when one criterion gets much worse', () => {
    const runs = devPairs(8, 3, [4]).map((run) =>
      run.arm === 'candidate' ? { ...run, criteriaScores: { ...flat(4.5), readiness: 2 } } : run);
    const result = decideExperiment(runs);
    expect(result.verdict).toBe('keep_current');
    expect(result.reasons.join(' ')).toMatch(/readiness/);
  });

  it('keeps the current Skill when more candidate runs fail', () => {
    const runs = [
      ...devPairs(8, 3, [3.8, 4, 4.2]),
      { caseKey: 'x', split: 'dev' as const, arm: 'candidate' as const, overallScore: null, criteriaScores: null, failed: true },
    ];
    expect(decideExperiment(runs).verdict).toBe('keep_current');
  });
});
