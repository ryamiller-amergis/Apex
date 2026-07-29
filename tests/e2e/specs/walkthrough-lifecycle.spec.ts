/**
 * FEAT-003 PBI-002 — Platform Admin Walkthrough lifecycle journey.
 *
 * // DEFERRED: Playwright env unavailable for Super Admin platform-admin journeys in this local run.
 */
import { test, expect } from '../support/fixtures';

test.describe('Platform Admin Walkthrough lifecycle @walkthroughs', () => {
  test.skip('AC-0/AC-2/AC-3 — publish, silent update, reshow, unpublish, archive', async ({
    page,
  }) => {
    // DEFERRED: Playwright env unavailable
    await page.goto('/platform-admin');
    await page.getByRole('tab', { name: /walkthroughs/i }).click();
    await page.getByTestId('walkthrough-create').click();

    await page.getByLabel(/internal name/i).fill('feat-003-lifecycle');
    await page.getByLabel(/user title/i).fill('Lifecycle Walkthrough');
    await page.getByLabel(/why it matters/i).fill('Teaches lifecycle controls');
    await page.getByTestId('walkthrough-project-target').selectOption({ label: /./ });
    await page.getByLabel(/^heading$/i).first().fill('Intro');
    await page.getByLabel(/markdown body/i).first().fill('Body');
    await page.getByTestId('walkthrough-save-draft').click();

    await page.getByTestId('walkthrough-publish').click();
    await expect(page.getByTestId('walkthrough-lifecycle-dialog')).toBeVisible();
    await page.getByTestId('walkthrough-lifecycle-confirm-publish').click();

    await page.getByTestId('walkthrough-publish').click();
    await page.getByTestId('walkthrough-update-mode-silent').click();
    await page.getByTestId('walkthrough-lifecycle-confirm-publish').click();

    await page.getByTestId('walkthrough-publish').click();
    await page.getByTestId('walkthrough-update-mode-reshow').click();
    await page.getByTestId('walkthrough-lifecycle-confirm-publish').click();

    await page.getByTestId('walkthrough-publish').click();
    await page.getByTestId('walkthrough-unpublish').click();

    await page.getByTestId('walkthrough-publish').click();
    await page.getByTestId('walkthrough-archive').click();
    await expect(page.getByText(/archived/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /delete/i })).toHaveCount(0);
  });

  test.skip('AC-1 — publish without project fails with validation', async ({ page }) => {
    // DEFERRED: Playwright env unavailable
    await page.goto('/platform-admin');
    await page.getByRole('tab', { name: /walkthroughs/i }).click();
    await page.getByTestId('walkthrough-create').click();
    await page.getByLabel(/internal name/i).fill('no-project');
    await page.getByTestId('walkthrough-save-draft').click();
    await page.getByTestId('walkthrough-publish').click();
    await page.getByTestId('walkthrough-lifecycle-confirm-publish').click();
    await expect(page.getByTestId('walkthrough-lifecycle-error')).toBeVisible();
  });
});
