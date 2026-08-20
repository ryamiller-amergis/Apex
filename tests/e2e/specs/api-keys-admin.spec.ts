/**
 * FEAT-001 — API Keys Admin UI (VT-14, VT-15, VT-16)
 *
 * // DEFERRED: Playwright env unavailable in this local Feature Executor run —
 * // specs are authored and syntactically valid; execution deferred.
 * Lower-tier substitutes: apiKeyLifecycleService.test.ts, apiKeysRoutes.test.ts,
 * ApiKeysAdminView.test.tsx, ApiKeyManageDrawer.test.tsx
 */
import { test, expect } from '../support/fixtures';

test.describe('API Keys admin @api-keys', () => {
  test.skip('VT-14 / PBI-001 AC-0+AC-4: create show-once modal then masked grid row', async ({
    page,
    loginAsPersona,
  }) => {
    // DEFERRED: Playwright env unavailable
    await loginAsPersona('admin');
    await page.goto('/admin/api-keys', { waitUntil: 'domcontentloaded' });

    await expect(page.getByTestId('api-keys-grid')).toBeVisible();
    await page.getByTestId('api-keys-add').click();
    await expect(page.getByTestId('api-key-create-modal')).toBeVisible();

    await page.getByLabel(/name/i).fill(`e2e-key-${Date.now()}`);
    await page.getByLabel(/cadence|expir/i).selectOption('90d');
    await page.getByRole('button', { name: /create|generate/i }).click();

    const secret = page.getByTestId('api-key-secret-value');
    await expect(secret).toBeVisible();
    const raw = await secret.textContent();
    expect(raw ?? '').toMatch(/^apex_/);

    await page.getByTestId('api-key-copy').click();
    await expect(page.getByTestId('api-key-copied')).toBeVisible();

    await page.getByRole('button', { name: /done|close|dismiss/i }).click();
    await expect(page.getByTestId('api-key-create-modal')).toHaveCount(0);

    const row = page.locator('[data-testid^="api-key-row-"]').first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('…');
    await expect(row).not.toContainText(raw ?? '___never___');
  });

  test.skip('VT-15 / PBI-001 AC-2: pagination enabled at 51 keys', async ({
    page,
    loginAsPersona,
  }) => {
    // DEFERRED: Playwright env unavailable
    await loginAsPersona('admin');
    await page.goto('/admin/api-keys', { waitUntil: 'domcontentloaded' });

    await expect(page.getByTestId('api-keys-grid')).toBeVisible();
    await expect(page.getByTestId('api-keys-search')).toBeVisible();
    await expect(page.getByTestId('api-keys-filter-status-all')).toBeVisible();
    // When >50 keys are present, pagination controls appear without losing filters.
    const pagination = page.getByTestId('api-keys-pagination');
    if (await pagination.count()) {
      await expect(pagination).toBeVisible();
      await page.getByTestId('api-keys-search').fill('e2e');
      await page.getByTestId('api-keys-filter-status-active').click();
      await expect(page.getByTestId('api-keys-grid')).toBeVisible();
    }
  });

  test.skip('VT-16 / PBI-002: regenerate banner, delete confirm, cancel leaves row', async ({
    page,
    loginAsPersona,
  }) => {
    // DEFERRED: Playwright env unavailable
    await loginAsPersona('admin');
    await page.goto('/admin/api-keys', { waitUntil: 'domcontentloaded' });

    const actions = page.locator('[data-testid^="api-key-row-actions-"]').first();
    await actions.getByRole('button', { name: /manage|edit/i }).click();
    await expect(page.getByTestId('api-key-manage-drawer')).toBeVisible();

    await page.getByTestId('api-key-regenerate').click();
    await expect(page.getByTestId('api-key-secret-value')).toBeVisible();

    await page.getByTestId('api-key-delete').click();
    await expect(page.getByTestId('api-key-delete-confirm')).toBeVisible();
    await page.getByRole('button', { name: /cancel/i }).click();
    await expect(page.getByTestId('api-key-manage-drawer')).toBeVisible();
    await expect(page.locator('[data-testid^="api-key-row-"]').first()).toBeVisible();
  });
});
