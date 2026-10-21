/**
 * UI Lab share deep-link smoke coverage.
 * Skipped until the e2e harness seeds a shared UI Lab design for a non-UI/UX viewer.
 */
import { test, expect } from '@playwright/test';

test.describe('UI Lab sharing deep link', () => {
  test.fixme('shared viewer can open preview and source but not edit', async ({ page }) => {
    await page.goto('/ui-lab/00000000-0000-0000-0000-000000000001?project=MaxView');
    await expect(page.getByTestId('ui-lab-canvas')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('ui-lab-view-source')).toBeVisible();
    await expect(page.getByTestId('ui-lab-edit-boundary')).toHaveCount(0);
    await page.getByTestId('ui-lab-view-source').click();
    await expect(page.getByTestId('ui-lab-source-view')).toBeVisible();
  });
});
