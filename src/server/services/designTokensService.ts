/**
 * Design Tokens Service
 *
 * Loads the canonical MaxView color palette from a bundled asset so the AI
 * design generators reference exact brand colors instead of inventing hex values.
 *
 * Source of truth:
 *   - src/server/assets/maxview-colors.md   (human-readable, fed to the prompt)
 *   - src/server/assets/maxview-colors.json (machine-readable companion)
 *
 * The Markdown file is used for the prompt because its token / value / usage
 * tables give Claude the clearest semantic guidance ("use error.main for errors").
 */

import fs from 'fs';
import path from 'path';

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const COLOR_TOKENS_MD = path.join(ASSETS_DIR, 'maxview-colors.md');

const CACHE_TTL_MS = 5 * 60 * 1000; // re-reads disk if the file was updated

let cachedTokens: string | null = null;
let cacheLoadedAt = 0;

/**
 * Returns the MaxView color-token Markdown for prompt injection.
 * Returns an empty string if the asset is missing (non-fatal).
 */
export function getMaxviewColorTokens(): string {
  const now = Date.now();
  if (cachedTokens !== null && now - cacheLoadedAt < CACHE_TTL_MS) {
    return cachedTokens;
  }

  try {
    if (fs.existsSync(COLOR_TOKENS_MD)) {
      cachedTokens = fs.readFileSync(COLOR_TOKENS_MD, 'utf-8').trim();
      console.log(`[designTokensService] Loaded MaxView color tokens (${cachedTokens.length} chars)`);
    } else {
      cachedTokens = '';
      console.warn(`[designTokensService] No color tokens found at ${COLOR_TOKENS_MD}`);
    }
  } catch (e: any) {
    cachedTokens = '';
    console.warn(`[designTokensService] Failed to read color tokens — ${e.message}`);
  }

  cacheLoadedAt = now;
  return cachedTokens;
}

/** Force a cache refresh on next call (useful after editing the asset or in tests). */
export function invalidateDesignTokensCache(): void {
  cachedTokens = null;
  cacheLoadedAt = 0;
}
