import { parseFeatureRequestRankings } from '../services/featureRequestRankingService';

describe('parseFeatureRequestRankings', () => {
  it('accepts a complete ordered strict JSON result', () => {
    const result = parseFeatureRequestRankings(
      JSON.stringify([
        {
          id: 'a',
          priority: 'critical',
          rationale: 'Blocks a key customer workflow.',
        },
        {
          id: 'b',
          priority: 'low',
          rationale: 'Has limited current impact.',
        },
      ]),
      ['a', 'b'],
    );
    expect(result.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('accepts a fenced result wrapped in prose', () => {
    const entries = JSON.stringify([
      { id: 'a', priority: 'high', rationale: 'Unblocks onboarding.' },
      { id: 'b', priority: 'low', rationale: 'Can wait a release.' },
    ]);
    const result = parseFeatureRequestRankings(
      `Here is the ranking:\n\`\`\`json\n${entries}\n\`\`\``,
      ['a', 'b'],
    );
    expect(result.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it.each([
    [
      'missing item',
      JSON.stringify([
        { id: 'a', priority: 'high', rationale: 'Important.' },
      ]),
    ],
    [
      'duplicate item',
      JSON.stringify([
        { id: 'a', priority: 'high', rationale: 'Important.' },
        { id: 'a', priority: 'low', rationale: 'Duplicate.' },
      ]),
    ],
    [
      'unknown item',
      JSON.stringify([
        { id: 'a', priority: 'high', rationale: 'Important.' },
        { id: 'c', priority: 'low', rationale: 'Unknown.' },
      ]),
    ],
    [
      'invalid tier',
      JSON.stringify([
        { id: 'a', priority: 'urgent', rationale: 'Important.' },
        { id: 'b', priority: 'low', rationale: 'Later.' },
      ]),
    ],
    ['empty fenced', '```json\n[]\n```'],
    ['prose only', 'I cannot rank these items.'],
  ])('rejects %s output', (_label, text) => {
    expect(() =>
      parseFeatureRequestRankings(text, ['a', 'b']),
    ).toThrow();
  });
});
