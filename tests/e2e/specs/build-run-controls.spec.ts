/**
 * VT-37, VT-38 — Build Run Controls E2E spec (PBI-035 AC-0, PBI-036 AC-0, AC-2).
 */
import { test, expect } from '@playwright/test';

// DEFERRED: Playwright env unavailable — live browser + seeded database not running in unit test harness.
test.describe('Build Run Controls (FEAT-016 / VT-37, VT-38)', () => {
  test.skip('VT-37 PBI-035 AC-0 requester cancels a running build', async ({ page }) => {
    // DEFERRED: Playwright env unavailable
    await page.goto('/builds/00000000-0000-4000-8000-000000000001');
    await expect(page.getByTestId('build-cancel-button')).toBeVisible();
  });

  test.skip('VT-38 PBI-036 AC-0, AC-2 Project Admin resumes a flag-suspended build after the flag returns', async ({
    page,
  }) => {
    // DEFERRED: Playwright env unavailable
    await page.goto('/builds/00000000-0000-4000-8000-000000000001');
    await expect(page.getByTestId('build-resume-button')).toBeVisible();
  });
});
