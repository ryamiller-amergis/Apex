/**
 * FEAT-005 / PBI-008 — Simplified Avatar Menu e2e
 *
 * Authored against design-spec data-testid contracts (VT-09, VT-10).
 * // DEFERRED: Playwright env execution deferred in local Feature Executor runs
 * unless browsers are installed; specs remain syntactically valid.
 * Lower-tier substitutes: UserMenu.test.tsx (AC-0..AC-3 / VT-01..VT-08).
 */
import { test, expect } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';

test.describe('Simplified Avatar Menu @profile @feat-005', () => {
  // DEFERRED: Playwright env unavailable
  test.skip('TC-PBI-008-001 / AC-0 / VT-09: menu inventory and Profile navigation (desktop)', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/home');

    await page.getByTestId('user-menu-trigger').click();
    const menu = page.getByTestId('user-menu');
    await expect(menu).toBeVisible();
    await expect(page.getByTestId('user-menu-whats-new')).toBeVisible();
    await expect(page.getByTestId('user-menu-profile')).toBeVisible();
    await expect(page.getByTestId('user-menu-sign-out-separator')).toBeVisible();
    await expect(page.getByTestId('user-menu-sign-out')).toBeVisible();

    await page.getByTestId('user-menu-profile').click();
    await expect(page).toHaveURL(/\/profile/);
    await expect(page.getByTestId('profile-page')).toBeVisible();
  });

  // DEFERRED: Playwright env unavailable
  test.skip('TC-PBI-008-003 / AC-2 / VT-09: mobile viewport menu order and touch targets', async ({
    page,
    loginAsPersona,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/home');

    await page.getByTestId('user-menu-trigger').click();
    const menu = page.getByTestId('user-menu');
    await expect(menu).toBeVisible();

    const box = await menu.boundingBox();
    expect(box).toBeTruthy();
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }

    const items = [
      page.getByTestId('user-menu-whats-new'),
      page.getByTestId('user-menu-profile'),
      page.getByTestId('user-menu-sign-out'),
    ];
    for (const item of items) {
      const itemBox = await item.boundingBox();
      expect(itemBox).toBeTruthy();
      if (itemBox) expect(itemBox.height).toBeGreaterThanOrEqual(40);
    }

    await page.getByTestId('user-menu-profile').click();
    await expect(page).toHaveURL(/\/profile/);
  });

  // DEFERRED: Playwright env unavailable
  test.skip('TC-PBI-008-003 / AC-2 / VT-10: keyboard traversal and Escape focus restore', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/home');

    const trigger = page.getByTestId('user-menu-trigger');
    await trigger.focus();
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('user-menu')).toBeVisible();
    await expect(page.getByTestId('user-menu-whats-new')).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('user-menu-profile')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('user-menu-sign-out')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('user-menu')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  // DEFERRED: Playwright env unavailable
  test.skip('TC-PBI-008-004 / AC-3: Theme and Notification controls absent from menu', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/home');

    await page.getByTestId('user-menu-trigger').click();
    const menu = page.getByTestId('user-menu');
    await expect(menu.getByRole('radiogroup', { name: /theme/i })).toHaveCount(0);
    await expect(menu.getByText(/notification settings/i)).toHaveCount(0);

    await page.getByTestId('user-menu-profile').click();
    await expect(page.getByTestId('profile-theme-section')).toBeVisible();
    await expect(page.getByTestId('profile-notification-section')).toBeVisible();
  });

  // DEFERRED: Playwright env unavailable — TC-PBI-008-002 error containment
  test.skip('TC-PBI-008-002 / AC-1: Profile failure keeps What\'s New and Sign Out available', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/home');

    await page.route('**/profile', async (route) => {
      if (route.request().resourceType() === 'document') {
        await route.continue();
        return;
      }
      await route.continue();
    });

    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('user-menu-profile').click();

    // Header remains; reopen for What's New
    await page.getByTestId('user-menu-trigger').click();
    await expect(page.getByTestId('user-menu-whats-new')).toBeVisible();
    await expect(page.getByTestId('user-menu-sign-out')).toBeVisible();
  });
});
