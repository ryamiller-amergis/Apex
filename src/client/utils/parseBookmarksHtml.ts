import {
  QUICK_LINK_CATEGORY_MAX_LENGTH,
  QUICK_LINK_LABEL_MAX_LENGTH,
  QUICK_LINK_URL_MAX_LENGTH,
} from '../../shared/types/projectQuickLinks';

export interface ParsedBookmark {
  /** Stable within one parse; used for selection state. */
  id: string;
  label: string;
  url: string;
  /** Folder names from the outermost folder to the one holding the bookmark. */
  folderPath: string[];
}

export interface ParsedBookmarks {
  bookmarks: ParsedBookmark[];
  /** Links skipped because they are not http(s), are malformed, or are too long. */
  skipped: number;
}

function toHttpUrl(href: string): string | null {
  if (!href || href.length > QUICK_LINK_URL_MAX_LENGTH) return null;
  try {
    const parsed = new URL(href);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/**
 * In the Netscape bookmark format a folder is `<DT><H3>Name</H3><DL>…</DL>`, so each `DL`
 * that encloses a link names its folder through the `H3` just before it.
 */
function folderPathFor(anchor: Element): string[] {
  const path: string[] = [];
  for (let node = anchor.parentElement; node; node = node.parentElement) {
    if (node.tagName !== 'DL') continue;
    const heading = node.previousElementSibling;
    if (heading?.tagName === 'H3') {
      const name = (heading.textContent ?? '').trim();
      if (name) path.unshift(name);
    }
  }
  return path;
}

/** Parses a Chrome, Edge, or Firefox bookmark export. Titles are read as plain text, never as HTML. */
export function parseBookmarksHtml(html: string): ParsedBookmarks {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const bookmarks: ParsedBookmark[] = [];
  let skipped = 0;

  doc.querySelectorAll('a').forEach((anchor) => {
    const url = toHttpUrl((anchor.getAttribute('href') ?? '').trim());
    if (!url) {
      skipped += 1;
      return;
    }
    const title = (anchor.textContent ?? '').replace(/\s+/g, ' ').trim();
    bookmarks.push({
      id: `bm-${bookmarks.length}`,
      label: clip(title || url, QUICK_LINK_LABEL_MAX_LENGTH),
      url,
      folderPath: folderPathFor(anchor),
    });
  });

  return { bookmarks, skipped };
}

/** The category an imported bookmark gets by default: its own folder's name. */
export function defaultCategoryFor(folderPath: string[]): string {
  const folder = folderPath[folderPath.length - 1] ?? '';
  return clip(folder, QUICK_LINK_CATEGORY_MAX_LENGTH);
}
