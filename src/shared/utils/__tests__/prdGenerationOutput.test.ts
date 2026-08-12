import { isPrdGenerationOutputComplete } from '../prdGenerationOutput';

describe('isPrdGenerationOutputComplete', () => {
  const completeContent = [
    '# Feature PRD',
    '',
    '## Overview',
    'This is a complete PRD body with enough content to pass the stub-length guard used by generation watchers.',
    '',
    '## Requirements',
    'Users can manage rules with clear acceptance criteria and business rules documented here.',
  ].join('\n');

  it('rejects null/empty content and empty backlog objects', () => {
    expect(isPrdGenerationOutputComplete(null, { epics: [{ id: 'E1' }] })).toBe(false);
    expect(isPrdGenerationOutputComplete('', { epics: [{ id: 'E1' }] })).toBe(false);
    expect(isPrdGenerationOutputComplete(completeContent, null)).toBe(false);
    expect(isPrdGenerationOutputComplete(completeContent, {})).toBe(false);
    expect(isPrdGenerationOutputComplete(completeContent, { epics: [] })).toBe(false);
  });

  it('rejects short stub PRD content even when backlog has epics', () => {
    expect(
      isPrdGenerationOutputComplete(
        '# Blackout Date Rule Administration\n\n_Work item #50739_\n',
        { epics: [{ id: 'E1' }] },
      ),
    ).toBe(false);
  });

  it('accepts substantial PRD markdown with at least one epic', () => {
    expect(
      isPrdGenerationOutputComplete(completeContent, {
        epics: [{ id: 'E1', title: 'Epic 1', features: [] }],
      }),
    ).toBe(true);
  });
});
