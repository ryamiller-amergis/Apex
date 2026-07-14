import { reorderReleases } from '../releaseOrder';

describe('reorderReleases', () => {
  const items = [
    { id: 1, version: 'v1' },
    { id: 2, version: 'v2' },
    { id: 3, version: 'v3' },
    { id: 4, version: 'v4' },
  ];

  it('moves an item from the start to a later position', () => {
    const result = reorderReleases(items, 0, 2);
    expect(result?.map((i) => i.id)).toEqual([2, 3, 1, 4]);
  });

  it('moves an item from a later position to the start', () => {
    const result = reorderReleases(items, 3, 0);
    expect(result?.map((i) => i.id)).toEqual([4, 1, 2, 3]);
  });

  it('moves an adjacent item down one step', () => {
    const result = reorderReleases(items, 1, 2);
    expect(result?.map((i) => i.id)).toEqual([1, 3, 2, 4]);
  });

  it('returns null when fromIndex equals toIndex', () => {
    expect(reorderReleases(items, 2, 2)).toBeNull();
  });

  it('returns null when fromIndex is out of bounds', () => {
    expect(reorderReleases(items, -1, 1)).toBeNull();
    expect(reorderReleases(items, 4, 1)).toBeNull();
  });

  it('returns null when toIndex is out of bounds', () => {
    expect(reorderReleases(items, 0, -1)).toBeNull();
    expect(reorderReleases(items, 0, 4)).toBeNull();
  });

  it('does not mutate the original array', () => {
    const original = [...items];
    reorderReleases(items, 0, 3);
    expect(items).toEqual(original);
  });

  it('works with a single-element array (no-op)', () => {
    expect(reorderReleases([{ id: 1 }], 0, 0)).toBeNull();
  });
});
