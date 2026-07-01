import type { FeatureRequest } from '../../../shared/types/featureRequest';
import { reorderWithSequentialRanks, sortFeatureRequestsByRank } from '../featureRequestRank';

function makeRequest(id: string, rank: number | null, createdAt: string): FeatureRequest {
  return {
    id,
    title: `Request ${id}`,
    request: 'details',
    advantage: 'benefit',
    submittedBy: 'user-1',
    sourceProject: 'Apex',
    status: 'new',
    aiStatus: 'complete',
    aiPriority: null,
    aiRisk: null,
    aiRationale: null,
    aiThreadId: null,
    teamPriority: null,
    teamRisk: null,
    rank,
    reviewedBy: null,
    createdAt,
    updatedAt: createdAt,
  };
}

describe('reorderWithSequentialRanks', () => {
  const items = [
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
  ];

  it('returns null for no-op or invalid indices', () => {
    expect(reorderWithSequentialRanks(items, 1, 1)).toBeNull();
    expect(reorderWithSequentialRanks(items, -1, 0)).toBeNull();
    expect(reorderWithSequentialRanks(items, 0, 99)).toBeNull();
  });

  it('assigns dense ranks 1..n after moving an item down', () => {
    const result = reorderWithSequentialRanks(items, 0, 2);
    expect(result?.order.map((item) => item.id)).toEqual(['b', 'c', 'a']);
    expect(result?.rankById.get('a')).toBe(3);
    expect(result?.rankById.get('b')).toBe(1);
    expect(result?.rankById.get('c')).toBe(2);
  });

  it('assigns dense ranks 1..n after moving an item up', () => {
    const result = reorderWithSequentialRanks(items, 2, 0);
    expect(result?.order.map((item) => item.id)).toEqual(['c', 'a', 'b']);
    expect(result?.rankById.get('a')).toBe(2);
    expect(result?.rankById.get('b')).toBe(3);
    expect(result?.rankById.get('c')).toBe(1);
  });

  it('renumbers all items when swapping adjacent rows', () => {
    const result = reorderWithSequentialRanks(items, 0, 1);
    expect(result?.order.map((item) => item.id)).toEqual(['b', 'a', 'c']);
    expect([...result!.rankById.values()].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});

describe('sortFeatureRequestsByRank', () => {
  it('sorts by rank ascending with null ranks last', () => {
    const sorted = sortFeatureRequestsByRank([
      makeRequest('c', 3, '2026-07-01T03:00:00Z'),
      makeRequest('a', 1, '2026-07-01T01:00:00Z'),
      makeRequest('b', 2, '2026-07-01T02:00:00Z'),
      makeRequest('d', null, '2026-07-01T04:00:00Z'),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});
