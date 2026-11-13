import {
  MIN_AGREEMENT_PAIRS,
  meanInterval,
  quadraticWeightedKappa,
  trustBand,
  wilsonInterval,
} from '../services/skillLearningStats';

describe('quadraticWeightedKappa', () => {
  it('is 1 for perfect agreement across several scores', () => {
    expect(quadraticWeightedKappa([[1, 1], [3, 3], [5, 5], [2, 2]])).toBeCloseTo(1);
  });

  it('is negative when raters systematically disagree', () => {
    expect(quadraticWeightedKappa([[1, 5], [5, 1], [2, 4], [4, 2]])).toBeLessThan(0);
  });

  it('penalises a one-point miss less than a four-point miss', () => {
    const near = quadraticWeightedKappa([[1, 2], [3, 3], [5, 5], [2, 2]]);
    const far = quadraticWeightedKappa([[1, 5], [3, 3], [5, 5], [2, 2]]);
    expect(near).not.toBeNull();
    expect(far).not.toBeNull();
    expect(near!).toBeGreaterThan(far!);
  });

  it('matches a hand-computed value', () => {
    // Observed weighted disagreement 0.125, expected 0.5 -> 1 - 0.125 / 0.5.
    expect(quadraticWeightedKappa([[1, 1], [1, 3], [3, 3], [3, 3]])).toBeCloseTo(0.5, 5);
  });

  it('returns null with fewer than two pairs or no chance disagreement', () => {
    expect(quadraticWeightedKappa([[3, 3]])).toBeNull();
    expect(quadraticWeightedKappa([[4, 4], [4, 4], [4, 4]])).toBeNull();
  });

  it('ignores scores outside the 1–5 scale', () => {
    expect(quadraticWeightedKappa([[0, 3], [6, 2], [1, 1], [5, 5]])).toBeCloseTo(1);
  });
});

describe('trustBand', () => {
  it('needs the minimum number of paired reviews', () => {
    expect(trustBand(0.9, MIN_AGREEMENT_PAIRS - 1)).toBe('insufficient_data');
    expect(trustBand(null, 100)).toBe('insufficient_data');
  });

  it('uses the 0.6 and 0.4 kappa bands', () => {
    expect(trustBand(0.6, MIN_AGREEMENT_PAIRS)).toBe('gate');
    expect(trustBand(0.5, MIN_AGREEMENT_PAIRS)).toBe('advisory');
    expect(trustBand(0.39, MIN_AGREEMENT_PAIRS)).toBe('untrusted');
  });
});

describe('intervals', () => {
  it('gives a Wilson interval that stays inside 0–1 and contains the rate', () => {
    const interval = wilsonInterval(9, 10);
    expect(interval).not.toBeNull();
    expect(interval!.low).toBeGreaterThan(0.5);
    expect(interval!.high).toBeLessThanOrEqual(1);
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  it('gives a t interval around the mean and widens with fewer values', () => {
    const small = meanInterval([3, 4, 5]);
    const large = meanInterval([3, 4, 5, 3, 4, 5, 3, 4, 5, 3, 4, 5]);
    expect(small!.low).toBeLessThan(4);
    expect(small!.high).toBeGreaterThan(4);
    expect(small!.high - small!.low).toBeGreaterThan(large!.high - large!.low);
    expect(meanInterval([4])).toBeNull();
  });
});
