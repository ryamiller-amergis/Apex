/**
 * FEAT-008 — Platform Admin Walkthrough acknowledgement + missing-anchor reporting.
 *
 * // DEFERRED: Playwright env unavailable for Super Admin platform-admin journeys in this local run.
 */
import { test, expect } from '../support/fixtures';

test.describe('Platform Admin Walkthrough reporting @walkthroughs', () => {
  test.skip('AC-0 — acknowledgement X of Y, drill-down, and missing-anchor association', async ({
    page,
  }) => {
    // DEFERRED: Playwright env unavailable
    await page.goto('/platform-admin');
    await page.getByTestId('platform-admin-tab-walkthrough-reports').click();
    await expect(page.getByTestId('walkthrough-reporting-section')).toBeVisible();

    await page.getByTestId('walkthrough-report-selector').selectOption({ index: 1 });
    await expect(page.getByTestId('acknowledgement-summary')).toBeVisible();
    await expect(page.getByTestId('acknowledgement-detail-table')).toBeVisible();

    await page.getByTestId('walkthrough-report-tab-anchor-misses').click();
    await expect(page.getByTestId('anchor-miss-table')).toBeVisible();
  });

  test.skip('AC-3 — non Super Admin cannot open reporting data', async ({ page }) => {
    // DEFERRED: Playwright env unavailable
    await page.goto('/platform-admin');
    await expect(page.getByTestId('walkthrough-reporting-section')).toHaveCount(0);
  });
});
