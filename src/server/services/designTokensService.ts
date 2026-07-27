/**
 * Design Tokens Service
 *
 * Loads color-token Markdown assets for prompt injection so AI design
 * generators reference exact brand colors instead of inventing hex values.
 *
 * Source of truth:
 *   - src/server/assets/maxview-colors.md  (MaxView — original)
 *   - src/server/assets/apex-colors.md     (APEX — added in Wave 3)
 *
 * getColorTokens(mdPath) is the generic, project-scoped entry point.
 * getMaxviewColorTokens() is a backward-compatible shim — unchanged behaviour.
 */

import fs from 'fs';
import path from 'path';

const ASSETS_DIR = path.join(__dirname, '..', 'assets');

/** Canonical asset paths */
export const MAXVIEW_COLOR_TOKENS_PATH = path.join(ASSETS_DIR, 'maxview-colors.md');
export const APEX_COLOR_TOKENS_PATH    = path.join(ASSETS_DIR, 'apex-colors.md');

const CACHE_TTL_MS = 5 * 60 * 1000;

// Per-file cache so each project's tokens are cached independently
const fileCache = new Map<string, { text: string; loadedAt: number }>();

/**
 * Load the color-token Markdown at `mdPath` and return it for prompt injection.
 * Results are cached per path with a 5-minute TTL.
 * Returns an empty string (non-fatal) when the file is absent or unreadable.
 */
export function getColorTokens(mdPath: string): string {
  const now = Date.now();
  const cached = fileCache.get(mdPath);
  if (cached && now - cached.loadedAt < CACHE_TTL_MS) return cached.text;

  let text = '';
  try {
    if (fs.existsSync(mdPath)) {
      text = fs.readFileSync(mdPath, 'utf-8').trim();
      console.log(`[designTokensService] Loaded color tokens from ${path.basename(mdPath)} (${text.length} chars)`);
    } else {
      console.warn(`[designTokensService] No color tokens found at ${mdPath}`);
    }
  } catch (e: any) {
    console.warn(`[designTokensService] Failed to read color tokens from ${mdPath} — ${e.message}`);
  }

  fileCache.set(mdPath, { text, loadedAt: now });
  return text;
}

/**
 * Returns the MaxView color-token Markdown.
 * Backward-compatible shim — existing callers are unaffected.
 */
export function getMaxviewColorTokens(): string {
  return getColorTokens(MAXVIEW_COLOR_TOKENS_PATH);
}

/**
 * Returns the APEX color-token Markdown.
 * Used by the APEX-project UI Lab context.
 */
export function getApexColorTokens(): string {
  return getColorTokens(APEX_COLOR_TOKENS_PATH);
}

/** Force a cache refresh on next call (useful in tests). */
export function invalidateDesignTokensCache(mdPath?: string): void {
  if (mdPath) {
    fileCache.delete(mdPath);
  } else {
    fileCache.clear();
  }
}
