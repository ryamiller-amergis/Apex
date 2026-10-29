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

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decodes the entities browsers write into bookmark exports. The result is plain text, never markup. */
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Inner text of an element: tags dropped first, then entities decoded, so `&lt;b&gt;` stays text. */
function textOf(innerHtml: string): string {
  return decodeEntities(innerHtml.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
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

const TAG_PATTERN = /<(\/?)(dl|h3|a)\b([^>]*)>/gi;
const HREF_PATTERN = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
/** Bookmarks parsed between checks of the time budget. */
const CHECK_EVERY = 200;

/**
 * Scans a Netscape bookmark file without building a DOM. A folder is `<H3>Name</H3>` followed by
 * a `<DL>` list, so the scanner keeps a stack of open lists and the folder name each one belongs to.
 * Yields whenever `shouldYield()` says the current slice has run long enough.
 */
function* scanBookmarks(
  html: string,
  shouldYield: () => boolean,
): Generator<number, ParsedBookmarks, void> {
  const bookmarks: ParsedBookmark[] = [];
  const folders: (string | null)[] = [];
  let pendingFolder: string | null = null;
  let skipped = 0;
  let sinceCheck = 0;

  const tags = new RegExp(TAG_PATTERN.source, TAG_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html)) !== null) {
    const [, closing, rawName, attrs] = match;
    const name = rawName.toLowerCase();

    if (name === 'dl') {
      if (closing) folders.pop();
      else {
        folders.push(pendingFolder);
        pendingFolder = null;
      }
      continue;
    }
    if (closing) continue;

    const closeTag = new RegExp(`</${name}\\s*>`, 'gi');
    closeTag.lastIndex = tags.lastIndex;
    const close = closeTag.exec(html);
    const inner = html.slice(tags.lastIndex, close ? close.index : tags.lastIndex);
    if (close) tags.lastIndex = closeTag.lastIndex;

    if (name === 'h3') {
      pendingFolder = textOf(inner) || null;
      continue;
    }

    pendingFolder = null;
    const hrefMatch = HREF_PATTERN.exec(attrs);
    const href = decodeEntities((hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? '').trim());
    const url = toHttpUrl(href);
    if (!url) {
      skipped += 1;
    } else {
      const title = textOf(inner);
      bookmarks.push({
        id: `bm-${bookmarks.length}`,
        label: clip(title || url, QUICK_LINK_LABEL_MAX_LENGTH),
        url,
        folderPath: folders.filter((f): f is string => f !== null),
      });
    }

    sinceCheck += 1;
    if (sinceCheck >= CHECK_EVERY) {
      sinceCheck = 0;
      if (shouldYield()) yield bookmarks.length;
    }
  }

  return { bookmarks, skipped };
}

/** Parses a Chrome, Edge, or Firefox bookmark export in one go. Titles come back as plain text. */
export function parseBookmarksHtml(html: string): ParsedBookmarks {
  const steps = scanBookmarks(html, () => false);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export interface ParseBookmarksOptions {
  /** Called between slices with the number of bookmarks found so far. */
  onProgress?: (found: number) => void;
  /** Stops parsing (the promise rejects) once this returns true, e.g. after the modal closes. */
  isCancelled?: () => boolean;
  /** Longest stretch, in ms, to parse before letting the browser paint and handle input. */
  sliceMs?: number;
}

export class BookmarkParseCancelled extends Error {
  constructor() {
    super('Bookmark parsing was cancelled');
    this.name = 'BookmarkParseCancelled';
  }
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

/**
 * Same result as `parseBookmarksHtml`, but parses in short slices and yields to the browser between
 * them so a 20 MB export does not freeze the tab. (A Web Worker cannot help here: workers have no
 * DOMParser, and this scanner is cheap enough to time-slice on the main thread.)
 */
export async function parseBookmarksHtmlAsync(
  html: string,
  { onProgress, isCancelled, sliceMs = 12 }: ParseBookmarksOptions = {},
): Promise<ParsedBookmarks> {
  let sliceStart = performance.now();
  const steps = scanBookmarks(html, () => performance.now() - sliceStart >= sliceMs);
  let step = steps.next();
  while (!step.done) {
    onProgress?.(step.value);
    await nextTask();
    if (isCancelled?.()) throw new BookmarkParseCancelled();
    sliceStart = performance.now();
    step = steps.next();
  }
  return step.value;
}

/** The category an imported bookmark gets by default: its own folder's name. */
export function defaultCategoryFor(folderPath: string[]): string {
  const folder = folderPath[folderPath.length - 1] ?? '';
  return clip(folder, QUICK_LINK_CATEGORY_MAX_LENGTH);
}
