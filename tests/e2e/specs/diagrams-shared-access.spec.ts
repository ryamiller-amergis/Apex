/**
 * FEAT-006 — Shared Access and Share Notifications (PBI-008, PBI-009).
 *
 * DEFERRED: Playwright env unavailable in local Feature Executor runs.
 * Lower-tier substitutes:
 * - src/client/components/__tests__/DiagramEditorView.test.tsx (PBI-008 AC-0..AC-2)
 * - src/server/__tests__/diagramService.test.ts (VT-01..VT-08)
 * - src/server/__tests__/diagramRoutes.test.ts (VT-02)
 */
import { test, expect } from '../support/fixtures';

test.describe('Diagram shared access and notifications @feat-006', () => {
  // DEFERRED: Playwright env unavailable
  test.skip('VT-09 / PBI-008 AC-0: shared view-only opens with readonly marker, disabled save, export available', async ({
    page,
  }) => {
    await page.goto('/diagrams');
    await expect(page.getByTestId('diagrams-browse-view')).toBeVisible();
    await page.getByTestId('diagrams-tab-shared').click();

    const sharedCard = page.locator('[data-testid^="diagram-card-"]').first();
    await expect(sharedCard.getByTestId('diagram-shared-badge')).toBeVisible();
    await sharedCard.click();

    await expect(page.getByTestId('diagram-editor-readonly')).toBeVisible();
    await expect(page.getByTestId('diagram-view-only-label')).toBeVisible();
    await expect(page.getByTestId('diagram-save-button')).toBeDisabled();
    await expect(page.getByTestId('diagram-export-png')).toBeEnabled();
  });

  // DEFERRED: Playwright env unavailable
  test.skip('VT-10 / PBI-009 AC-0: new-share notification deep-links to /diagrams/{id}', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('notification-bell').click();
    const shareItem = page.getByTestId('notification-diagram-share').first();
    await expect(shareItem).toBeVisible();
    await shareItem.click();
    await expect(page).toHaveURL(/\/diagrams\/[^/]+$/);
    // Live access check runs on open — either editor or access-denied.
    await expect(
      page.getByTestId('diagram-editor').or(page.getByTestId('diagram-editor-readonly'))
        .or(page.getByTestId('diagram-access-denied')),
    ).toBeVisible();
  });
});
