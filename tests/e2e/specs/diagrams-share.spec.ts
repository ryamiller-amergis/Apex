/**
 * FEAT-005 — Owner-Managed Diagram Sharing (PBI-007).
 *
 * DEFERRED: Playwright env unavailable in local Feature Executor runs.
 * Lower-tier substitutes:
 * - src/client/components/__tests__/ShareDiagramDialog.test.tsx (AC-0..AC-2, VT-11)
 * - src/client/hooks/__tests__/useDiagramShares.test.ts
 * - src/server/__tests__/diagramService.test.ts / diagramRoutes.test.ts (VT-01..VT-09)
 */
import { test, expect } from '../support/fixtures';

test.describe('Diagram share management @feat-005', () => {
  // DEFERRED: Playwright env unavailable
  test.skip('VT-10 / PBI-007 AC-0, AC-2: add view, change to edit, revoke via keyboard', async ({
    page,
  }) => {
    await page.goto('/diagrams');
    await expect(page.getByTestId('diagrams-browse-view')).toBeVisible();
    await page.getByTestId('diagram-share-button').first().click();

    const dialog = page.getByTestId('share-diagram-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'dialog');

    await page.getByTestId('share-target-search').fill('Teammate');
    await page.keyboard.press('Tab');
    // Prefer first eligible target control when seeded.
    const target = page.locator('[data-testid^="share-target-"]').first();
    await expect(target).toBeVisible();
    await target.focus();
    await page.keyboard.press('Enter');

    await page.getByTestId('share-access-view').click();
    await page.getByTestId('share-add-button').click();
    await expect(page.getByTestId('share-grant-row').first()).toBeVisible();

    await page.getByTestId('share-access-edit').first().click();
    await expect(page.getByTestId('share-grant-row').first()).toContainText(/Can edit|edit/i);

    await page.getByTestId('share-revoke-button').first().click();
  });

  // DEFERRED: Playwright env unavailable
  test.skip('VT-11 / PBI-007 AC-1: mutation failure keeps prior grant list and announces error', async ({
    page,
  }) => {
    await page.route('**/api/projects/*/diagrams/*/shares', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Simulated failure', code: 'SERVER_ERROR' }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto('/diagrams');
    await page.getByTestId('diagram-share-button').first().click();
    const dialog = page.getByTestId('share-diagram-dialog');
    await expect(dialog).toBeVisible();

    const priorRows = await page.getByTestId('share-grant-row').count();
    const target = page.locator('[data-testid^="share-target-"]').first();
    if (await target.count()) {
      await target.click();
      await page.getByTestId('share-add-button').click();
      await expect(page.getByTestId('share-error')).toBeVisible();
      await expect(page.getByTestId('share-grant-row')).toHaveCount(priorRows);
    }
  });
});
