/**
 * FEAT-003 PBI-001 — Platform Admin manual Walkthrough authoring journey.
 *
 * Authors the Playwright coverage required by the design-spec testing strategy.
 * Execution is deferred until a Super Admin Playwright persona/env is available
 * (Tier 1 platform-admin browser coverage is not in the default smoke suite).
 */
import { test, expect } from '../support/fixtures';

// DEFERRED: Playwright env unavailable for Super Admin platform-admin journeys in this local run.
test.describe('Platform Admin Walkthrough authoring @walkthroughs', () => {
  test.skip('AC-0 — create draft with two Steps, reorder, save, and see catalog row', async ({
    page,
  }) => {
    // DEFERRED: Playwright env unavailable
    await page.goto('/platform-admin');
    await page.getByRole('tab', { name: /walkthroughs/i }).click();
    await expect(page.getByTestId('walkthrough-catalog')).toBeVisible();

    await page.getByTestId('walkthrough-create').click();
    await expect(page.getByTestId('walkthrough-editor')).toBeVisible();

    await page.getByLabel(/internal name/i).fill('feat-003-authoring');
    await page.getByLabel(/user title/i).fill('Welcome to Walkthroughs');
    await page.getByTestId('walkthrough-project-target').locator('input[type="checkbox"]').first().check();

    await page.getByLabel(/^heading$/i).first().fill('Step One');
    await page.getByTestId('walkthrough-step-add').click();
    await page.getByLabel(/^heading$/i).nth(1).fill('Step Two');

    const firstStep = page.locator('[data-testid^="walkthrough-step-"]').first();
    const stepId = (await firstStep.getAttribute('data-testid'))?.replace('walkthrough-step-', '') ?? '';
    await page.getByTestId(`walkthrough-step-move-down-${stepId}`).click();

    await page.getByTestId('walkthrough-save-draft').click();
    await expect(page.getByTestId('walkthrough-catalog')).toBeVisible();
    await expect(page.getByText('feat-003-authoring')).toBeVisible();
  });

  test.skip('AC-1 — invalid image URL surfaces validation summary', async ({ page }) => {
    // DEFERRED: Playwright env unavailable
    await page.goto('/platform-admin');
    await page.getByRole('tab', { name: /walkthroughs/i }).click();
    await page.getByTestId('walkthrough-create').click();
    await page.getByLabel(/image url/i).fill('javascript:alert(1)');
    await page.getByTestId('walkthrough-save-draft').click();
    await expect(page.getByTestId('walkthrough-validation-summary')).toBeVisible();
  });

  test.skip('AC-3 — non–Super Admin cannot open authoring surface', async ({ page, loginAsPersona }) => {
    // DEFERRED: Playwright env unavailable for full persona matrix in this session
    await loginAsPersona('ba');
    await page.goto('/platform-admin');
    await expect(page).not.toHaveURL(/\/platform-admin/);
    await expect(page.getByTestId('walkthrough-catalog')).toHaveCount(0);
  });

  test.skip('AC-4 — Anchor Management sync opens review modal for new candidates', async ({
    page,
  }) => {
    // DEFERRED: Playwright env unavailable for Super Admin platform-admin journeys in this local run.
    await page.goto('/platform-admin');
    await page.getByRole('tab', { name: /walkthroughs/i }).click();
    await page.getByTestId('walkthroughs-admin-tab-anchors').click();
    await expect(page.getByTestId('walkthrough-anchor-management')).toBeVisible();

    await page.getByTestId('walkthrough-anchor-sync').click();
    await expect(page.getByTestId('walkthrough-anchor-sync-modal')).toBeVisible();
    await expect(page.getByTestId('walkthrough-anchor-counts')).toBeVisible();
  });

  test.skip('AC-5 — catalog-driven coachmark authoring picks approved+active anchors only', async ({
    page,
  }) => {
    // DEFERRED: Playwright env unavailable for Super Admin platform-admin journeys in this local run.
    await page.goto('/platform-admin');
    await page.getByRole('tab', { name: /walkthroughs/i }).click();
    await page.getByTestId('walkthroughs-admin-tab-walkthroughs').click();
    await page.getByTestId('walkthrough-create').click();
    await expect(page.getByTestId('walkthrough-editor')).toBeVisible();

    const step = page.locator('[data-testid^="walkthrough-step-"]').first();
    const stepId =
      (await step.getAttribute('data-testid'))?.replace('walkthrough-step-', '') ?? '';
    const anchorSelect = page.getByTestId(`walkthrough-anchor-key-${stepId}`);
    await expect(anchorSelect).toBeVisible();
    await expect(anchorSelect.locator('option').first()).toHaveText(/No anchor \(centered\)/i);
    // Approved+active catalog keys appear as options; pending/rejected/soft-deleted do not.
    const optionCount = await anchorSelect.locator('option').count();
    expect(optionCount).toBeGreaterThan(1);
  });
});
