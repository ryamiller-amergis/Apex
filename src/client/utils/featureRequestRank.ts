import type { FeatureRequest } from '../../shared/types/featureRequest';

export function reorderWithSequentialRanks<T extends { id: string }>(
  items: T[],
  fromIndex: number,
  toIndex: number,
): { order: T[]; rankById: Map<string, number> } | null {
  if (
    fromIndex === toIndex
    || fromIndex < 0
    || toIndex < 0
    || fromIndex >= items.length
    || toIndex >= items.length
  ) {
    return null;
  }

  const order = [...items];
  const [moved] = order.splice(fromIndex, 1);
  order.splice(toIndex, 0, moved);
  const rankById = new Map(order.map((item, i) => [item.id, i + 1]));
  return { order, rankById };
}

export function sortFeatureRequestsByRank(requests: FeatureRequest[]): FeatureRequest[] {
  return [...requests].sort((a, b) => {
    const ra = a.rank ?? Number.MAX_SAFE_INTEGER;
    const rb = b.rank ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}
