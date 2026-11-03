/**
 * FEAT-004 — start a build from the form, and check the builds screens.
 * API calls are stubbed so the spec exercises the page, not preflight or Playbooks.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test, E2E_PROJECT, SeedApi } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';
import { DEFAULT_ENABLED_MENU_VIEWS } from '../../../src/shared/types/menuSettings';

async function forceBuildFlagOn(page: Page): Promise<void> {
  await page.route('**/api/feature-flags/evaluate*', async (route) => {
    const response = await route.fetch();
    const data = (await response.json().catch(() => ({}))) as { flags?: Record<string, boolean> };
    await route.fulfill({
      response,
      json: { ...data, flags: { ...(data.flags ?? {}), 'build-from-prompt': true } },
    });
  });
}

async function stubBuildApis(page: Page): Promise<void> {
  await page.route('**/api/builds?*', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 202,
        json: {
          buildRunId: 'build-e2e',
          playbookRunId: 'run-e2e',
          status: 'intake',
          queuePosition: null,
          queueReason: null,
          replayed: false,
        },
      });
      return;
    }
    await route.fulfill({ json: { builds: [], total: 0, limit: 50, offset: 0 } });
  });
  await page.route('**/api/builds/repositories*', async (route) => {
    await route.fulfill({
      json: { repositories: [{ repository: 'apex', label: 'Apex' }] },
    });
  });
}

async function assertNoSeriousViolations(page: Page, pageName: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter((item) => item.impact === 'critical' || item.impact === 'serious');
  expect(serious, `${pageName}: ${serious.map((item) => item.id).join(', ')}`).toEqual([]);
}

test.describe('Start a build @feat-004', () => {
  test.beforeEach(async ({ page, request }) => {
    await SeedApi.setMenuSettings(request, E2E_PROJECT, [...DEFAULT_ENABLED_MENU_VIEWS, 'builds']);
    await stubAdoProjects(page);
    await forceBuildFlagOn(page);
    await stubBuildApis(page);
    await page.addInitScript((project) => {
      window.localStorage.setItem('selectedProject', project);
      window.localStorage.setItem('selectedAreaPath', project);
    }, E2E_PROJECT);
  });

  test('VT-02 the form warns about secrets and accepts a description', async ({ page, loginAsPersona }) => {
    await loginAsPersona('developer');
    await page.goto('/builds/new');
    await expect(page.getByTestId('new-build-secrets-notice')).toBeVisible();
    await page.getByTestId('new-build-prompt').fill('Add a reports page');
    await page.getByTestId('new-build-submit').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/builds$/);
    await expect(page.getByRole('status')).toHaveText('Your build has started.');
  });

  test('VT-35 @a11y the list and the form have no serious accessibility violations', async ({ page, loginAsPersona }) => {
    await loginAsPersona('developer');
    await page.goto('/builds');
    await expect(page.getByTestId('builds-list-view')).toBeVisible();
    await assertNoSeriousViolations(page, '/builds');
    await page.goto('/builds/new');
    await expect(page.getByTestId('new-build-form')).toBeVisible();
    await assertNoSeriousViolations(page, '/builds/new');
  });
});
