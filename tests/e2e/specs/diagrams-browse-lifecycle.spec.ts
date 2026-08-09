/**
 * FEAT-004 — Diagram Browse, Export, and Lifecycle (browse + delete).
 *
 * DEFERRED: Playwright env unavailable in local Feature Executor runs.
 * Lower-tier substitutes:
 * - src/client/components/__tests__/DiagramsBrowseView.test.tsx (PBI-004 AC-0..AC-2, PBI-006 UI)
 * - src/client/components/__tests__/DeleteDiagramDialog.test.tsx (VT-13 a11y substitutes)
 * - src/server/__tests__/diagramRoutes.test.ts / diagramService.test.ts (PBI-004 AC-3, PBI-006 API)
 */
import { test, expect } from '../support/fixtures';

test.describe('Diagram browse and delete @feat-004', () => {
  // DEFERRED: Playwright env unavailable
  test.skip('VT-01 / PBI-004 AC-0: owned and shared sections show cards with badges', async ({
    page,
  }) => {
    await page.goto('/diagrams');
    await expect(page.getByTestId('diagrams-browse-view')).toBeVisible();
    await expect(page.getByTestId('diagrams-tab-owned')).toBeVisible();
    await page.getByTestId('diagrams-tab-owned').click();
    await expect(page.getByTestId('diagrams-tab-owned')).toHaveAttribute('aria-selected', 'true');
    // Cards appear when seeded; badge must be labeled when present.
    const ownedBadge = page.getByTestId('diagram-card-access-badge').first();
    if (await ownedBadge.count()) {
      await expect(ownedBadge).toHaveAttribute('aria-label', /Access:/);
    }
    await page.getByTestId('diagrams-tab-shared').click();
    await expect(page.getByTestId('diagrams-tab-shared')).toHaveAttribute('aria-selected', 'true');
  });

  // DEFERRED: Playwright env unavailable
  test.skip('VT-09 / PBI-006 AC-0: owner delete confirmation removes card from browse', async ({
    page,
  }) => {
    await page.goto('/diagrams');
    await expect(page.getByTestId('diagrams-browse-view')).toBeVisible();
    const deleteBtn = page.getByTestId('diagram-delete-button').first();
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();
    const dialog = page.getByTestId('diagram-delete-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'alertdialog');
    await page.getByTestId('diagram-delete-confirm').click();
    await expect(dialog).toHaveCount(0);
  });

  // DEFERRED: Playwright env unavailable
  test.skip('VT-13 / PBI-006 a11y: delete alertdialog traps focus and Escape cancels', async ({
    page,
  }) => {
    await page.goto('/diagrams');
    await page.getByTestId('diagram-delete-button').first().click();
    const dialog = page.getByTestId('diagram-delete-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('diagram-delete-cancel')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });
});
