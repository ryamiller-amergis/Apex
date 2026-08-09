/**
 * FEAT-002 / PBI-001 — Diagrams RBAC + Menu Visibility gating.
 *
 * DEFERRED: Playwright env unavailable in local Feature Executor runs.
 * Lower-tier substitutes:
 * - src/client/components/__tests__/DiagramsNavGating.test.tsx (AC-0, AC-3)
 * - src/server/__tests__/diagramRbacNavigation.test.ts (AC-2, DoD-*)
 * - src/server/__tests__/platformAdminRoutes.test.ts (AC-0, AC-1)
 */
import { test, expect } from '../support/fixtures';

test.describe('Diagrams RBAC and opt-in navigation @feat-002', () => {
  // DEFERRED: Playwright env unavailable
  test.skip('AC-3 / VT-08: menu-enabled project without diagram:view hides nav and denies /diagrams', async ({
    page,
  }) => {
    await page.goto('/diagrams');
    await expect(page.getByTestId('nav-diagrams')).toHaveCount(0);
    await expect(page.getByTestId('diagrams-placeholder')).toHaveCount(0);
  });

  // DEFERRED: Playwright env unavailable
  test.skip('AC-0 / VT-09: menu-enabled + diagram:view shows nav-diagrams and opens placeholder', async ({
    page,
  }) => {
    await page.goto('/home');
    await expect(page.getByTestId('nav-diagrams')).toBeVisible();
    await page.getByTestId('nav-diagrams').click();
    await expect(page.getByTestId('diagrams-placeholder')).toBeVisible();
  });

  // DEFERRED: Playwright env unavailable
  test.skip('VT-10: Menu Visibility Diagrams toggle is keyboard operable', async ({ page }) => {
    await page.goto('/platform-admin');
    const toggle = page.getByTestId('menu-visibility-toggle-diagrams');
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Space');
  });
});
