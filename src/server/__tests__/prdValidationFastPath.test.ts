import {
  evaluatePrdStructuralValidation,
  hashPrdValidationContent,
  scorecardMatchesContentHash,
} from '../../shared/utils/prdValidationFastPath';
import type { ValidationScorecard } from '../../shared/types/interview';

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

  it('fails fast on empty / TBD / missing core sections', () => {
    const result = evaluatePrdStructuralValidation(
      '## Intro\n[TBD] stuff',
      { epics: [] },
    );
    expect(result).not.toBeNull();
    expect(result!.is_ready).toBe(false);
    expect(result!.overall_score).toBe(0);
    expect(result!.slug).toBe('prd-structural');
    expect(result!.gaps?.some((g) => g.id.includes('missing'))).toBe(true);
    expect(result!.gaps?.some((g) => g.id === 'tbd-markers')).toBe(true);
    expect(result!.contentHash).toBeTruthy();
  });

  it('accepts to-prd shape (Solution, no authored User Stories)', () => {
    const content = [
      '## Problem Statement',
      'Users need X.',
      '## Solution',
      'Build Y on Agent Home.',
      '## Implementation Decisions',
      'Use ADO.',
      '## Testing Decisions',
      'Cover AC.',
    ].join('\n');
    expect(evaluatePrdStructuralValidation(content, { epics: [] })).toBeNull();
  });

  it('accepts Proposed Solution as an alias for Solution', () => {
    const content = [
      '## Problem Statement',
      'Users need X.',
      '## Proposed Solution',
      'Build Y.',
    ].join('\n');
    expect(evaluatePrdStructuralValidation(content, { epics: [] })).toBeNull();
  });

  it('does not require User Stories or Acceptance Criteria headings in markdown', () => {
    const content = [
      '## Problem Statement',
      'Users need X.',
      '## Solution',
      'Build Y.',
    ].join('\n');
    const result = evaluatePrdStructuralValidation(content, { epics: [] });
    expect(result).toBeNull();
  });
});
