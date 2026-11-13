import { paretoFrontier } from '../services/skillCandidateFrontier';
import type { SkillCandidateFrontierEntry } from '../../shared/types/skillExperiment';

jest.mock('../db/drizzle', () => ({ db: {} }));

function entry(id: string, devMeanDiff: number, clarity: number, failureRate = 0): SkillCandidateFrontierEntry {
  return {
    experimentId: id,
    candidateSha256: id,
    candidateSource: 'reflective',
    candidateContent: id,
    changeNotes: null,
    verdict: 'keep_current',
    devMeanDiff,
    criteria: [{ key: 'clarity' as never, meanDiff: clarity }],
    candidateFailureRate: failureRate,
    createdAt: '2026-11-01',
  };
}

describe('paretoFrontier', () => {
  it('drops candidates beaten on every measure and keeps trade-offs', () => {
    const result = paretoFrontier([
      entry('a', 0.4, 0.1),
      entry('b', 0.1, 0.5),
      entry('c', 0.05, 0.05),
      entry('d', 0.4, 0.1, 0.2),
    ]);
    expect(result.map((e) => e.experimentId)).toEqual(['a', 'b']);
  });

  it('keeps one entry per candidate text and caps the size', () => {
    const many = Array.from({ length: 8 }, (_, i) => entry(`x${i}`, i / 10, 1 - i / 10));
    expect(paretoFrontier([...many, many[0]], 5)).toHaveLength(5);
  });
});
