import { parseApexWorkItemRankings } from '../services/apexWorkItemRankingService';

describe('parseApexWorkItemRankings', () => {
  it('accepts a complete ordered strict JSON result', () => {
    const result = parseApexWorkItemRankings(
      JSON.stringify([
        { id: 'a', priority: 'critical', rationale: 'Blocks the active release.' },
        { id: 'b', priority: 'low', rationale: 'No current delivery dependency.' },
      ]),
      ['a', 'b'],
    );
    expect(result.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('accepts a fenced result wrapped in prose', () => {
    const entries = JSON.stringify([
      { id: 'a', priority: 'high', rationale: 'Blocks the active release.' },
      { id: 'b', priority: 'low', rationale: 'No current delivery dependency.' },
    ]);
    const result = parseApexWorkItemRankings(
      `Here is the ranking:\n\`\`\`json\n${entries}\n\`\`\``,
      ['a', 'b'],
    );
    expect(result.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it.each([
    ['missing item', JSON.stringify([{ id: 'a', priority: 'high', rationale: 'Important.' }])],
    ['duplicate item', JSON.stringify([
      { id: 'a', priority: 'high', rationale: 'Important.' },
      { id: 'a', priority: 'low', rationale: 'Duplicate.' },
    ])],
    ['invalid tier', JSON.stringify([
      { id: 'a', priority: 'urgent', rationale: 'Important.' },
      { id: 'b', priority: 'low', rationale: 'Later.' },
    ])],
    ['empty fenced', '```json\n[]\n```'],
    ['prose only', 'I cannot rank these items.'],
  ])('rejects %s output', (_label, text) => {
    expect(() => parseApexWorkItemRankings(text, ['a', 'b'])).toThrow();
  });
});
