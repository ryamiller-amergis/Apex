import type { ParsedBookmark } from '../parseBookmarksHtml';
import {
  alreadySavedIds,
  folderStats,
  formatCount,
  groupByFolder,
  initialSelection,
  summarizeSelection,
  withSelection,
} from '../bookmarkImportSelection';

function bookmarks(count: number, folder: string[] = ['Bar']): ParsedBookmark[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `bm-${i}`,
    label: `Site ${i}`,
    url: `https://s${i}.example.com/`,
    folderPath: folder,
  }));
}

describe('bookmark import selection', () => {
  const list = [...bookmarks(3, ['Bar']), ...bookmarks(2, ['Bar', 'Tools']).map((b, i) => ({ ...b, id: `t-${i}`, url: `https://t${i}.example.com/` }))];

  it('groups by folder path in first-seen order', () => {
    const folders = groupByFolder(list);
    expect(folders.map((f) => [f.name, f.defaultCategory, f.bookmarks.length])).toEqual([
      ['Bar', 'Bar', 3],
      ['Bar / Tools', 'Tools', 2],
    ]);
  });

  it('marks bookmarks whose URL is already saved', () => {
    expect(alreadySavedIds(list, ['https://s1.example.com/', 'https://t0.example.com/'])).toEqual(new Set(['bm-1', 't-0']));
    expect(alreadySavedIds(list, [])).toEqual(new Set());
  });

  it('selects everything new when it fits, and nothing when it does not', () => {
    const saved = new Set(['bm-0']);
    expect(initialSelection(list, saved, 10)).toEqual(new Set(['bm-1', 'bm-2', 't-0', 't-1']));
    expect(initialSelection(list, saved, 3).size).toBe(0);
  });

  it('never selects already-saved bookmarks', () => {
    const saved = new Set(['bm-0']);
    expect(withSelection(new Set(), ['bm-0', 'bm-1'], true, saved)).toEqual(new Set(['bm-1']));
    expect(withSelection(new Set(['bm-1', 'bm-2']), ['bm-1'], false, saved)).toEqual(new Set(['bm-2']));
  });

  it('counts selected and selectable bookmarks per folder', () => {
    const folders = groupByFolder(list);
    const stats = folderStats(folders, new Set(['bm-1', 't-1']), new Set(['bm-0']));
    expect(stats.get('Bar')).toEqual({ selectable: 2, selected: 1 });
    expect(stats.get('Bar / Tools')).toEqual({ selectable: 2, selected: 1 });
  });

  it('reports how far the selection is over the room left', () => {
    const summary = summarizeSelection(18450, new Set(['a', 'b', 'c', 'saved']), new Set(['saved']), 2);
    expect(summary).toEqual({ selectedCount: 3, total: 18450, alreadySaved: 1, room: 2, overBy: 1 });
    expect(summarizeSelection(10, new Set(['a']), new Set(), 5).overBy).toBe(0);
  });

  it('stays fast for 20,000 bookmarks', () => {
    const many = bookmarks(20000);
    const ids = many.map((b) => b.id);
    const start = Date.now();
    const selected = withSelection(new Set(), ids, true, new Set());
    const summary = summarizeSelection(many.length, selected, new Set(), 1000);
    folderStats(groupByFolder(many), selected, new Set());
    expect(summary.overBy).toBe(19000);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('formats counts with thousands separators', () => {
    expect(formatCount(18450)).toBe('18,450');
  });
});
