import { defaultCategoryFor, type ParsedBookmark } from './parseBookmarksHtml';

/** Above this many bookmarks the preview starts with every folder collapsed. */
export const COLLAPSE_FOLDERS_ABOVE = 500;
/** Rows rendered per expanded folder before a "Show all" button. */
export const FOLDER_RENDER_LIMIT = 200;

export interface BookmarkFolder {
  index: number;
  key: string;
  name: string;
  defaultCategory: string;
  bookmarks: ParsedBookmark[];
}

export function groupByFolder(bookmarks: ParsedBookmark[]): BookmarkFolder[] {
  const folders = new Map<string, BookmarkFolder>();
  for (const bookmark of bookmarks) {
    const key = bookmark.folderPath.join(' / ');
    let folder = folders.get(key);
    if (!folder) {
      folder = {
        index: folders.size,
        key,
        name: key || 'No folder',
        defaultCategory: defaultCategoryFor(bookmark.folderPath),
        bookmarks: [],
      };
      folders.set(key, folder);
    }
    folder.bookmarks.push(bookmark);
  }
  return Array.from(folders.values());
}

/** Ids of bookmarks whose URL is already saved in the destination; they cannot be selected. */
export function alreadySavedIds(bookmarks: ParsedBookmark[], existingUrls: Iterable<string>): Set<string> {
  const urls = new Set(existingUrls);
  const ids = new Set<string>();
  if (urls.size === 0) return ids;
  for (const bookmark of bookmarks) {
    if (urls.has(bookmark.url)) ids.add(bookmark.id);
  }
  return ids;
}

/**
 * Starting selection: everything new if it fits in the room left, otherwise nothing, so the user
 * picks folders instead of facing a selection they cannot import.
 */
export function initialSelection(bookmarks: ParsedBookmark[], saved: Set<string>, room: number): Set<string> {
  const selectable = bookmarks.filter((b) => !saved.has(b.id)).map((b) => b.id);
  return selectable.length <= room ? new Set(selectable) : new Set();
}

export interface FolderSelectionStats {
  selectable: number;
  selected: number;
}

export function folderStats(
  folders: BookmarkFolder[],
  selected: Set<string>,
  saved: Set<string>,
): Map<string, FolderSelectionStats> {
  const stats = new Map<string, FolderSelectionStats>();
  for (const folder of folders) {
    let selectable = 0;
    let picked = 0;
    for (const bookmark of folder.bookmarks) {
      if (saved.has(bookmark.id)) continue;
      selectable += 1;
      if (selected.has(bookmark.id)) picked += 1;
    }
    stats.set(folder.key, { selectable, selected: picked });
  }
  return stats;
}

export interface SelectionSummary {
  /** Selected bookmarks that are not already saved. */
  selectedCount: number;
  total: number;
  alreadySaved: number;
  room: number;
  /** How many to deselect before the selection fits; 0 when it fits. */
  overBy: number;
}

export function summarizeSelection(
  total: number,
  selected: Set<string>,
  saved: Set<string>,
  room: number,
): SelectionSummary {
  let selectedCount = 0;
  for (const id of selected) {
    if (!saved.has(id)) selectedCount += 1;
  }
  return {
    selectedCount,
    total,
    alreadySaved: saved.size,
    room,
    overBy: Math.max(0, selectedCount - room),
  };
}

/** Returns a new Set with `ids` added or removed, skipping already-saved ids. */
export function withSelection(
  selected: Set<string>,
  ids: Iterable<string>,
  checked: boolean,
  saved: Set<string>,
): Set<string> {
  const next = new Set(selected);
  for (const id of ids) {
    if (saved.has(id)) continue;
    if (checked) next.add(id);
    else next.delete(id);
  }
  return next;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}
