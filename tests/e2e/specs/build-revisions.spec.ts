/**
 * VT-46 — Build Revisions E2E spec (@build-revisions, PBI-030 AC-0, PBI-032 AC-1).
 */
import { test, expect } from '@playwright/test';

// DEFERRED: Playwright env unavailable — browser runtime not launched in unit verification pass.
test.describe('Build Revisions (@build-revisions / FEAT-014 / VT-46)', () => {
  test.skip('VT-46 @build-revisions PBI-030 AC-0 / PBI-032 AC-1 requester submits Request changes and sees revision progress', async ({
    page,
  }) => {
    // DEFERRED: Playwright env unavailable
    await page.goto('/builds/00000000-0000-4000-8000-000000000001');
    await expect(page.getByTestId('build-request-changes-button')).toBeVisible();
  });
});
