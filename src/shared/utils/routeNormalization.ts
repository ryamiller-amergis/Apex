/**
 * Normalise a user-supplied URL or path to a bare route for page screenshot lookup.
 *
 * Accepts any of:
 *   "https://dev.mymaxview.com/Timecard/Entry"  → "/timecard/entry"
 *   "dev.mymaxview.com/Timecard/Entry"          → "/timecard/entry"
 *   "/Timecard/Entry"                           → "/timecard/entry"
 *   "Timecard/Entry"                            → "/timecard/entry"
 */
export function normaliseUrlToRoute(input: string): string {
  let path = input.trim();
  if (!path) return '/';

  // Only try URL parsing when it looks like a full URL (has protocol) or a
  // domain (contains a dot before the first slash/end, e.g. "dev.mymaxview.com/foo").
  const looksLikeUrl = path.includes('://') || /^[^/]+\.[^/]+/.test(path);
  if (looksLikeUrl) {
    try {
      const url = new URL(path.includes('://') ? path : `https://${path}`);
      path = url.pathname;
    } catch {
      // Not a valid URL — fall through and treat as a bare path
    }
  }

  path = path.split(/[?#]/)[0];
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path && !path.startsWith('/')) path = `/${path}`;

  return path.toLowerCase();
}
