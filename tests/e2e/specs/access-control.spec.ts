/**
 * @smoke @critical
 * AC: access-control
 *
 * Covers RBAC and menu-visibility gating:
 * - Member users cannot reach /admin (requires admin:roles).
 * - Navigation items hidden when menu-settings disable them.
 * - Deep links to restricted routes redirect to /home.
 *
 * Super-admin browser coverage is deferred to Tier 1.
 */
import { test, expect, SeedApi, E2E_PROJECT } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';
import { SidebarPage } from '../pages/sidebar.page';
import { ProjectSelectorPage } from '../pages/project-selector.page';
import { ALL_MENU_VIEWS } from '../../../src/shared/types/menuSettings';

test.describe('Access control @smoke @critical', () => {
  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test('member user navigating to /admin is redirected to /home', async ({ page, loginAsPersona }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/admin/roles');

    // The app redirects users without admin:roles to /home.
    await page.waitForURL(/\/(home|$)/, { timeout: 10_000 });
    await expect(page).not.toHaveURL(/\/admin/);
  });

  test('member user navigating to /platform-admin is redirected', async ({ page, loginAsPersona }) => {
    await stubAdoProjects(page);
    await loginAsPersona('ba');
    await page.goto('/platform-admin');

    // Platform Admin requires super-admin; member is redirected.
    await page.waitForURL(/\/(home|)/, { timeout: 10_000 });
    await expect(page).not.toHaveURL(/\/platform-admin/);
  });

  test('admin nav item is NOT visible for a member (no admin:roles)', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/home');

    const sidebar = new SidebarPage(page);
    await sidebar.waitForReady();

    // Members don't have admin:roles so the Admin nav item must be hidden.
    await expect(sidebar.isAdminVisible()).resolves.toBe(false);
  });

  test('backlog nav item hidden when project menu disables it', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');

    // Deterministically pin the active project. Without an explicit selection
    // the client's active project resolves to the VITE_TEAMS-derived "false"
    // fallback, so menu-config?project=false finds no row and defaults to ALL
    // views — the backlog item then depends on racy per-project permission
    // resolution instead of the seeded menu config (the source of the flake).
    // Selecting a real project makes menu-config?project=<E2E_PROJECT> the query
    // that gates the sidebar, so the seeded menu config deterministically drives
    // visibility.
    const selector = new ProjectSelectorPage(page);
    await selector.goto();
    if (!page.url().includes('/home')) {
      await selector.selectProject(E2E_PROJECT);
    }
    await page.waitForURL('**/home', { timeout: 15_000 });

    try {
      // Disable the backlog menu item for the now-active project, then reload so
      // the client re-fetches the menu config for that project. The developer
      // otherwise has interviews:view for this project, so the menu config is
      // the sole gate hiding the backlog item.
      await SeedApi.setMenuSettings(e2eApi, E2E_PROJECT, ['calendar', 'planning']);
      await page.reload();

      const sidebar = new SidebarPage(page);
      await sidebar.waitForReady();

      // The backlog (interviews) nav item should not be present.
      await expect(page.getByTestId('nav-item-backlog')).not.toBeVisible();
    } finally {
      // Restore full menu visibility even if the assertion fails, so this shared
      // project_menu_settings change cannot leak a restricted config into later
      // tests running against the same test database.
      await SeedApi.setMenuSettings(e2eApi, E2E_PROJECT, [...ALL_MENU_VIEWS]);
    }
  });

  test('calendar nav item visible for member with calendar:view permission', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/home');

    const sidebar = new SidebarPage(page);
    await sidebar.waitForReady();

    // member role includes calendar:view.
    await expect(page.getByTestId('nav-item-calendar')).toBeVisible();
  });

  test('my-work nav item is hidden for a BA persona (not a Developer)', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);

    // BA persona is not in the Developer group and lacks dev-workbench:view →
    // My Work must be hidden.
    await loginAsPersona('ba');
    await page.goto('/home');
    const sidebar = new SidebarPage(page);
    await sidebar.waitForReady();
    await expect(page.getByTestId('nav-item-my-work')).not.toBeVisible();
  });
});
