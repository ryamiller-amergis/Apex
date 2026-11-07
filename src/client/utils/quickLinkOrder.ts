import type { ReorderUserQuickLinksInput } from '../../shared/types/projectQuickLinks';

interface OrderableQuickLink {
  id: string;
  category: string | null;
  sortOrder: number;
}

export interface QuickLinkGroup<T> {
  category: string | null;
  links: T[];
}

export type DropPlacement = 'before' | 'after';

/** Groups links by category, with categories in the order their first link appears. */
export function groupQuickLinks<T extends { category: string | null }>(links: T[]): QuickLinkGroup<T>[] {
  const groups = new Map<string | null, QuickLinkGroup<T>>();
  for (const link of links) {
    const category = link.category ?? null;
    const group = groups.get(category);
    if (group) group.links.push(link);
    else groups.set(category, { category, links: [link] });
  }
  return Array.from(groups.values());
}

function idsOf<T extends { id: string }>(groups: QuickLinkGroup<T>[]): string[] {
  return groups.flatMap((g) => g.links.map((l) => l.id));
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Moves a whole category before or after another. Returns null when nothing changes. */
export function moveQuickLinkCategory<T extends OrderableQuickLink>(
  links: T[],
  category: string | null,
  target: string | null,
  placement: DropPlacement,
): ReorderUserQuickLinksInput | null {
  if (category === target) return null;
  const groups = groupQuickLinks(links);
  const moving = groups.find((g) => g.category === category);
  if (!moving) return null;
  const rest = groups.filter((g) => g !== moving);
  const targetIndex = rest.findIndex((g) => g.category === target);
  if (targetIndex < 0) return null;
  rest.splice(placement === 'before' ? targetIndex : targetIndex + 1, 0, moving);
  const ids = idsOf(rest);
  return sameOrder(ids, idsOf(groups)) ? null : { ids };
}

/**
 * Moves a link into `category`, before the link `beforeId` (or to the end of the category when
 * null). Moving into a different category adds `move`. Returns null when nothing changes.
 */
export function moveQuickLink<T extends OrderableQuickLink>(
  links: T[],
  linkId: string,
  category: string | null,
  beforeId: string | null,
): ReorderUserQuickLinksInput | null {
  if (linkId === beforeId) return null;
  const link = links.find((l) => l.id === linkId);
  if (!link) return null;
  const groups = groupQuickLinks(links);
  const before = idsOf(groups);
  const next = groups
    .map((g) => ({ category: g.category, links: g.links.filter((l) => l.id !== linkId) }))
    .filter((g) => g.links.length > 0 || g.category === category);
  const target = next.find((g) => g.category === category);
  if (!target) return null;
  const insertAt = beforeId === null ? -1 : target.links.findIndex((l) => l.id === beforeId);
  target.links.splice(insertAt < 0 ? target.links.length : insertAt, 0, link);

  const ids = idsOf(next);
  const changesCategory = (link.category ?? null) !== category;
  if (!changesCategory && sameOrder(ids, before)) return null;
  return changesCategory ? { ids, move: { id: linkId, category } } : { ids };
}

/** The list as the server will return it after `plan`, for an instant optimistic update. */
export function applyQuickLinkReorder<T extends OrderableQuickLink>(
  links: T[],
  plan: ReorderUserQuickLinksInput,
): T[] {
  const byId = new Map(links.map((l) => [l.id, l]));
  return plan.ids.flatMap((id, index) => {
    const link = byId.get(id);
    if (!link) return [];
    const category = plan.move?.id === id ? plan.move.category : link.category;
    return [{ ...link, category, sortOrder: index }];
  });
}
