import type { Page } from '@playwright/test';

/**
 * Dismiss app-level overlays that auto-open on load and would otherwise
 * intercept clicks / block visibility assertions:
 *  - The "What's New" changelog modal (auto-launches after a new release).
 *  - The changelog banner.
 *
 * Safe to call repeatedly and when no overlay is present.
 */
export async function dismissOverlays(page: Page): Promise<void> {
  // "What's New" modal — full-screen overlay that intercepts pointer events.
  // Prefer the primary "Got it!" CTA; fall back to the × close button.
  const changelogOverlay = page.locator('[class*="changelog-overlay"]');
  if (await changelogOverlay.isVisible().catch(() => false)) {
    const gotIt = page.getByRole('button', { name: /got it/i });
    if (await gotIt.isVisible().catch(() => false)) {
      await gotIt.click().catch(() => {});
    } else {
      await page.locator('[class*="changelog-close-btn"]').click().catch(() => {});
    }
    await changelogOverlay.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  }

  // Changelog banner — has a "Dismiss" button (aria-label).
  const dismissBanner = page.getByRole('button', { name: /^dismiss$/i });
  if (await dismissBanner.isVisible().catch(() => false)) {
    await dismissBanner.click().catch(() => {});
  }
}
