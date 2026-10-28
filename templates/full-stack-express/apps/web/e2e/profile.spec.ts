import { expect, test } from '@playwright/test';

// DEFERRED: Playwright env unavailable. FEAT-011 (TBI-025) owns the browser
// harness, and this session has no running web/API stack. Each journey below
// is skipped. Vitest covers the same acceptance criteria.

test.skip('VT-13 PBI-021 AC-0 keyboard journey saves and focuses the heading', async ({
  page,
}) => {
  // DEFERRED: Playwright env unavailable
  await page.goto('/profile');
  await page.getByTestId('profile-edit-button').focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('profile-display-name-input').fill('Keyboard Name');
  await page.getByTestId('profile-save-button').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('profile-heading')).toBeFocused();
  await expect(page.getByTestId('profile-display-name')).toHaveText(
    'Keyboard Name'
  );
});

test.skip('VT-16 PBI-021 AC-2 focus leaves loading, sign-in, and empty email', async ({
  page,
}) => {
  // DEFERRED: Playwright env unavailable
  await page.route('**/api/v1/me', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      json: { displayName: 'Sam', email: null, status: 'active' },
    });
  });
  await page.goto('/profile');
  await page.getByTestId('profile-loading').waitFor();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('app-shell-skip-link')).toBeVisible();
});

test.skip('VT-17 PBI-021 AC-3 axe reports no violations for every state in both themes', async ({
  page,
}) => {
  // DEFERRED: Playwright env unavailable — run axe here once TBI-025 lands.
  await page.goto('/profile');
  await expect(page.getByTestId('profile-heading')).toBeVisible();
});

test.skip('VT-18 PBI-021 AC-3 the axe helper fails a bad control', async () => {
  // DEFERRED: Playwright env unavailable.
  // Lower-tier substitute: profileA11y.test.tsx "PBI-021 AC-3 the check fails".
});

test.skip('VT-19 PBI-019 AC-0 phone width does not scroll sideways', async ({
  page,
}) => {
  // DEFERRED: Playwright env unavailable
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/profile');
  const scrollWidth = await page.evaluate(
    () => document.documentElement.scrollWidth
  );
  const clientWidth = await page.evaluate(
    () => document.documentElement.clientWidth
  );
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  await expect(page.getByTestId('profile-edit-button')).toBeVisible();
});

test.skip('VT-22 PBI-019 AC-0 and PBI-020 AC-0 the real API creates and reloads the profile', async ({
  page,
}) => {
  // DEFERRED: Playwright env unavailable — needs PostgreSQL and the development adapter.
  await page.goto('/profile');
  await page.getByTestId('profile-edit-button').click();
  await page.getByTestId('profile-display-name-input').fill('Saved Name');
  await page.getByTestId('profile-save-button').click();
  await expect(page.getByTestId('profile-display-name')).toHaveText(
    'Saved Name'
  );
  await page.reload();
  await expect(page.getByTestId('profile-display-name')).toHaveText(
    'Saved Name'
  );
});
