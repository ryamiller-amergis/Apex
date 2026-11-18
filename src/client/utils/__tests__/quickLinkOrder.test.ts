import {
  applyQuickLinkReorder,
  groupQuickLinks,
  moveQuickLink,
  moveQuickLinkCategory,
} from '../quickLinkOrder';

const link = (id: string, category: string | null, sortOrder: number) => ({ id, category, sortOrder, label: id });

// Azure: a1, a2 · Populus: p1 · Other: o1
const links = [link('a1', 'Azure', 0), link('a2', 'Azure', 1), link('p1', 'Populus', 2), link('o1', null, 3)];

describe('groupQuickLinks', () => {
  it('orders categories by their first link, even when links are not next to each other', () => {
    const groups = groupQuickLinks([link('p1', 'Populus', 0), link('a1', 'Azure', 1), link('p2', 'Populus', 2)]);
    expect(groups.map((g) => [g.category, g.links.map((l) => l.id)])).toEqual([
      ['Populus', ['p1', 'p2']],
      ['Azure', ['a1']],
    ]);
  });
});

describe('moveQuickLinkCategory', () => {
  it('moves a category, with all its links, before another', () => {
    expect(moveQuickLinkCategory(links, 'Populus', 'Azure', 'before')).toEqual({ ids: ['p1', 'a1', 'a2', 'o1'] });
  });

  it('moves a category after another, including the uncategorized group', () => {
    expect(moveQuickLinkCategory(links, 'Azure', null, 'after')).toEqual({ ids: ['p1', 'o1', 'a1', 'a2'] });
  });

  it('returns null when the drop changes nothing', () => {
    expect(moveQuickLinkCategory(links, 'Azure', 'Populus', 'before')).toBeNull();
    expect(moveQuickLinkCategory(links, 'Azure', 'Azure', 'after')).toBeNull();
  });
});

describe('moveQuickLink', () => {
  it('reorders inside a category', () => {
    expect(moveQuickLink(links, 'a2', 'Azure', 'a1')).toEqual({ ids: ['a2', 'a1', 'p1', 'o1'] });
  });

  it('moves a link into another category and reports the move', () => {
    expect(moveQuickLink(links, 'a1', 'Populus', null)).toEqual({
      ids: ['a2', 'p1', 'a1', 'o1'],
      move: { id: 'a1', category: 'Populus' },
    });
  });

  it('drops the source category when its last link leaves', () => {
    expect(moveQuickLink(links, 'p1', 'Azure', 'a2')).toEqual({
      ids: ['a1', 'p1', 'a2', 'o1'],
      move: { id: 'p1', category: 'Azure' },
    });
  });

  it('returns null when the link lands where it already is', () => {
    expect(moveQuickLink(links, 'a1', 'Azure', 'a2')).toBeNull();
    expect(moveQuickLink(links, 'a2', 'Azure', null)).toBeNull();
    expect(moveQuickLink(links, 'a1', 'Azure', 'a1')).toBeNull();
  });
});

describe('applyQuickLinkReorder', () => {
  it('returns the list in the new order with fresh positions and the moved category', () => {
    const next = applyQuickLinkReorder(links, { ids: ['p1', 'a1', 'a2', 'o1'], move: { id: 'o1', category: 'Azure' } });
    expect(next.map((l) => [l.id, l.sortOrder, l.category])).toEqual([
      ['p1', 0, 'Populus'],
      ['a1', 1, 'Azure'],
      ['a2', 2, 'Azure'],
      ['o1', 3, 'Azure'],
    ]);
  });
});
