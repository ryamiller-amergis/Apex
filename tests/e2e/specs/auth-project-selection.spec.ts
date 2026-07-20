/**
 * @smoke @critical
 * AC: auth-project-selection
 *
 * Covers authentication entry and project selection:
 * - Dev-login personas can reach the app.
 * - Unauthenticated users are redirected to login.
 * - Project selector is shown and allows project navigation.
 */
import { test, expect } from '../support/fixtures';
import { stubAdoProjects, suppressBetaAnnouncement } from '../support/api-stubs';
import { ProjectSelectorPage } from '../pages/project-selector.page';
import { SidebarPage } from '../pages/sidebar.page';

test.describe('Authentication and project selection @smoke @critical', () => {
  // This block verifies the UNAUTHENTICATED boundary. In deployed-target mode the
  // `deployed-smoke` project applies the programmatic-SSO storageState (dev/staging),
  // which would leave the context already logged in. `storageState: undefined` is
  // meant to reset that, but Playwright does NOT reliably let a nested `test.use`
  // override a project-level storageState with `undefined` — so on dev/staging the
  // inherited `connect.sid` session cookie survives and the app renders already
  // authenticated (the captured run proved this: the very first /home request carried
  // connect.sid and /auth/status returned {"authenticated":true}). We therefore ALSO
  // clear cookies at the start of the test to guarantee a truly logged-out session in
  // every environment before asserting the login boundary.
  test.describe('unauthenticated boundary', () => {
    test.use({ storageState: undefined });

    test('unauthenticated visit shows the login UI @deployed-smoke @prod-safe', async ({ page, context }) => {
      // Force a genuinely cookie-less session regardless of any inherited storageState.
      await context.clearCookies();

      await page.goto('/home');
      // The server serves the SPA for /home regardless of auth (index.ts catch-all),
      // and a logged-out client renders Apex's login card with the Amergis SSO button
      // — the same logged-out surface exercised on prod (which runs unauthenticated).
      await expect(
        page.getByRole('button', { name: /sign in with amergis sso/i })
      ).toBeVisible({ timeout: 10_000 });
    });
  });

  test('BA persona can log in and sees the project selector @deployed-smoke', async ({ page, loginAsPersona }) => {
    await suppressBetaAnnouncement(page);
    await stubAdoProjects(page);
    await loginAsPersona('ba');
    await page.goto('/');

    // After login the user should see the project selector prompt.
    await expect(
      page.getByText(/select a project to start planning/i)
    ).toBeVisible({ timeout: 10_000 });
  });

  test('selecting a project navigates to /home', async ({ page, loginAsPersona }) => {
    await suppressBetaAnnouncement(page);
    await stubAdoProjects(page);
    await loginAsPersona('ba');

    const selector = new ProjectSelectorPage(page);
    await selector.goto();

    // If the app already auto-navigated to /home, accept that; otherwise pick MaxView.
    if (!page.url().includes('/home')) {
      await selector.selectProject('MaxView');
    }

    await expect(page).toHaveURL(/\/home/, { timeout: 10_000 });
  });

  test('developer persona lands on /home after selecting a project', async ({ page, loginAsPersona }) => {
    await suppressBetaAnnouncement(page);
    await stubAdoProjects(page);
    await loginAsPersona('developer');

    const selector = new ProjectSelectorPage(page);
    await selector.goto();

    if (!page.url().includes('/home')) {
      await selector.selectProject('MaxView');
    }

    await page.waitForURL('**/home', { timeout: 15_000 });
    const sidebar = new SidebarPage(page);
    await sidebar.waitForReady();

    // Home button is present in the sidebar.
    await expect(sidebar.isHomeVisible()).resolves.toBe(true);
  });

  test('app shell renders with sidebar and header after login @deployed-smoke', async ({ page, loginAsPersona }) => {
    await suppressBetaAnnouncement(page);
    await stubAdoProjects(page);
    await loginAsPersona('ba');
    await page.goto('/home');

    const sidebar = new SidebarPage(page);
    await sidebar.waitForReady();

    // Core nav items are present for a member. Use a generous timeout because module
    // items render only after async menu-visibility + RBAC data loads, which can lag
    // on a freshly-deployed (cold) environment.
    await expect(sidebar.isHomeVisible()).resolves.toBe(true);
    await expect(page.getByTestId('nav-item-calendar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('nav-item-backlog')).toBeVisible({ timeout: 15_000 });
  });
});
