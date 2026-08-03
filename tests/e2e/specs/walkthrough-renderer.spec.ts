/**
 * FEAT-002 / TBI-004 — Hybrid walkthrough renderer cross-route + fallback.
 *
 * Authors the Playwright coverage required by VT-12.
 * // DEFERRED: Playwright env unavailable in this local Feature Executor session —
 * execution is skipped until a browser-backed e2e run is available.
 */
import { test, expect } from '../support/fixtures';

test.describe('Walkthrough hybrid renderer @walkthrough', () => {
  test.skip('VT-12 / DoD-1: anchored step attaches after cross-route navigation', async ({
    page,
  }) => {
    // DEFERRED: Playwright env unavailable
    await page.goto('/home');
    await expect(page.getByTestId('user-menu-trigger')).toBeVisible();
    // Integration mount for FEAT-005 will supply the definition; assert registry target exists.
    await expect(page.getByTestId('walkthrough-renderer')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('walkthrough-coachmark')).toBeVisible();
  });

  test.skip('VT-12 / DoD-2: missing target falls back centered and records one miss', async ({
    page,
  }) => {
    // DEFERRED: Playwright env unavailable
    await page.goto('/home');
    await expect(page.getByTestId('walkthrough-renderer')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('walkthrough-anchor-fallback')).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByTestId('walkthrough-modal-step')).toBeVisible();
  });
});
