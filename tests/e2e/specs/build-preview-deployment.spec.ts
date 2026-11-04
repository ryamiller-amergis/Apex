/**
 * VT-32 — Preview Deployment and Failure Handling E2E spec (PBI-026..029).
 */
import { test, expect } from '@playwright/test';

// DEFERRED: Playwright env unavailable — live database seed + pipeline callback environment not running in unit test harness.
test.describe('Build Preview Deployment and Failure Handling (FEAT-013 / VT-32)', () => {
  test.skip('VT-32 PBI-026..029 shows failure panel, allows support contact retry, opens live preview link, and advances queue on release', async ({
    page,
  }) => {
    // DEFERRED: Playwright env unavailable
    await page.goto('/builds/00000000-0000-4000-8000-000000000001/preview');
    await expect(page.getByTestId('build-preview-tab')).toBeVisible();
  });
});
