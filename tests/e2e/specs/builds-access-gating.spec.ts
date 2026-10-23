/**
 * FEAT-002 / PBI-003 (and PBI-002 entry point) — Builds menu, route guard and New build action.
 *
 * The dev personas hold the `member` role, which the builds permission migration grants
 * `builds:view` and `builds:run`. The flag is forced on in the browser (as other specs do)
 * and the viewer case drops `builds:run` from the client permission response.
 * Server-side refusals are covered by buildAccessMiddleware.test.ts and platformAdminRoutes.test.ts.
 */
import type { Page } from '@playwright/test';
import { expect, test, E2E_PROJECT, SeedApi } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';
import { DEFAULT_ENABLED_MENU_VIEWS } from '../../../src/shared/types/menuSettings';

const OTHER_PROJECT = 'MatterWorx';

async function selectProject(page: Page, project: string): Promise<void> {
  await page.addInitScript((p) => {
    window.localStorage.setItem('selectedProject', p);
    window.localStorage.setItem('selectedAreaPath', p);
  }, project);
}

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

async function dropRunPermission(page: Page): Promise<void> {
  await page.route('**/api/me/permissions*', async (route) => {
    const response = await route.fetch();
    const data = (await response.json()) as { permissions?: string[] };
    await route.fulfill({
      response,
      json: { ...data, permissions: (data.permissions ?? []).filter((key) => key !== 'builds:run') },
    });
  });
}

test.describe('Builds access and gating @feat-002', () => {
  test.beforeEach(async ({ page, request }) => {
    await SeedApi.setMenuSettings(request, E2E_PROJECT, [...DEFAULT_ENABLED_MENU_VIEWS, 'builds']);
    await SeedApi.setMenuSettings(request, OTHER_PROJECT, [...DEFAULT_ENABLED_MENU_VIEWS]);
    await stubAdoProjects(page);
    await forceBuildFlagOn(page);
  });

  test('VT-20 PBI-003 AC-0: a member sees Builds in the menu and the New build button', async ({ page, loginAsPersona }) => {
    await selectProject(page, E2E_PROJECT);
    await loginAsPersona('developer');
    await page.goto('/home');

    await page.getByTestId('nav-item-builds').click();
    await expect(page).toHaveURL(/\/builds$/);
    await expect(page.getByTestId('builds-view')).toBeVisible();
    await expect(page.getByTestId('builds-empty-state')).toHaveText('No builds yet.');

    await page.getByTestId('builds-new-build-btn').click();
    await expect(page).toHaveURL(/\/builds\/new$/);
  });

  test('VT-20 PBI-003 AC-2: a user without builds:run sees the page but not the New build button', async ({ page, loginAsPersona }) => {
    await selectProject(page, E2E_PROJECT);
    await dropRunPermission(page);
    await loginAsPersona('ba');
    await page.goto('/builds');

    await expect(page.getByTestId('builds-view')).toBeVisible();
    await expect(page.getByTestId('builds-new-build-btn')).toHaveCount(0);
  });

  test('VT-20 PBI-003 AC-1: a project without the Builds menu redirects away from /builds', async ({ page, loginAsPersona }) => {
    await selectProject(page, OTHER_PROJECT);
    await loginAsPersona('developer');
    await page.goto('/builds');

    await expect(page).not.toHaveURL(/\/builds/);
    await expect(page.getByTestId('builds-view')).toHaveCount(0);
    await expect(page.getByTestId('nav-item-builds')).toHaveCount(0);
  });
});
