/**
 * FEAT-005 / PBI-006 — Allowlist admin UI keyboard accessibility
 * TC-PBI-006-007 (recommendedTier: e2e-playwright)
 *
 * // DEFERRED: Playwright env unavailable in this local Feature Executor run —
 * // spec is authored and syntactically valid; execution deferred.
 */
import { test, expect } from '../support/fixtures';

test.describe('Load test allowlist admin @load-test-allowlist', () => {
  test.skip('TC-PBI-006-007: keyboard tab through labeled fields and submit staging entry', async ({
    page,
    loginAsPersona,
  }) => {
    // DEFERRED: Playwright env unavailable
    await loginAsPersona('admin');
    await page.goto('/admin/load-test-targets', { waitUntil: 'domcontentloaded' });

    const root = page.getByTestId('load-test-allowlist-page');
    await expect(root).toBeVisible();

    const baseUrl = page.getByTestId('load-test-allowlist-base-url');
    const environment = page.getByTestId('load-test-allowlist-environment');
    const reachable = page.getByTestId('load-test-allowlist-reachable');
    const submit = page.getByTestId('load-test-allowlist-submit');

    await expect(page.getByLabelText(/base url/i)).toBeVisible();
    await expect(page.getByLabelText(/^environment$/i)).toBeVisible();

    await baseUrl.focus();
    await expect(baseUrl).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(environment).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(reachable).toBeFocused();

    await baseUrl.fill('https://api.staging.example.internal');
    await environment.fill('staging');
    await submit.focus();
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('load-test-allowlist-table')).toBeVisible();
    await expect(page.getByText('https://api.staging.example.internal')).toBeVisible();
  });
});
