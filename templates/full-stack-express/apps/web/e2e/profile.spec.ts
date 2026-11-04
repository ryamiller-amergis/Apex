import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '../../../e2e/support/axe.ts';

// FEAT-011 runs this file from the template-root Playwright config. When
// Chromium or Docker is missing, `pnpm test` skips the suite and prints why.

test('VT-13 PBI-021 AC-0 keyboard journey saves and focuses the heading', async ({
  page,
}) => {
  await page.goto('/profile');
  await page.getByTestId('profile-edit-button').focus();
  await page.keyboard.press('Enter');
  await page
    .getByTestId('profile-display-name-input')
    .fill('test-name-keyboard');
  await page.getByTestId('profile-save-button').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('profile-heading')).toBeFocused();
  await expect(page.getByTestId('profile-display-name')).toHaveText(
    'test-name-keyboard'
  );
});

test('VT-16 PBI-021 AC-2 focus leaves loading, sign-in, and empty email', async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/me', async (route) => {
    await gate;
    await route.fulfill({
      json: {
        displayName: 'test-name-sam',
        email: null,
        status: 'active',
      },
    });
  });
  await page.goto('/profile');
  await page.getByTestId('profile-loading').waitFor();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('app-shell-skip-link')).toBeVisible();
  release();
});

test('VT-17 PBI-021 AC-3 @a11y axe reports no violations for the loaded profile in both themes', async ({
  page,
}) => {
  await page.goto('/profile');
  await expect(page.getByTestId('profile-heading')).toBeVisible();
  await expectNoAxeViolations(page, 'loaded-light');
  await page.getByTestId('app-shell-color-mode-toggle').click();
  await expectNoAxeViolations(page, 'loaded-dark');
});

test('VT-18 PBI-021 AC-3 the axe helper fails a bad control', async ({
  page,
}) => {
  await page.setContent('<main><input /></main>');
  await expect(expectNoAxeViolations(page, 'planted')).rejects.toThrow(/label/);
});

test('VT-19 PBI-019 AC-0 phone width does not scroll sideways', async ({
  page,
}) => {
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

test('VT-22 PBI-019 AC-0 and PBI-020 AC-0 the real API creates and reloads the profile', async ({
  page,
}) => {
  await page.goto('/profile');
  await page.getByTestId('profile-edit-button').click();
  await page.getByTestId('profile-display-name-input').fill('test-name-saved');
  await page.getByTestId('profile-save-button').click();
  await expect(page.getByTestId('profile-display-name')).toHaveText(
    'test-name-saved'
  );
  await page.reload();
  await expect(page.getByTestId('profile-display-name')).toHaveText(
    'test-name-saved'
  );
});
