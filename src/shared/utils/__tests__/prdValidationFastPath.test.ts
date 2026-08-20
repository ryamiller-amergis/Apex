import {
  evaluatePrdStructuralValidation,
  hashPrdValidationContent,
  scorecardMatchesContentHash,
} from '../prdValidationFastPath';
import type { ValidationScorecard } from '../../types/interview';

describe('prdValidationFastPath', () => {
  it('hashes content + backlog stably', () => {
    const a = hashPrdValidationContent('hello', { epics: [] });
    const b = hashPrdValidationContent('hello', { epics: [] });
    const c = hashPrdValidationContent('hello!', { epics: [] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('matches scorecard contentHash', () => {
    const content = '## Problem Statement\n…';
    const backlog = { epics: [] };
    const scorecard = {
      contentHash: hashPrdValidationContent(content, backlog),
    } as ValidationScorecard;
    expect(scorecardMatchesContentHash(scorecard, content, backlog)).toBe(true);
    expect(scorecardMatchesContentHash(scorecard, 'changed', backlog)).toBe(false);
  });

  it('fails fast on missing sections and TBD', () => {
    const result = evaluatePrdStructuralValidation(
      '## Intro\n[TBD] stuff',
      { epics: [] },
    );
    expect(result).not.toBeNull();
    expect(result!.is_ready).toBe(false);
    expect(result!.overall_score).toBe(0);
    expect(result!.gaps?.some((g) => g.id.includes('missing'))).toBe(true);
    expect(result!.gaps?.some((g) => g.id === 'tbd-markers')).toBe(true);
    expect(result!.contentHash).toBeTruthy();
  });

  it('returns null when structure looks complete', () => {
    const content = [
      '## Problem Statement',
      'Users need X.',
      '## Proposed Solution',
      'Build Y.',
      '## User Stories',
      'As a user…',
      '## Acceptance Criteria',
      '- Done when…',
    ].join('\n');
    expect(evaluatePrdStructuralValidation(content, { epics: [] })).toBeNull();
  });
});
